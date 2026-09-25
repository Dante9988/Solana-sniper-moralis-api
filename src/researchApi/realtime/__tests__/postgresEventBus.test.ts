import { describe, expect, it, vi } from "vitest";

import {
  MAX_NOTIFY_PAYLOAD_BYTES,
  NOTIFY_CHANNEL,
  NotifyPayloadTooLargeError,
  PostgresEventBus,
  type PgNotifyClient,
} from "../postgresEventBus";
import type { RealtimeEventEnvelope } from "../eventEnvelope";

/**
 * Phase 7D.6. These tests exist because of a bug that produced no error anywhere: the candles
 * worker published into a process-local bus, the API held every WebSocket, and the chart sat
 * still while the badge said LIVE. So the assertions here are mostly about *not* failing
 * silently — an event that cannot be delivered must be loud, and a transport that is down must
 * say it is down.
 */

function event(id = "evt-1"): RealtimeEventEnvelope {
  return { version: "1", eventId: id, type: "token.candle.updated", occurredAt: "2026-09-25T04:00:00.000Z", data: { hello: "world" } } as RealtimeEventEnvelope;
}

interface FakeClient extends PgNotifyClient {
  emitNotification(msg: { channel: string; payload?: string }): void;
  emitError(err: Error): void;
  readonly queries: Array<{ sql: string; values?: unknown[] }>;
  readonly connected: () => boolean;
}

function makeClient(options: { failConnect?: boolean } = {}): FakeClient {
  const notificationListeners: Array<(msg: { channel: string; payload?: string }) => void> = [];
  const errorListeners: Array<(err: Error) => void> = [];
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  let isConnected = false;
  return {
    queries,
    connected: () => isConnected,
    async connect() {
      if (options.failConnect) throw new Error("connect refused");
      isConnected = true;
    },
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      return undefined;
    },
    async end() {
      isConnected = false;
    },
    on(eventName: "notification" | "error", listener: never) {
      if (eventName === "notification") notificationListeners.push(listener);
      else errorListeners.push(listener);
    },
    emitNotification(msg) {
      for (const l of notificationListeners) l(msg);
    },
    emitError(err) {
      for (const l of errorListeners) l(err);
    },
  } as FakeClient;
}

