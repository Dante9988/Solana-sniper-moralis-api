import { describe, expect, it, vi } from "vitest";

import {
  EventDeduplicator,
  WsSubscriptionManager,
  eventId,
  type CanonicalEvent,
  type WsSocket,
} from "../wsSubscriptionManager";

/**
 * Phase 7D.3.1 §3 — WebSocket recovery.
 *
 * Fully deterministic: the transport, timers and randomness are injected, so disconnects,
 * stalls, reconnect storms and backfill/live overlap are exercised without a socket.
 */

const WS_ENV = {
  ROBINHOOD_RPC_WSS: "wss://primary.example/ws/KEY_A",
  ROBINHOOD_RPC_WSS2: "wss://secondary.example/ws/KEY_B",
  DEAFULT_RPC_WSS: "wss://public.example/ws",
} as NodeJS.ProcessEnv;

function evt(txHash: string, logIndex: number, blockNumber = 100n): CanonicalEvent {
  return { txHash, logIndex, blockNumber };
}

/** A controllable fake socket. */
class FakeSocket implements WsSocket {
  eventHandler: ((e: CanonicalEvent) => void) | null = null;
  closeHandler: ((reason: string) => void) | null = null;
  errorHandler: ((e: unknown) => void) | null = null;
  closed = false;

  onEvent(h: (e: CanonicalEvent) => void) { this.eventHandler = h; }
  onClose(h: (reason: string) => void) { this.closeHandler = h; }
  onError(h: (e: unknown) => void) { this.errorHandler = h; }
  close() { this.closed = true; }

  emit(event: CanonicalEvent) { this.eventHandler?.(event); }
  drop(reason = "socket closed") { this.closeHandler?.(reason); }
}

interface Harness {
  manager: WsSubscriptionManager;
  observed: CanonicalEvent[];
  connectLog: string[];
  sockets: FakeSocket[];
  checkpoint: { value: bigint };
  polled: { count: number };
  fireTimers: () => Promise<void>;
}

