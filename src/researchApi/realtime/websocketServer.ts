/**
 * Phase 7B.2 — the authenticated WebSocket endpoint, `/api/v1/realtime`
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
import { jobChannel } from "./eventPublisher";
import { TicketStore } from "./ticketStore";

export const REALTIME_PATH = "/api/v1/realtime";

const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("subscribe"), jobKey: z.string().min(1).max(512) }),
  z.object({ type: z.literal("unsubscribe"), jobKey: z.string().min(1).max(512) }),
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

  const heartbeatInterval = setInterval(() => {
    for (const conn of allConnections) {
      if (!conn.isAlive) {
        conn.socket.terminate(); // did not answer the previous ping — treat as dead/idle
        continue;
      }
      conn.isAlive = false;
      conn.socket.ping();
    }
  }, Math.max(Math.floor(config.realtime.idleTimeoutMs / 2), 5_000));

  async function cleanupConnection(conn: ConnectionState): Promise<void> {
    allConnections.delete(conn);
    const userConns = connectionsByUser.get(conn.userId);
    userConns?.delete(conn);
    if (userConns && userConns.size === 0) connectionsByUser.delete(conn.userId);
    await Promise.all([...conn.subscriptions.values()].map((unsub) => unsub().catch(() => undefined)));
    conn.subscriptions.clear();
  }

  function sendJson(ws: WebSocket, payload: unknown): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(payload));
  }

  function sendError(ws: WebSocket, code: string, message: string): void {
    sendJson(ws, { type: "error", code, message });
  }

  async function handleSubscribe(conn: ConnectionState, jobKey: string): Promise<void> {
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
    conn.subscriptions.set(jobKey, unsubscribe);
  }

  async function handleUnsubscribe(conn: ConnectionState, jobKey: string): Promise<void> {
    const unsubscribe = conn.subscriptions.get(jobKey);
    if (!unsubscribe) return;
    conn.subscriptions.delete(jobKey);
    await unsubscribe();
  }

  wss.on("connection", (socket: WebSocket, _req: IncomingMessage, userId: string) => {
    const conn: ConnectionState = { userId, socket, isAlive: true, subscriptions: new Map() };
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

    socket.on("message", (raw: Buffer) => {
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
      if (result.data.type === "subscribe") {
        void handleSubscribe(conn, result.data.jobKey);
      } else {
        void handleUnsubscribe(conn, result.data.jobKey);
      }
    });

    socket.on("close", () => {
      void cleanupConnection(conn);
    });
    socket.on("error", () => {
      void cleanupConnection(conn);
    });

    sendJson(socket, createRealtimeEvent("connection.ready", { userId }));
  });

  httpServer.on("upgrade", (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "", "http://internal");
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== REALTIME_PATH) return; // not ours — leave the socket alone for any other upgrade handler

    if (!isAllowedOrigin(req.headers.origin, config)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
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
