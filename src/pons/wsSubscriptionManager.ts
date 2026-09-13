/**
 * Phase 7D.3.1 §3 — WebSocket subscription with recovery.
 *
 * Note on scope: this repo had **no** WebSocket subscriber. PONS ingestion is HTTP
 * polling over block ranges against durable checkpoints. So this builds the subscription
 * layer with recovery designed in, rather than repairing an existing one — and HTTP
 * polling stays the fallback rather than being replaced, because it is the path that has
 * actually been carrying ingestion.
 *
 * The correctness rule that shapes everything here: **a reconnect must not lose or
 * duplicate observations.** On every (re)connection we backfill over HTTP from the durable
 * checkpoint up to the current head, while live frames are already arriving. Those two
 * streams overlap by construction, so both go through one deduplicator keyed on canonical
 * event identity (`txHash:logIndex`), and the checkpoint only advances past a height once
 * it is fully covered.
 *
 * No sockets are created here directly: the transport is injected, which is what makes
 * disconnect, stall, storm and overlap behaviour deterministically testable.
 */

import {
  backoffWithJitter,
  isInCooldown,
  cooldownFor,
  classifyRpcFailure,
  resolveWsEndpoints,
  type EndpointHealth,
  type RpcEndpoint,
} from "./rpcEndpoints";

/** Connectivity as reported to operators and the API. Never cosmetic. */
export type ConnectivityState =
  | "connecting"
  | "live" // a websocket is connected and delivering
  | "degraded_polling" // every websocket failed; HTTP polling is carrying ingestion
  | "stopped";

/** The minimal shape this manager needs from an observation. */
export interface CanonicalEvent {
  txHash: string;
  logIndex: number;
  blockNumber: bigint;
}

/** Canonical event identity. Two frames with this id are the same observation. */
export function eventId(event: CanonicalEvent): string {
  return `${event.txHash.toLowerCase()}:${event.logIndex}`;
}

export interface WsSocket {
  /** Resolves once the socket is open; rejects if it cannot connect. */
  close(): void;
  onEvent(handler: (event: CanonicalEvent) => void): void;
  onClose(handler: (reason: string) => void): void;
  onError(handler: (error: unknown) => void): void;
}

export interface WsSubscriptionOptions {
  env?: NodeJS.ProcessEnv;
  /** Opens a socket for an endpoint. Injected so tests never touch a network. */
  connect: (endpoint: RpcEndpoint) => Promise<WsSocket>;
  /**
   * Replays observations over HTTP from `fromBlock` to head. Returns the highest block
   * fully covered, which is what allows the checkpoint to advance safely.
   */
  backfill: (fromBlock: bigint) => Promise<{ events: CanonicalEvent[]; headBlock: bigint }>;
  /** Durable checkpoint accessors. */
  loadCheckpoint: () => Promise<bigint>;
  saveCheckpoint: (height: bigint) => Promise<void>;
  /** Called once per de-duplicated observation, in arrival order. */
  onObservation: (event: CanonicalEvent) => Promise<void> | void;
  /** Bounded HTTP polling used while every websocket is unusable. */
  poll?: () => Promise<void>;

  /** No frame within this window means the subscription has stalled, even if "open". */
  stallTimeoutMs?: number;
  /** Reconnect pacing. Jittered to prevent synchronized reconnect storms. */
  baseReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  /** Consecutive failures on one endpoint before moving to the next. */
  attemptsPerEndpoint?: number;
  /** How many recent event ids to remember for de-duplication. */
  dedupeWindow?: number;

  now?: () => number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  logger?: { warn: (msg: string, meta?: unknown) => void; info: (msg: string, meta?: unknown) => void };
}

/**
 * Bounded de-duplicator.
 *
 * Backfill and live frames deliberately overlap, so duplicates are expected rather than
 * exceptional. Bounded because an unbounded set would grow without limit on a long-lived
 * worker; the window only has to outlive the overlap, not the process.
 */
export class EventDeduplicator {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];

  constructor(private readonly limit = 10_000) {}

  /** True if this is the first time we have seen the event. */
  admit(event: CanonicalEvent): boolean {
    const id = eventId(event);
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    this.order.push(id);
    if (this.order.length > this.limit) {
      const evicted = this.order.shift();
      if (evicted !== undefined) this.seen.delete(evicted);
    }
    return true;
  }

  get size(): number {
    return this.seen.size;
  }
}