function harness(opts: {
  connectBehaviour?: (label: string, attempt: number) => "ok" | "fail";
  backfillEvents?: CanonicalEvent[];
  headBlock?: bigint;
  startCheckpoint?: bigint;
} = {}): Harness {
  const observed: CanonicalEvent[] = [];
  const connectLog: string[] = [];
  const sockets: FakeSocket[] = [];
  const checkpoint = { value: opts.startCheckpoint ?? 50n };
  const polled = { count: 0 };
  const attempts = new Map<string, number>();
  const timers: Array<() => void> = [];

  const manager = new WsSubscriptionManager({
    env: WS_ENV,
    now: () => 1_000_000,
    random: () => 0,
    // Timers are captured, not scheduled, so stalls fire exactly when the test says.
    setTimer: (fn: () => void) => { timers.push(fn); return timers.length - 1; },
    clearTimer: () => {},
    attemptsPerEndpoint: 1,
    connect: async (endpoint) => {
      connectLog.push(endpoint.label);
      const n = (attempts.get(endpoint.label) ?? 0) + 1;
      attempts.set(endpoint.label, n);
      if ((opts.connectBehaviour?.(endpoint.label, n) ?? "ok") === "fail") {
        throw new Error("connection refused");
      }
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    backfill: async () => ({
      events: opts.backfillEvents ?? [],
      headBlock: opts.headBlock ?? 100n,
    }),
    loadCheckpoint: async () => checkpoint.value,
    saveCheckpoint: async (h) => { checkpoint.value = h; },
    onObservation: (e) => { observed.push(e); },
    poll: async () => { polled.count += 1; },
  });

  return {
    manager, observed, connectLog, sockets, checkpoint, polled,
    fireTimers: async () => {
      const pending = timers.splice(0, timers.length);
      for (const fn of pending) fn();
      await new Promise((r) => setImmediate(r));
    },
  };
}

describe("EventDeduplicator", () => {
  it("admits an event once and suppresses the repeat", () => {
    const d = new EventDeduplicator();
    expect(d.admit(evt("0xaa", 1))).toBe(true);
    expect(d.admit(evt("0xaa", 1))).toBe(false);
  });

  it("treats the same tx at a different log index as a different event", () => {
    const d = new EventDeduplicator();
    expect(d.admit(evt("0xaa", 1))).toBe(true);
    expect(d.admit(evt("0xaa", 2))).toBe(true);
  });

  it("is case-insensitive on the tx hash", () => {
    const d = new EventDeduplicator();
    expect(d.admit(evt("0xAABB", 0))).toBe(true);
    expect(d.admit(evt("0xaabb", 0))).toBe(false);
  });

  it("stays bounded, evicting oldest ids", () => {
    const d = new EventDeduplicator(3);
    for (let i = 0; i < 5; i++) d.admit(evt(`0x${i}`, 0));
    expect(d.size).toBe(3);
    // The oldest was evicted, so it is admitted again rather than growing forever.
    expect(d.admit(evt("0x0", 0))).toBe(true);
  });

  it("eventId is the canonical identity", () => {
    expect(eventId(evt("0xAbC", 7))).toBe("0xabc:7");
  });
});

describe("connection and failover", () => {
  it("connects to the highest-priority endpoint and reports live", async () => {
    const h = harness();
    await h.manager.start();
    expect(h.connectLog).toEqual(["ROBINHOOD_RPC_WSS"]);
    expect(h.manager.connectivity).toBe("live");
  });

  it("fails over to the next endpoint when the primary refuses", async () => {
    const h = harness({ connectBehaviour: (label) => (label === "ROBINHOOD_RPC_WSS" ? "fail" : "ok") });
    await h.manager.start();
    expect(h.connectLog).toEqual(["ROBINHOOD_RPC_WSS", "ROBINHOOD_RPC_WSS2"]);
    expect(h.manager.connectivity).toBe("live");
    expect(h.manager.healthSnapshot().activeEndpoint).toBe("ROBINHOOD_RPC_WSS2");
  });

  it("falls back to the public default when both private endpoints fail", async () => {
    const h = harness({
      connectBehaviour: (label) => (label === "DEAFULT_RPC_WSS" ? "ok" : "fail"),
    });
    await h.manager.start();
    expect(h.connectLog).toEqual(["ROBINHOOD_RPC_WSS", "ROBINHOOD_RPC_WSS2", "DEAFULT_RPC_WSS"]);
    expect(h.manager.connectivity).toBe("live");
  });

  it("degrades to bounded HTTP polling when every endpoint fails — honestly labelled", async () => {
    const h = harness({ connectBehaviour: () => "fail" });
    await h.manager.start();

    expect(h.manager.connectivity).toBe("degraded_polling");
    expect(h.polled.count).toBe(1);
    // Not reported as live — the distinction is the point.
    expect(h.manager.healthSnapshot().activeEndpoint).toBeNull();
  });

  it("never exposes a URL or key in health output", async () => {
    const h = harness({ connectBehaviour: () => "fail" });
    await h.manager.start();
    const serialized = JSON.stringify(h.manager.healthSnapshot());
    expect(serialized).not.toContain("KEY_A");
    expect(serialized).not.toContain("wss://");
    expect(serialized).toContain("primary.example");
  });
});

describe("backfill, overlap and checkpoints", () => {
  it("backfills from the durable checkpoint on connect", async () => {
    const h = harness({ backfillEvents: [evt("0xb1", 0, 60n), evt("0xb2", 0, 70n)], headBlock: 80n });
    await h.manager.start();

    expect(h.observed.map((e) => e.txHash)).toEqual(["0xb1", "0xb2"]);
    // Advances only to the head the backfill actually covered.
    expect(h.checkpoint.value).toBe(80n);
  });

  it("deduplicates the overlap between backfill and live frames — no gaps, no repeats", async () => {
    // 0xb2 arrives both in the replay and as a live frame, which is the expected overlap.
    const h = harness({ backfillEvents: [evt("0xb1", 0, 60n), evt("0xb2", 0, 70n)], headBlock: 80n });
    await h.manager.start();

    h.sockets[0].emit(evt("0xb2", 0, 70n)); // duplicate
    h.sockets[0].emit(evt("0xb3", 0, 81n)); // new
    await new Promise((r) => setImmediate(r));

    expect(h.observed.map((e) => e.txHash)).toEqual(["0xb1", "0xb2", "0xb3"]);
    expect(h.manager.healthSnapshot().duplicatesSuppressed).toBe(1);
  });

  it("re-backfills after a reconnect so the disconnected window is not lost", async () => {
    const h = harness({ backfillEvents: [evt("0xr1", 0, 60n)], headBlock: 90n });
    await h.manager.start();
    expect(h.observed).toHaveLength(1);

    h.sockets[0].drop("connection reset");
    await new Promise((r) => setImmediate(r));

    // Reconnected, and the replay ran again — suppressed as duplicates rather than
    // re-emitted, which is what proves the overlap is handled rather than avoided.
    expect(h.manager.connectivity).toBe("live");
    expect(h.manager.healthSnapshot().reconnectCount).toBe(1);
    expect(h.observed).toHaveLength(1);
    expect(h.manager.healthSnapshot().duplicatesSuppressed).toBe(1);
  });

  it("does not advance the checkpoint past what backfill covered", async () => {
    const h = harness({ backfillEvents: [], headBlock: 120n, startCheckpoint: 50n });
    await h.manager.start();
    h.sockets[0].emit(evt("0xlive", 0, 999n)); // a much later live frame
    await new Promise((r) => setImmediate(r));

    // Still 120: advancing to 999 would skip everything between.
    expect(h.checkpoint.value).toBe(120n);
  });
});

describe("stall detection and reconnect storms", () => {
  it("treats a silent-but-open socket as stalled and reconnects", async () => {
    const h = harness();
    await h.manager.start();
    expect(h.manager.healthSnapshot().reconnectCount).toBe(0);

    await h.fireTimers(); // stall timer expires

    expect(h.manager.healthSnapshot().reconnectCount).toBe(1);
    expect(h.sockets[0].closed).toBe(true);
  });

  it("closes the old socket before reconnecting, preventing two subscription owners", async () => {
    const h = harness();
    await h.manager.start();
    h.sockets[0].drop("reset");
    await new Promise((r) => setImmediate(r));

    expect(h.sockets[0].closed).toBe(true);
    expect(h.sockets).toHaveLength(2);
  });

  it("is single-flight: a close and a stall together cause one reconnect, not two", async () => {
    const h = harness();
    await h.manager.start();

    h.sockets[0].drop("reset");
    await h.fireTimers();
    await new Promise((r) => setImmediate(r));

    expect(h.manager.healthSnapshot().reconnectCount).toBe(1);
  });

  it("stop() halts reconnection", async () => {
    const h = harness();
    await h.manager.start();
    await h.manager.stop();

    h.sockets[0].drop("reset");
    await new Promise((r) => setImmediate(r));

    expect(h.manager.connectivity).toBe("stopped");
    expect(h.manager.healthSnapshot().reconnectCount).toBe(0);
  });
});
