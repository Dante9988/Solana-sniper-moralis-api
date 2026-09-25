/**
 * Authenticated jobs/market data use `/api/v1/realtime`; public market-only
 * subscriptions use `/api/v1/realtime/market` (Phase 7D.6.4).
 * The original authenticated endpoint
 * (phase7b2.txt §4). Wired onto the same HTTP server Express listens on
 * (`noServer: true` + a manual `upgrade` handler), the same pattern already
 * used by the legacy trading API's WebSocket support (src/api/index.ts).
 *
 * Auth model: never a Supabase JWT (or anything else long-lived) in the
 * query string. The client first calls the authenticated REST endpoint
 * `POST /api/v1/realtime/tickets` (routes/realtimeTickets.ts) to get a
 * short-lived, single-use ticket, then connects with
 * `?ticket=<ticket>` — consumed exactly once, atomically, right here.
 */

import { IncomingMessage, Server as HttpServer } from "node:http";
import { PrismaClient } from "@prisma/client";
import { WebSocket, WebSocketServer } from "ws";
import { ApiConfig } from "../config";
import { z } from "../contracts/zodOpenApi";
import { userOwnsJob } from "../../services/scanOwnershipService";
import { EventBus } from "./eventBus";
import { createRealtimeEvent } from "./eventEnvelope";
import { candleChannel, jobChannel } from "./eventPublisher";
import { TicketStore } from "./ticketStore";
import { CANDLE_RESOLUTIONS } from "../../candles/resolutions";

export const REALTIME_PATH = "/api/v1/realtime";
export const PUBLIC_MARKET_PATH = "/api/v1/realtime/market";

const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("subscribe"), jobKey: z.string().min(1).max(512) }),
  z.object({ type: z.literal("unsubscribe"), jobKey: z.string().min(1).max(512) }),
  // Candles are public market data. Both transports validate chain, canonical
  // token identity and resolution; private job subscriptions require a ticket
  // and the existing user ownership check.
  z.object({ type: z.literal("subscribeCandles"), chain: z.literal("robinhood"), tokenAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(a => a.toLowerCase()), resolution: z.enum(CANDLE_RESOLUTIONS as [string, ...string[]]) }),
  z.object({ type: z.literal("unsubscribeCandles"), chain: z.literal("robinhood"), tokenAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(a => a.toLowerCase()), resolution: z.enum(CANDLE_RESOLUTIONS as [string, ...string[]]) }),
]);

function isAllowedOrigin(origin: string | undefined, config: ApiConfig): boolean {
  // Mirrors ../middleware/cors.ts's rule but is evaluated completely
  // independently of it — CORS/preflight machinery does not apply to a
  // WebSocket upgrade at all, so this check is the *only* Origin
  // enforcement a browser-originated connection gets (phase7b2.txt §4).
  if (!origin) return true; // no Origin header => not a browser context (native client, server-to-server)
  if (config.cors.allowedOrigins.has(origin)) return true;
  if (!config.cors.isProduction && config.cors.devOrigins.has(origin)) return true;
  return false;
}

interface ConnectionState {
  userId: string;
  publicMarket: boolean;
  closed: boolean;
  candleWatches: Map<string, { chain: string; tokenAddress: string }>;
  socket: WebSocket;
  isAlive: boolean;
  subscriptions: Map<string, () => Promise<void>>; // jobKey -> unsubscribe
}

export interface RealtimeServerDeps {
  db: PrismaClient;
  ticketStore: TicketStore;
  eventBus: EventBus;
}

export interface RealtimeServerHandle {
  close(): Promise<void>;
}

