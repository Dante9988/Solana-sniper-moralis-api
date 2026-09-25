/**
 * Phase 7B.2 — distributed event-bus abstraction (phase7b2.txt §6).
 * `InMemoryEventBus` only delivers within one process (fine for tests and
 * local single-process dev). `RedisEventBus` uses real Redis Pub/Sub so a
 * separate worker process (e.g. `npm run forensics:worker`) can publish an
 * event the API/WebSocket process actually receives — required in any
 * multi-process deployment, which `RealtimeConfig` (../config.ts) enforces
 * by failing closed in production without an explicit backend choice.
 */

import type { Redis as RedisClient } from "ioredis";
import { RealtimeConfig } from "../config";
import { RealtimeEventEnvelope } from "./eventEnvelope";
import { PostgresEventBus, type PgNotifyClient } from "./postgresEventBus";

export type EventBusHandler = (event: RealtimeEventEnvelope) => void;

/**
 * Phase 7D.6 — what a bus can honestly promise a subscriber.
 *
 * `crossProcess` is false for the in-memory bus: publishers in other processes (the candles
 * worker) can never reach it, so a subscriber must not be told its channel is live.
 * `connected` is about right now — a Postgres LISTEN connection that has dropped is
 * reconnecting, and until it is back, updates are genuinely not arriving.
 */
export interface DeliveryCapability {
  readonly crossProcess: boolean;
  readonly connected: boolean;
}

export interface EventBus {
  publish(channel: string, event: RealtimeEventEnvelope): Promise<void>;
  /** Absent on buses that predate the capability; callers treat that as cross-process and connected. */
  describeDelivery?(): DeliveryCapability;
  /** Returns an unsubscribe function. */
  subscribe(channel: string, handler: EventBusHandler): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

export class InMemoryEventBus implements EventBus {
  private readonly handlers = new Map<string, Set<EventBusHandler>>();

  describeDelivery(): DeliveryCapability {
    // Connected, and unable to hear anyone outside this process. Both halves matter: a
    // subscriber told "live" here would wait forever for a worker's event.
    return { crossProcess: false, connected: true };
  }

  async publish(channel: string, event: RealtimeEventEnvelope): Promise<void> {
    const subscribers = this.handlers.get(channel);
    if (!subscribers) return;
    for (const handler of subscribers) handler(event);
  }

  async subscribe(channel: string, handler: EventBusHandler): Promise<() => Promise<void>> {
    let subscribers = this.handlers.get(channel);
    if (!subscribers) {
      subscribers = new Set();
      this.handlers.set(channel, subscribers);
    }
    subscribers.add(handler);
    return async () => {
      subscribers?.delete(handler);
      if (subscribers?.size === 0) this.handlers.delete(channel);
    };
  }

  async close(): Promise<void> {
    this.handlers.clear();
  }
}

export class RedisEventBus implements EventBus {
  // Redis connections used for SUBSCRIBE can't issue any other command, so
  // publishing and subscribing each get their own connection (standard
  // ioredis pattern — see https://github.com/redis/ioredis#pubsub).
  private readonly channelHandlers = new Map<string, Set<EventBusHandler>>();
  private readonly subscribedChannels = new Set<string>();

  describeDelivery(): DeliveryCapability {
    // ioredis reports "ready" once the connection is usable; anything else means messages
    // published right now are not reaching this process.
    return { crossProcess: true, connected: this.subscriber.status === "ready" };
  }

  constructor(private readonly publisher: RedisClient, private readonly subscriber: RedisClient) {
    this.subscriber.on("message", (channel: string, raw: string) => {
      const handlers = this.channelHandlers.get(channel);
      if (!handlers || handlers.size === 0) return;
      let event: RealtimeEventEnvelope;
      try {
        event = JSON.parse(raw);
      } catch {
        return; // malformed payload from a misbehaving publisher — drop, don't crash the process
      }
      for (const handler of handlers) handler(event);
    });
  }

  async publish(channel: string, event: RealtimeEventEnvelope): Promise<void> {
    await this.publisher.publish(channel, JSON.stringify(event));
  }

  async subscribe(channel: string, handler: EventBusHandler): Promise<() => Promise<void>> {
    let handlers = this.channelHandlers.get(channel);
    if (!handlers) {
      handlers = new Set();
      this.channelHandlers.set(channel, handlers);
    }
    handlers.add(handler);

    if (!this.subscribedChannels.has(channel)) {
      this.subscribedChannels.add(channel);
      await this.subscriber.subscribe(channel);
    }

    return async () => {
      handlers?.delete(handler);
      if (handlers?.size === 0) {
        this.channelHandlers.delete(channel);
        this.subscribedChannels.delete(channel);
        await this.subscriber.unsubscribe(channel);
      }
    };
  }

  async close(): Promise<void> {
    this.channelHandlers.clear();
    this.subscribedChannels.clear();
    await Promise.all([this.publisher.quit(), this.subscriber.quit()]);
  }
}

let sharedEventBus: EventBus | undefined;

export function createEventBus(config: RealtimeConfig): EventBus {
  if (config.backend === "memory") return new InMemoryEventBus();

  if (config.backend === "postgres") {
    if (!sharedEventBus) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Client } = require("pg") as typeof import("pg");
      const connectionString = config.databaseUrl;
      const makeClient = () => new Client({ connectionString }) as unknown as PgNotifyClient;
      const publisher = makeClient();
      // The publisher is a plain query connection; connect it eagerly so the first NOTIFY
      // does not pay for a handshake, and never leave a connect failure unlogged.
      void publisher.connect().catch((err: Error) => console.error("[eventBus] Postgres publisher connect failed:", err.message));
      sharedEventBus = new PostgresEventBus(publisher, makeClient);
    }
    return sharedEventBus;
  }

  if (!sharedEventBus) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const IORedis = require("ioredis").default ?? require("ioredis");
    const publisher = new IORedis(config.redisUrl, { lazyConnect: false, maxRetriesPerRequest: 2 });
    const subscriber: RedisClient = publisher.duplicate();
    publisher.on("error", (err: Error) => console.error("[eventBus] Redis publisher error:", err.message));
    subscriber.on("error", (err: Error) => console.error("[eventBus] Redis subscriber error:", err.message));
    sharedEventBus = new RedisEventBus(publisher, subscriber);
  }
  return sharedEventBus;
}
