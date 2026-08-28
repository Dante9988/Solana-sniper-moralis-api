/**
 * Phase 7B.2 — single-use, short-lived WebSocket connection tickets
 * (phase7b2.txt §4). A ticket is issued by an authenticated REST call
 * (`POST /api/v1/realtime/tickets`) and consumed exactly once by the
 * WebSocket upgrade — never reusable as REST authentication, never a
 * Supabase JWT itself. `MemoryTicketStore` only works within one process;
 * `RedisTicketStore` (atomic `GETDEL`) is required in any multi-instance
 * production deployment — see ../config.ts's `RealtimeConfig` for the
 * fail-closed rule.
 */

import { randomBytes } from "node:crypto";
import type { Redis as RedisClient } from "ioredis";
import { RealtimeConfig } from "../config";

export interface TicketPayload {
  userId: string;
}

export interface TicketStore {
  /** Issues a new random ticket bound to `userId`, valid for `ttlMs`. */
  issue(userId: string, ttlMs: number): Promise<string>;
  /** Atomically looks up AND deletes the ticket — a second call for the same ticket always returns null, even concurrently. */
  consume(ticket: string): Promise<TicketPayload | null>;
}

function randomTicket(): string {
  return randomBytes(24).toString("base64url");
}

export class MemoryTicketStore implements TicketStore {
  private readonly tickets = new Map<string, { payload: TicketPayload; expiresAt: number }>();

  async issue(userId: string, ttlMs: number): Promise<string> {
    const ticket = randomTicket();
    this.tickets.set(ticket, { payload: { userId }, expiresAt: Date.now() + ttlMs });
    return ticket;
  }

  async consume(ticket: string): Promise<TicketPayload | null> {
    const entry = this.tickets.get(ticket);
    this.tickets.delete(ticket); // delete unconditionally — a ticket is single-use even if expired/never valid
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) return null;
    return entry.payload;
  }
}

export class RedisTicketStore implements TicketStore {
  constructor(private readonly redis: RedisClient) {}

  private key(ticket: string): string {
    return `wsticket:${ticket}`;
  }

  async issue(userId: string, ttlMs: number): Promise<string> {
    const ticket = randomTicket();
    const payload: TicketPayload = { userId };
    await this.redis.set(this.key(ticket), JSON.stringify(payload), "PX", ttlMs);
    return ticket;
  }

  async consume(ticket: string): Promise<TicketPayload | null> {
    // GETDEL is a single atomic Redis command — the same ticket can never be
    // consumed twice, even by two upgrade requests racing each other.
    const raw = await this.redis.getdel(this.key(ticket));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as TicketPayload;
    } catch {
      return null;
    }
  }
}

let sharedTicketRedisClient: RedisClient | undefined;

export function createTicketStore(config: RealtimeConfig): TicketStore {
  if (config.backend === "memory") return new MemoryTicketStore();

  if (!sharedTicketRedisClient) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const IORedis = require("ioredis").default ?? require("ioredis");
    const client: RedisClient = new IORedis(config.redisUrl, { lazyConnect: false, maxRetriesPerRequest: 2 });
    client.on("error", (err: Error) => console.error("[ticketStore] Redis error:", err.message));
    sharedTicketRedisClient = client;
  }
  return new RedisTicketStore(sharedTicketRedisClient);
}
