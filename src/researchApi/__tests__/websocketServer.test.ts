import { createServer, Server as HttpServer } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { attachRealtimeServer, REALTIME_PATH, RealtimeServerHandle } from "../realtime/websocketServer";
import { InMemoryEventBus } from "../realtime/eventBus";
import { MemoryTicketStore } from "../realtime/ticketStore";
import { CorsConfig, RealtimeConfig } from "../config";
import { publishJobEvent } from "../realtime/eventPublisher";

/**
 * Real ephemeral in-process server + real `ws` client — the same pattern
 * every other route test in this repo uses via supertest, just for the
 * WebSocket transport specifically (supertest can't drive an upgrade).
 * Never binds a fixed port, never touches any external service
 * (phase7b2.txt §11).
 *
 * Every message listener below is attached via a queue created at socket
 * construction time, before any `await` — `ws.once('message', ...)` added
 * *after* awaiting `open` can miss a message that arrives back-to-back with
 * the open event, since EventEmitter 'once' only catches emissions that
 * happen after it's attached.
 */

function fakeConfig(overrides: { realtime?: Partial<RealtimeConfig>; cors?: Partial<CorsConfig> } = {}) {
  return {
    cors: {
      allowedOrigins: new Set<string>(["https://app.onlypump.me"]),
      devOrigins: new Set<string>(["http://localhost:5173"]),
      isProduction: false,
      ...overrides.cors,
    },
    realtime: {
      backend: "memory" as const,
      ticketTtlMs: 45_000,
      maxMessageBytes: 8_192,
      maxSubscriptionsPerConnection: 20,
      maxConnectionsPerUser: 5,
      idleTimeoutMs: 60_000,
      ...overrides.realtime,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function fakeDb(ownedJobKeys: Set<string>) {
  return {
    userScanRequest: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findUnique: vi.fn(async ({ where }: any) => (ownedJobKeys.has(where.userId_jobKey.jobKey) ? { id: "x" } : null)),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

class MessageQueue {
  private readonly pending: unknown[] = [];
  private readonly waiters: ((msg: unknown) => void)[] = [];

  constructor(ws: WebSocket) {
    ws.on("message", (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        parsed = { __unparseable: data.toString() };
      }
      const waiter = this.waiters.shift();
      if (waiter) waiter(parsed);
      else this.pending.push(parsed);
    });
  }

  next(timeoutMs = 2000): Promise<unknown> {
    if (this.pending.length > 0) return Promise.resolve(this.pending.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for a WebSocket message")), timeoutMs);
      this.waiters.push((msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  }
}

describe("authenticated WebSocket server (phase7b2.txt §4)", () => {
  let httpServer: HttpServer;
  let handle: RealtimeServerHandle;
  let port: number;
  let ticketStore: MemoryTicketStore;
  let eventBus: InMemoryEventBus;
  let ownedJobKeys: Set<string>;

  async function start(config: ReturnType<typeof fakeConfig> = fakeConfig()) {
    httpServer = createServer();
    ticketStore = new MemoryTicketStore();
    eventBus = new InMemoryEventBus();
    ownedJobKeys = new Set();
    handle = attachRealtimeServer(httpServer, config, { db: fakeDb(ownedJobKeys), ticketStore, eventBus });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    port = (httpServer.address() as AddressInfo).port;
  }

  afterEach(async () => {
    await handle?.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  function wsUrl(ticket?: string): string {
    const base = `ws://127.0.0.1:${port}${REALTIME_PATH}`;
    return ticket !== undefined ? `${base}?ticket=${encodeURIComponent(ticket)}` : base;
  }

  function connect(ticket?: string, headers?: Record<string, string>): { ws: WebSocket; messages: MessageQueue } {
    const ws = new WebSocket(wsUrl(ticket), headers ? { headers } : undefined);
    const messages = new MessageQueue(ws); // attached synchronously — no race with early messages
    return { ws, messages };
  }

  function waitForOpenOrFail(ws: WebSocket, timeoutMs = 2000): Promise<"open" | "failed"> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve("failed"), timeoutMs);
      ws.once("open", () => {
        clearTimeout(timer);
        resolve("open");
      });
      ws.once("error", () => {
        clearTimeout(timer);
        resolve("failed");
      });
      ws.once("unexpected-response", () => {
        clearTimeout(timer);
        resolve("failed");
      });
    });
  }

  it("connects with a valid ticket and immediately receives connection.ready", async () => {
    await start();
    const ticket = await ticketStore.issue("user-1", 45_000);
    const { ws, messages } = connect(ticket);
    expect(await waitForOpenOrFail(ws)).toBe("open");
    const first = await messages.next();
    expect(first).toMatchObject({ type: "connection.ready", data: { userId: "user-1" } });
    ws.close();
  });

  it("rejects a connection with no ticket at all", async () => {
    await start();
    const { ws } = connect();
    expect(await waitForOpenOrFail(ws)).toBe("failed");
  });

  it("rejects an unknown/never-issued ticket", async () => {
    await start();
    const { ws } = connect("not-a-real-ticket");
    expect(await waitForOpenOrFail(ws)).toBe("failed");
  });

  it("rejects an expired ticket", async () => {
    await start();
    const ticket = await ticketStore.issue("user-1", -1); // already expired the instant it's issued
    const { ws } = connect(ticket);
    expect(await waitForOpenOrFail(ws)).toBe("failed");
  });

  it("rejects a reused ticket — the second connection attempt with the same ticket fails", async () => {
    await start();
    const ticket = await ticketStore.issue("user-1", 45_000);
    const { ws: first } = connect(ticket);
    expect(await waitForOpenOrFail(first)).toBe("open");
    first.close();

    const { ws: second } = connect(ticket);
    expect(await waitForOpenOrFail(second)).toBe("failed");
  });

  it("rejects a disallowed browser Origin independently of CORS", async () => {
    await start(fakeConfig({ cors: { isProduction: true } }));
    const ticket = await ticketStore.issue("user-1", 45_000);
    const { ws } = connect(ticket, { Origin: "https://evil.example.com" });
    expect(await waitForOpenOrFail(ws)).toBe("failed");
  });

  it("allows a configured Origin", async () => {
    await start(fakeConfig({ cors: { isProduction: true } }));
    const ticket = await ticketStore.issue("user-1", 45_000);
    const { ws } = connect(ticket, { Origin: "https://app.onlypump.me" });
    expect(await waitForOpenOrFail(ws)).toBe("open");
    ws.close();
  });

  it("allows a connection with no Origin header at all (native/non-browser client)", async () => {
    await start(fakeConfig({ cors: { isProduction: true } }));
    const ticket = await ticketStore.issue("user-1", 45_000);
    const { ws } = connect(ticket);
    expect(await waitForOpenOrFail(ws)).toBe("open");
    ws.close();
  });

  it("responds to an invalid (non-JSON) message with an error frame, and keeps the connection open", async () => {
    await start();
    const ticket = await ticketStore.issue("user-1", 45_000);
    const { ws, messages } = connect(ticket);
    await waitForOpenOrFail(ws);
    await messages.next(); // connection.ready

    ws.send("not json{{{");
    const errorMsg = await messages.next();
    expect(errorMsg).toMatchObject({ type: "error", code: "INVALID_MESSAGE" });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("responds to a message that fails schema validation with an error frame", async () => {
    await start();
    const ticket = await ticketStore.issue("user-1", 45_000);
    const { ws, messages } = connect(ticket);
    await waitForOpenOrFail(ws);
    await messages.next(); // connection.ready

    ws.send(JSON.stringify({ type: "not-a-real-type" }));
    const errorMsg = await messages.next();
    expect(errorMsg).toMatchObject({ type: "error", code: "INVALID_MESSAGE" });
    ws.close();
  });

  it("terminates a connection that sends an oversized message", async () => {
    await start(fakeConfig({ realtime: { maxMessageBytes: 32 } }));
    const ticket = await ticketStore.issue("user-1", 45_000);
    const { ws, messages } = connect(ticket);
    await waitForOpenOrFail(ws);
    await messages.next(); // connection.ready

    const closed = new Promise((resolve) => ws.once("close", resolve));
    ws.send(JSON.stringify({ type: "subscribe", jobKey: "x".repeat(200) }));
    await closed; // ws itself enforces maxPayload and closes the connection
  });

  it("rejects subscribing to a job the connected user does not own — no confirmation the job exists", async () => {
    await start();
    const ticket = await ticketStore.issue("user-1", 45_000);
    const { ws, messages } = connect(ticket);
    await waitForOpenOrFail(ws);
    await messages.next(); // connection.ready

    ws.send(JSON.stringify({ type: "subscribe", jobKey: "someone-elses-job" }));
    const errorMsg = await messages.next();
    expect(errorMsg).toMatchObject({ type: "error", code: "NOT_FOUND" });
    ws.close();
  });

  it("delivers a job event to a client subscribed to a job it owns — end-to-end through the event bus", async () => {
    await start();
    ownedJobKeys.add("job-1");
    const ticket = await ticketStore.issue("user-1", 45_000);
    const { ws, messages } = connect(ticket);
    await waitForOpenOrFail(ws);
    await messages.next(); // connection.ready

    ws.send(JSON.stringify({ type: "subscribe", jobKey: "job-1" }));
    await new Promise((r) => setTimeout(r, 50)); // let the async subscribe handler register with the bus

    await publishJobEvent(eventBus, "scan.completed", { jobKey: "job-1", mint: "MintX", status: "COMPLETE" });
    const received = await messages.next();
    expect(received).toMatchObject({ type: "scan.completed", data: { jobKey: "job-1", mint: "MintX", status: "COMPLETE" } });
    ws.close();
  });

  it("unsubscribe stops further delivery for that job on that connection", async () => {
    await start();
    ownedJobKeys.add("job-1");
    const ticket = await ticketStore.issue("user-1", 45_000);
    const { ws, messages } = connect(ticket);
    await waitForOpenOrFail(ws);
    await messages.next();

    ws.send(JSON.stringify({ type: "subscribe", jobKey: "job-1" }));
    await new Promise((r) => setTimeout(r, 50));
    ws.send(JSON.stringify({ type: "unsubscribe", jobKey: "job-1" }));
    await new Promise((r) => setTimeout(r, 50));

    await publishJobEvent(eventBus, "scan.completed", { jobKey: "job-1", mint: "MintX", status: "COMPLETE" });
    await expect(messages.next(200)).rejects.toThrow(/timed out/);
    ws.close();
  });

  it("enforces a per-connection subscription limit", async () => {
    await start(fakeConfig({ realtime: { maxSubscriptionsPerConnection: 1 } }));
    ownedJobKeys.add("job-1");
    ownedJobKeys.add("job-2");
    const ticket = await ticketStore.issue("user-1", 45_000);
    const { ws, messages } = connect(ticket);
    await waitForOpenOrFail(ws);
    await messages.next();

    ws.send(JSON.stringify({ type: "subscribe", jobKey: "job-1" }));
    await new Promise((r) => setTimeout(r, 50));

    ws.send(JSON.stringify({ type: "subscribe", jobKey: "job-2" }));
    const errorMsg = await messages.next();
    expect(errorMsg).toMatchObject({ type: "error", code: "SUBSCRIPTION_LIMIT" });
    ws.close();
  });

  it("enforces a per-user connection limit across multiple sockets", async () => {
    await start(fakeConfig({ realtime: { maxConnectionsPerUser: 1 } }));
    const ticket1 = await ticketStore.issue("user-1", 45_000);
    const { ws: first } = connect(ticket1);
    expect(await waitForOpenOrFail(first)).toBe("open");

    const ticket2 = await ticketStore.issue("user-1", 45_000);
    const { ws: second } = connect(ticket2);
    expect(await waitForOpenOrFail(second)).toBe("failed");

    first.close();
  });

  it("never accepts an internal API key, a Supabase JWT, or any secret-shaped field as a WebSocket message", async () => {
    await start();
    const ticket = await ticketStore.issue("user-1", 45_000);
    const { ws, messages } = connect(ticket);
    await waitForOpenOrFail(ws);
    await messages.next();

    // The schema only recognizes subscribe/unsubscribe with a jobKey — any
    // attempt to smuggle a credential-shaped field through is just an
    // unrecognized message shape, rejected the same as any other invalid one.
    ws.send(JSON.stringify({ type: "auth", apiKey: "sk-should-not-work", jwt: "should.not.work" }));
    const errorMsg = await messages.next();
    expect(errorMsg).toMatchObject({ type: "error", code: "INVALID_MESSAGE" });
    ws.close();
  });

  it("graceful shutdown closes all open connections", async () => {
    await start();
    const ticket = await ticketStore.issue("user-1", 45_000);
    const { ws } = connect(ticket);
    await waitForOpenOrFail(ws);

    const closed = new Promise((resolve) => ws.once("close", resolve));
    await handle.close();
    await closed;
  });
});
