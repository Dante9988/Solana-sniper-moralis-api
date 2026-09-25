/**
 * Phase 7D.6 — cross-process realtime delivery over Postgres `LISTEN`/`NOTIFY`.
 *
 * Why this exists: the candles worker runs in its own process and publishes
 * `token.candle.updated`; every WebSocket client is held by the API process. With the
 * in-memory bus those are two different objects and nothing can travel between them, so the
 * chart could never move while the UI cheerfully said LIVE (docs/phase-7d6/root-cause.md).
 * Redis already solved that — for anyone who remembered to run Redis and set
 * `REALTIME_BACKEND=redis`. Every process here already requires Postgres, so routing events
 * through it removes the "forgot the extra service" failure mode entirely rather than
 * documenting it harder.
 *
 * Two deliberate choices:
 *
 * - **One fixed Postgres channel, logical channel in the payload.** Postgres channel names
 *   are identifiers: 63 bytes, and quoting rules we would have to encode around. Our logical
 *   channels (`candle:robinhood:0x…:5s`) exceed that. Fanning out in this process is cheap
 *   and keeps the channel name a constant.
 * - **A dropped LISTEN connection re-LISTENs.** A silently dead subscriber is the exact
 *   failure this module was written to fix, so losing the connection reconnects with backoff
 *   and re-issues LISTEN; it never sits there looking connected.
 *
 * `NOTIFY` payloads are capped at 8000 bytes by Postgres. An oversized event throws rather
 * than being dropped or truncated — a silently missing event is how you get a chart that
 * looks live and is not.
 */

import type { DeliveryCapability, EventBus, EventBusHandler } from "./eventBus";
import { RealtimeEventEnvelope } from "./eventEnvelope";

/** The one Postgres channel every logical channel is multiplexed over. */
export const NOTIFY_CHANNEL = "onlypump_realtime";

/** Postgres' own limit is 8000 bytes; leave room for the envelope we wrap around the event. */
export const MAX_NOTIFY_PAYLOAD_BYTES = 7_800;

export class NotifyPayloadTooLargeError extends Error {}

/** The slice of `pg.Client` this module uses — narrow so tests can supply a fake. */
export interface PgNotifyClient {
  query(sql: string, values?: unknown[]): Promise<unknown>;
  on(event: "notification", listener: (msg: { channel: string; payload?: string }) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  connect(): Promise<void>;
  end(): Promise<void>;
}

interface WireMessage {
  channel: string;
  event: RealtimeEventEnvelope;
}

function isWireMessage(value: unknown): value is WireMessage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.channel === "string" && typeof v.event === "object" && v.event !== null;
}

export interface PostgresEventBusOptions {
  /** Called when the listen connection drops or fails to re-establish. Defaults to console.error. */
  readonly onError?: (err: Error) => void;
  /** Reconnect backoff, exposed so tests do not wait in real time. */
  readonly reconnectDelayMs?: (attempt: number) => number;
  /** Injectable for tests; must return a *fresh, unconnected* client each call. */
  readonly createListener?: () => PgNotifyClient;
}

const DEFAULT_RECONNECT_MS = (attempt: number) => Math.min(15_000, 500 * 2 ** attempt);

export class PostgresEventBus implements EventBus {
  private readonly handlers = new Map<string, Set<EventBusHandler>>();
  private listener: PgNotifyClient | null = null;
  private listenStarted = false;
  private closed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onError: (err: Error) => void;
  private readonly reconnectDelayMs: (attempt: number) => number;

  constructor(
    private readonly publisher: PgNotifyClient,
    private readonly createListener: () => PgNotifyClient,
    options: PostgresEventBusOptions = {},
  ) {
    this.onError = options.onError ?? ((err) => console.error("[postgresEventBus]", err.message));
    this.reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_MS;
  }

  async publish(channel: string, event: RealtimeEventEnvelope): Promise<void> {
    const payload = JSON.stringify({ channel, event } satisfies WireMessage);
    const bytes = Buffer.byteLength(payload, "utf8");
    if (bytes > MAX_NOTIFY_PAYLOAD_BYTES) {
      throw new NotifyPayloadTooLargeError(
        `realtime event for channel ${channel} is ${bytes} bytes, over the ${MAX_NOTIFY_PAYLOAD_BYTES}-byte NOTIFY budget`,
      );
    }
    await this.publisher.query("SELECT pg_notify($1, $2)", [NOTIFY_CHANNEL, payload]);
  }

  async subscribe(channel: string, handler: EventBusHandler): Promise<() => Promise<void>> {
    await this.ensureListening();
    let handlers = this.handlers.get(channel);
    if (!handlers) {
      handlers = new Set();
      this.handlers.set(channel, handlers);
    }
    handlers.add(handler);
    return async () => {
      const current = this.handlers.get(channel);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) this.handlers.delete(channel);
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.handlers.clear();
    const listener = this.listener;
    this.listener = null;
    this.listenStarted = false;
    await Promise.all([
      listener?.end().catch(() => undefined),
      this.publisher.end().catch(() => undefined),
    ]);
  }

  /** True once the LISTEN connection is established — what the API reports to clients as "push can actually arrive". */
  get isListening(): boolean {
    return this.listener !== null;
  }

  describeDelivery(): DeliveryCapability {
    // Before the first subscribe there is no listener yet, and that is not a fault — report
    // connected until we have actually tried, so a fresh process does not advertise a problem
    // it does not have.
    return { crossProcess: true, connected: this.listenStarted ? this.listener !== null : true };
  }

  private async ensureListening(): Promise<void> {
    if (this.closed || this.listenStarted) return;
    this.listenStarted = true;
    await this.openListener();
  }

  private async openListener(): Promise<void> {
    if (this.closed) return;
    const client = this.createListener();
    client.on("notification", (msg) => this.dispatch(msg));
    client.on("error", (err) => {
      this.onError(err);
      this.scheduleReconnect();
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${NOTIFY_CHANNEL}`);
      this.listener = client;
      this.reconnectAttempt = 0;
    } catch (err) {
      this.listener = null;
      this.onError(err instanceof Error ? err : new Error(String(err)));
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    // Drop the dead handle first: `isListening` must never claim a connection we know is gone.
    this.listener = null;
    const delay = this.reconnectDelayMs(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openListener();
    }, delay);
    // A pending reconnect must not hold the process open (workers exit on SIGTERM).
    (this.reconnectTimer as unknown as { unref?: () => void }).unref?.();
  }

  private dispatch(msg: { channel: string; payload?: string }): void {
    if (msg.channel !== NOTIFY_CHANNEL || !msg.payload) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(msg.payload);
    } catch {
      return; // a malformed payload from anything else NOTIFYing must not crash the API
    }
    if (!isWireMessage(parsed)) return;
    const handlers = this.handlers.get(parsed.channel);
    if (!handlers || handlers.size === 0) return;
    for (const handler of handlers) handler(parsed.event);
  }
}