export interface WsHealthSnapshot {
  state: ConnectivityState;
  /** Endpoint label currently carrying the subscription, if any. */
  activeEndpoint: string | null;
  endpoints: EndpointHealth[];
  reconnectCount: number;
  backfilledEvents: number;
  duplicatesSuppressed: number;
  lastEventAt: number | null;
  lastCheckpoint: string | null;
}

export class WsSubscriptionManager {
  private readonly endpoints: Array<{ endpoint: RpcEndpoint; health: EndpointHealth }>;
  private readonly dedupe: EventDeduplicator;
  private readonly opts: Required<
    Pick<
      WsSubscriptionOptions,
      "stallTimeoutMs" | "baseReconnectDelayMs" | "maxReconnectDelayMs" | "attemptsPerEndpoint" | "dedupeWindow"
    >
  >;
  private readonly now: () => number;
  private readonly random: () => number;

  private state: ConnectivityState = "connecting";
  private activeIndex: number | null = null;
  private socket: WsSocket | null = null;
  private stopped = false;
  private stallHandle: unknown = null;

  private reconnectCount = 0;
  private backfilledEvents = 0;
  private duplicatesSuppressed = 0;
  private lastEventAt: number | null = null;
  private lastCheckpoint: bigint | null = null;

  constructor(private readonly options: WsSubscriptionOptions) {
    this.endpoints = resolveWsEndpoints(options.env ?? process.env).map((endpoint) => ({
      endpoint,
      health: {
        label: endpoint.label,
        host: endpoint.host,
        priority: endpoint.priority,
        healthy: true,
        cooldownUntil: null,
        lastFailure: null,
        consecutiveFailures: 0,
        successCount: 0,
        failureCount: 0,
        failoverCount: 0,
        lastUsedAt: null,
        observedChainId: null,
      },
    }));

    this.opts = {
      stallTimeoutMs: options.stallTimeoutMs ?? 90_000,
      baseReconnectDelayMs: options.baseReconnectDelayMs ?? 500,
      maxReconnectDelayMs: options.maxReconnectDelayMs ?? 30_000,
      attemptsPerEndpoint: options.attemptsPerEndpoint ?? 2,
      dedupeWindow: options.dedupeWindow ?? 10_000,
    };
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.dedupe = new EventDeduplicator(this.opts.dedupeWindow);
  }

  healthSnapshot(): WsHealthSnapshot {
    return {
      state: this.state,
      activeEndpoint: this.activeIndex === null ? null : this.endpoints[this.activeIndex].endpoint.label,
      endpoints: this.endpoints.map((e) => ({ ...e.health })),
      reconnectCount: this.reconnectCount,
      backfilledEvents: this.backfilledEvents,
      duplicatesSuppressed: this.duplicatesSuppressed,
      lastEventAt: this.lastEventAt,
      lastCheckpoint: this.lastCheckpoint === null ? null : this.lastCheckpoint.toString(),
    };
  }

  get connectivity(): ConnectivityState {
    return this.state;
  }