export function attachRealtimeServer(httpServer: HttpServer, config: ApiConfig, deps: RealtimeServerDeps): RealtimeServerHandle {
  const wss = new WebSocketServer({ noServer: true, maxPayload: config.realtime.maxMessageBytes });
  const connectionsByUser = new Map<string, Set<ConnectionState>>();
  const allConnections = new Set<ConnectionState>();
  const maxPublicConnections = 500;
  const maxPublicConnectionsPerIp = 8;
  const refreshWatch = (chain: string, tokenAddress: string) => deps.db.candleWatch.upsert({
    where: { chain_tokenAddress: { chain, tokenAddress } },
    create: { chain, tokenAddress, lastSeenAt: new Date() }, update: { lastSeenAt: new Date() },
  }).catch(() => undefined);
  let lastWatchRefresh = 0;

  const heartbeatInterval = setInterval(() => {
    const refresh = Date.now() - lastWatchRefresh >= 60_000;
    if (refresh) lastWatchRefresh = Date.now();
    const watches = new Map<string, { chain: string; tokenAddress: string }>();
    for (const conn of allConnections) {
      if (!conn.isAlive) {
        conn.socket.terminate(); // did not answer the previous ping — treat as dead/idle
        continue;
      }
      if (refresh) for (const [key, watch] of conn.candleWatches) watches.set(key, watch);
      const delivery = deps.eventBus.describeDelivery?.();
      if (delivery && (!delivery.crossProcess || !delivery.connected)) conn.socket.close(1013, "market transport unavailable");
      conn.isAlive = false;
      conn.socket.ping();
    }
    for (const watch of watches.values()) void refreshWatch(watch.chain, watch.tokenAddress);
  }, Math.max(Math.floor(config.realtime.idleTimeoutMs / 2), 5_000));

  async function cleanupConnection(conn: ConnectionState): Promise<void> {
    conn.closed = true;
    conn.candleWatches.clear();
    allConnections.delete(conn);
    const userConns = connectionsByUser.get(conn.userId);
    userConns?.delete(conn);
    if (userConns && userConns.size === 0) connectionsByUser.delete(conn.userId);
    await Promise.all([...conn.subscriptions.values()].map((unsub) => unsub().catch(() => undefined)));
    conn.subscriptions.clear();
  }

  function sendJson(ws: WebSocket, payload: unknown): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 1_048_576) { ws.terminate(); return; }
    ws.send(JSON.stringify(payload));
  }

  function sendError(ws: WebSocket, code: string, message: string): void {
    sendJson(ws, { type: "error", code, message });
  }

  async function handleSubscribe(conn: ConnectionState, jobKey: string): Promise<void> {
    if (conn.publicMarket) { sendError(conn.socket, "AUTH_REQUIRED", "Private channels require an authenticated connection."); return; }
    if (conn.subscriptions.has(jobKey)) return; // idempotent
    if (conn.subscriptions.size >= config.realtime.maxSubscriptionsPerConnection) {
      sendError(conn.socket, "SUBSCRIPTION_LIMIT", "Too many active subscriptions on this connection.");
      return;
    }
    const owns = await userOwnsJob(deps.db, conn.userId, jobKey);
    if (!owns) {
      // Same principle as the REST job route: don't confirm or deny that the
      // job exists at all to a caller who isn't allowed to see it.
      sendError(conn.socket, "NOT_FOUND", "unknown job");
      return;
    }
    const unsubscribe = await deps.eventBus.subscribe(jobChannel(jobKey), (event) => sendJson(conn.socket, event));
    if (conn.closed) { await unsubscribe(); return; }
    conn.subscriptions.set(jobKey, unsubscribe);
  }

  async function handleUnsubscribe(conn: ConnectionState, jobKey: string): Promise<void> {
    const unsubscribe = conn.subscriptions.get(jobKey);
    if (!unsubscribe) return;
    conn.subscriptions.delete(jobKey);
    await unsubscribe();
  }

  async function handleSubscribeCandles(conn: ConnectionState, chain: string, tokenAddress: string, resolution: string): Promise<void> {
    const key = candleChannel(chain, tokenAddress, resolution as never);
    if (conn.subscriptions.has(key)) return; // idempotent
    if (conn.subscriptions.size >= config.realtime.maxSubscriptionsPerConnection) {
      sendError(conn.socket, "SUBSCRIPTION_LIMIT", "Too many active subscriptions on this connection.");
      return;
    }
    const token = await deps.db.discoveredToken.findUnique({
      where: { chain_tokenAddress: { chain, tokenAddress } }, select: { canonicalStatus: true },
    });
    if (!token || token.canonicalStatus !== "CANONICAL") { sendError(conn.socket, "NOT_FOUND", "unknown token"); return; }
    if (conn.closed) return;
    const unsubscribe = await deps.eventBus.subscribe(key, event => {
      // Public sockets can receive only this candle channel's public payloads.
      if (event.type === "token.candle.updated") sendJson(conn.socket, event);
    });
    if (conn.closed) { await unsubscribe(); return; }
    conn.subscriptions.set(key, unsubscribe);
    conn.candleWatches.set(key, { chain, tokenAddress });
    void refreshWatch(chain, tokenAddress);

    // Phase 7D.6 — say whether this channel can actually deliver, instead of leaving the
    // client to infer "live" from a socket that merely opened. With an in-memory bus the
    // publisher lives in another process and nothing will ever arrive; the client is expected
    // to fall back to polling rather than display a frozen LIVE chart
    // (docs/phase-7d6/root-cause.md).
    const delivery = deps.eventBus.describeDelivery?.() ?? { crossProcess: true, connected: true };
    sendJson(conn.socket, {
      type: "candles.subscribed",
      chain,
      tokenAddress,
      resolution,
      push: delivery.crossProcess && delivery.connected ? "live" : "unavailable",
      reason: delivery.crossProcess
        ? delivery.connected
          ? null
          : "The realtime transport is reconnecting."
        : "This API is running an in-process event bus, which cannot receive updates from the candle worker.",
    });
  }

  async function handleUnsubscribeCandles(conn: ConnectionState, chain: string, tokenAddress: string, resolution: string): Promise<void> {
    const key = candleChannel(chain, tokenAddress, resolution as never);
    const unsubscribe = conn.subscriptions.get(key);
    if (!unsubscribe) return;
    conn.subscriptions.delete(key);
    conn.candleWatches.delete(key);
    await unsubscribe();
  }

  wss.on("connection", (socket: WebSocket, _req: IncomingMessage, userId: string, publicMarket = false) => {
    const conn: ConnectionState = { userId, publicMarket, closed: false, candleWatches: new Map(), socket, isAlive: true, subscriptions: new Map() };
    allConnections.add(conn);
    let userConns = connectionsByUser.get(userId);
    if (!userConns) {
      userConns = new Set();
      connectionsByUser.set(userId, userConns);
    }
    userConns.add(conn);

    socket.on("pong", () => {
      conn.isAlive = true;
    });

    let queue = Promise.resolve();
    let pending = 0;
    let messageWindow = Date.now();
    let messageCount = 0;
    socket.on("message", (raw: Buffer) => {
      if (Date.now() - messageWindow > 60_000) { messageWindow = Date.now(); messageCount = 0; }
      if (++messageCount > 120 || pending >= 20) { socket.close(1008, "message limit"); return; }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString("utf8"));
      } catch {
        sendError(socket, "INVALID_MESSAGE", "message is not valid JSON");
        return;
      }
      const result = ClientMessageSchema.safeParse(parsed);
      if (!result.success) {
        sendError(socket, "INVALID_MESSAGE", "message failed schema validation");
        return;
      }
      pending++;
      // Serialize async subscribe/unsubscribe so concurrent frames cannot bypass
      // limits, resurrect closed subscriptions, or overwrite an unsubscribe handle.
      queue = queue.then(async () => {
        if (conn.closed) return;
        const data = result.data;
        if (data.type === "subscribe") await handleSubscribe(conn, data.jobKey);
        else if (data.type === "unsubscribe") await handleUnsubscribe(conn, data.jobKey);
        else if (data.type === "subscribeCandles") await handleSubscribeCandles(conn, data.chain, data.tokenAddress, data.resolution);
        else await handleUnsubscribeCandles(conn, data.chain, data.tokenAddress, data.resolution);
      }).catch(() => sendError(socket, "SUBSCRIPTION_FAILED", "Subscription unavailable; retry later."))
        .finally(() => { pending--; });
    });

    socket.on("close", () => {
      void cleanupConnection(conn);
    });
    socket.on("error", () => {
      void cleanupConnection(conn);
    });

    sendJson(socket, createRealtimeEvent("connection.ready", publicMarket ? { access: "public-market" } : { userId }));
  });

  httpServer.on("upgrade", (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "", "http://internal");
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== REALTIME_PATH && url.pathname !== PUBLIC_MARKET_PATH) return; // not ours — leave the socket alone for any other upgrade handler

    if (!isAllowedOrigin(req.headers.origin, config)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    if (url.pathname === PUBLIC_MARKET_PATH) {
      if (!config.publicReads) { socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); socket.destroy(); return; }
      // Use the transport peer, never an untrusted X-Forwarded-For header. A
      // reverse proxy must enforce its own edge quotas in addition to these caps.
      const key = `public:${req.socket.remoteAddress ?? "unknown"}`;
      if (allConnections.size >= maxPublicConnections || (connectionsByUser.get(key)?.size ?? 0) >= maxPublicConnectionsPerIp) {
        socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n"); socket.destroy(); return;
      }
      wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req, key, true));
      return;
    }

    const ticket = url.searchParams.get("ticket");
    if (!ticket) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    deps.ticketStore
      .consume(ticket)
      .then((payload) => {
        if (!payload) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }
        const existing = connectionsByUser.get(payload.userId);
        if (existing && existing.size >= config.realtime.maxConnectionsPerUser) {
          socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit("connection", ws, req, payload.userId);
        });
      })
      .catch(() => {
        socket.destroy();
      });
  });

  return {
    async close() {
      clearInterval(heartbeatInterval);
      for (const conn of [...allConnections]) {
        conn.socket.close(1001, "server shutting down");
        await cleanupConnection(conn);
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