describe("PostgresEventBus", () => {
  it("carries an event from a publisher to a subscriber in another process", async () => {
    const publisher = makeClient();
    const listener = makeClient();
    const bus = new PostgresEventBus(publisher, () => listener);

    const received: RealtimeEventEnvelope[] = [];
    await bus.subscribe("candle:robinhood:0xabc:5s", (e) => received.push(e));

    // What the *other* process would have sent: it never shares memory with this one, only the
    // database, so replay exactly the NOTIFY payload a publish produces.
    await bus.publish("candle:robinhood:0xabc:5s", event());
    const notify = publisher.queries.at(-1)!;
    expect(notify.sql).toContain("pg_notify");
    expect(notify.values?.[0]).toBe(NOTIFY_CHANNEL);
    listener.emitNotification({ channel: NOTIFY_CHANNEL, payload: String(notify.values?.[1]) });

    expect(received).toHaveLength(1);
    expect(received[0].eventId).toBe("evt-1");
  });

  it("delivers only to the logical channel that was subscribed", async () => {
    const publisher = makeClient();
    const listener = makeClient();
    const bus = new PostgresEventBus(publisher, () => listener);

    const wanted: RealtimeEventEnvelope[] = [];
    const other: RealtimeEventEnvelope[] = [];
    await bus.subscribe("candle:robinhood:0xaaa:5s", (e) => wanted.push(e));
    await bus.subscribe("candle:robinhood:0xbbb:5s", (e) => other.push(e));

    await bus.publish("candle:robinhood:0xaaa:5s", event());
    listener.emitNotification({ channel: NOTIFY_CHANNEL, payload: String(publisher.queries.at(-1)!.values?.[1]) });

    expect(wanted).toHaveLength(1);
    expect(other).toHaveLength(0);
  });

  it("stops delivering after unsubscribe", async () => {
    const publisher = makeClient();
    const listener = makeClient();
    const bus = new PostgresEventBus(publisher, () => listener);
    const received: RealtimeEventEnvelope[] = [];
    const unsubscribe = await bus.subscribe("candle:x", (e) => received.push(e));
    await unsubscribe();

    await bus.publish("candle:x", event());
    listener.emitNotification({ channel: NOTIFY_CHANNEL, payload: String(publisher.queries.at(-1)!.values?.[1]) });
    expect(received).toHaveLength(0);
  });

  it("refuses an oversized event rather than dropping or truncating it", async () => {
    const publisher = makeClient();
    const bus = new PostgresEventBus(publisher, () => makeClient());
    const huge = { ...event(), data: { blob: "x".repeat(MAX_NOTIFY_PAYLOAD_BYTES) } } as RealtimeEventEnvelope;
    // Postgres would reject this itself, but the point is that the caller finds out. A quietly
    // missing update is the exact failure this bus was written to end.
    await expect(bus.publish("candle:x", huge)).rejects.toBeInstanceOf(NotifyPayloadTooLargeError);
  });

  it("survives a malformed or foreign payload on the shared channel", async () => {
    const publisher = makeClient();
    const listener = makeClient();
    const bus = new PostgresEventBus(publisher, () => listener);
    const received: RealtimeEventEnvelope[] = [];
    await bus.subscribe("candle:x", (e) => received.push(e));

    expect(() => listener.emitNotification({ channel: NOTIFY_CHANNEL, payload: "not json" })).not.toThrow();
    expect(() => listener.emitNotification({ channel: NOTIFY_CHANNEL, payload: '{"unexpected":true}' })).not.toThrow();
    expect(() => listener.emitNotification({ channel: "someone_elses_channel", payload: "{}" })).not.toThrow();
    expect(received).toHaveLength(0);
  });

  it("reports the transport as disconnected while it is down, then recovers", async () => {
    vi.useFakeTimers();
    try {
      const publisher = makeClient();
      const first = makeClient();
      const second = makeClient();
      const clients = [first, second];
      const bus = new PostgresEventBus(publisher, () => clients.shift() ?? makeClient(), { reconnectDelayMs: () => 10, onError: () => undefined });

      const received: RealtimeEventEnvelope[] = [];
      await bus.subscribe("candle:x", (e) => received.push(e));
      expect(bus.describeDelivery()).toEqual({ crossProcess: true, connected: true });

      // A dropped LISTEN connection that still *looked* connected is how a chart freezes while
      // claiming to be live, so the capability must flip the instant the connection errors.
      first.emitError(new Error("connection terminated"));
      expect(bus.describeDelivery()).toEqual({ crossProcess: true, connected: false });

      await vi.advanceTimersByTimeAsync(20);
      expect(bus.describeDelivery()).toEqual({ crossProcess: true, connected: true });
      expect(second.queries.some((q) => q.sql.startsWith("LISTEN"))).toBe(true);

      // And it is a real subscription again, not just a connected socket.
      await bus.publish("candle:x", event("after-reconnect"));
      second.emitNotification({ channel: NOTIFY_CHANNEL, payload: String(publisher.queries.at(-1)!.values?.[1]) });
      expect(received.map((e) => e.eventId)).toEqual(["after-reconnect"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports disconnected when the very first connect fails", async () => {
    vi.useFakeTimers();
    try {
      const bus = new PostgresEventBus(makeClient(), () => makeClient({ failConnect: true }), { reconnectDelayMs: () => 10_000, onError: () => undefined });
      await bus.subscribe("candle:x", () => undefined);
      expect(bus.describeDelivery()).toEqual({ crossProcess: true, connected: false });
    } finally {
      vi.useRealTimers();
    }
  });
});