  /** Endpoints not currently cooling down, in priority order. */
  private usable(): number[] {
    const now = this.now();
    const open = this.endpoints
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => !isInCooldown(entry.health, now))
      .map(({ index }) => index);
    // If everything is cooling down, still try: a cooldown is pacing, not a fence.
    return open.length > 0 ? open : this.endpoints.map((_, index) => index);
  }

  private noteFailure(index: number, error: unknown): void {
    const entry = this.endpoints[index];
    const failure = classifyRpcFailure({
      message: error instanceof Error ? error.message : String(error),
    });
    entry.health.failureCount += 1;
    entry.health.consecutiveFailures += 1;
    entry.health.lastFailure = failure;
    entry.health.healthy = false;
    entry.health.cooldownUntil = this.now() + cooldownFor(failure, null, entry.health.consecutiveFailures);
    this.options.logger?.warn("ws endpoint failure", {
      endpoint: entry.endpoint.label, // never the URL
      host: entry.endpoint.host,
      failure,
    });
  }

  private clearStallTimer(): void {
    if (this.stallHandle !== null) {
      (this.options.clearTimer ?? clearTimeout)(this.stallHandle as never);
      this.stallHandle = null;
    }
  }

  /**
   * A socket can stay "open" while delivering nothing — a silently dropped subscription
   * looks identical to a quiet chain from the socket's point of view. The timer is what
   * distinguishes them.
   */
  private armStallTimer(): void {
    this.clearStallTimer();
    const set = this.options.setTimer ?? setTimeout;
    this.stallHandle = set(() => {
      if (this.stopped) return;
      this.options.logger?.warn("ws subscription stalled — reconnecting", {
        endpoint: this.activeIndex === null ? null : this.endpoints[this.activeIndex].endpoint.label,
        stallTimeoutMs: this.opts.stallTimeoutMs,
      });
      void this.reconnect("stalled");
    }, this.opts.stallTimeoutMs);
  }

  /**
   * Replay from the durable checkpoint, then advance it.
   *
   * Runs on every connection, including the first, because the gap this closes is exactly
   * the window in which we were not subscribed.
   */
  private async backfillFromCheckpoint(): Promise<void> {
    const from = await this.options.loadCheckpoint();
    const { events, headBlock } = await this.options.backfill(from);

    for (const event of events) {
      if (!this.dedupe.admit(event)) {
        this.duplicatesSuppressed += 1;
        continue;
      }
      this.backfilledEvents += 1;
      await this.options.onObservation(event);
    }

    // Advance only to the head the backfill actually covered. Advancing to a live frame's
    // height would skip anything between the checkpoint and that frame.
    await this.options.saveCheckpoint(headBlock);
    this.lastCheckpoint = headBlock;
  }

  private async handleEvent(event: CanonicalEvent): Promise<void> {
    this.lastEventAt = this.now();
    this.armStallTimer();

    if (!this.dedupe.admit(event)) {
      this.duplicatesSuppressed += 1;
      return;
    }
    await this.options.onObservation(event);
  }

  /** Connect, trying endpoints in priority order; fall back to polling if all fail. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.connectWithFailover();
  }

  private async connectWithFailover(): Promise<void> {
    if (this.stopped) return;
    this.state = "connecting";

    const candidates = this.usable();
    for (const index of candidates) {
      const entry = this.endpoints[index];

      for (let attempt = 0; attempt < this.opts.attemptsPerEndpoint; attempt += 1) {
        if (this.stopped) return;
        try {
          const socket = await this.options.connect(entry.endpoint);
          this.socket = socket;
          this.activeIndex = index;
          entry.health.successCount += 1;
          entry.health.consecutiveFailures = 0;
          entry.health.healthy = true;
          entry.health.cooldownUntil = null;
          entry.health.lastUsedAt = this.now();
          if (index > 0) entry.health.failoverCount += 1;

          socket.onEvent((event) => void this.handleEvent(event));
          socket.onClose((reason) => void this.reconnect(reason));
          socket.onError((error) => {
            this.noteFailure(index, error);
          });

          // Subscribe first, then backfill: the overlap is intentional and the
          // deduplicator absorbs it. The reverse order would leave a gap.
          await this.backfillFromCheckpoint();

          this.state = "live";
          this.armStallTimer();
          return;
        } catch (error) {
          this.noteFailure(index, error);
          if (attempt + 1 < this.opts.attemptsPerEndpoint) {
            await this.delay(
              backoffWithJitter(attempt, this.opts.baseReconnectDelayMs, this.opts.maxReconnectDelayMs, this.random)
            );
          }
        }
      }
    }

    // Every websocket endpoint failed. HTTP still works for reads, so ingestion continues
    // by polling — reported honestly as degraded rather than presented as live.
    this.state = "degraded_polling";
    this.activeIndex = null;
    this.options.logger?.warn("all websocket endpoints failed — falling back to HTTP polling", {
      endpoints: this.endpoints.map((e) => e.endpoint.label),
    });
    if (this.options.poll) await this.options.poll();
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const set = this.options.setTimer ?? setTimeout;
      set(() => resolve(), ms);
    });
  }

  private reconnecting = false;

  /** Single-flight reconnect: concurrent close+stall must not start two subscriptions. */
  private async reconnect(reason: string): Promise<void> {
    if (this.stopped || this.reconnecting) return;
    this.reconnecting = true;
    this.reconnectCount += 1;
    this.clearStallTimer();

    try {
      this.socket?.close();
    } catch {
      /* closing a dead socket is not an error worth surfacing */
    }
    this.socket = null;

    this.options.logger?.info("ws reconnecting", { reason, attempt: this.reconnectCount });
    try {
      await this.connectWithFailover();
    } finally {
      this.reconnecting = false;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearStallTimer();
    try {
      this.socket?.close();
    } catch {
      /* ignore */
    }
    this.socket = null;
    this.state = "stopped";
    this.activeIndex = null;
  }
}
