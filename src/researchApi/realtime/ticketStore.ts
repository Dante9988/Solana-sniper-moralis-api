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

/**
 * Phase 7D.6 — the Postgres backend's ticket store.
 *
 * `DELETE … RETURNING` is a single statement, so two upgrade requests racing on the same
 * ticket cannot both be handed a payload — the same single-use guarantee Redis gets from
 * `GETDEL`, without needing Redis. Expiry is checked on the row we deleted rather than in the
 * `WHERE`, so an expired ticket is still consumed (and refused) rather than left behind for a
 * later attempt.
 */
export class PostgresTicketStore implements TicketStore {
  constructor(private readonly db: TicketDb) {}

  async issue(userId: string, ttlMs: number): Promise<string> {
    const ticket = randomTicket();
    await this.db.realtimeTicket.create({ data: { id: ticket, userId, expiresAt: new Date(Date.now() + ttlMs) } });
    // Opportunistic: tickets live ~45s, so anything long past its expiry is dead weight. Cheap
    // on the expiresAt index, and it keeps the table from needing its own cron.
    void this.db.realtimeTicket
      .deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 60_000) } } })
      .catch(() => undefined);
    return ticket;
  }

  async consume(ticket: string): Promise<TicketPayload | null> {
    let row: { userId: string; expiresAt: Date } | null = null;
    try {
      const deleted = await this.db.$queryRaw<Array<{ userId: string; expiresAt: Date }>>`
        DELETE FROM "RealtimeTicket" WHERE id = ${ticket} RETURNING "userId", "expiresAt"`;
      row = deleted[0] ?? null;
    } catch {
      return null; // an unavailable database must refuse the upgrade, never admit it
    }
    if (!row) return null;
    if (row.expiresAt.getTime() <= Date.now()) return null;
    return { userId: row.userId };
  }
}

/** The slice of PrismaClient this store needs — narrow so a test can supply a fake. */
export interface TicketDb {
  realtimeTicket: {
    create(args: { data: { id: string; userId: string; expiresAt: Date } }): Promise<unknown>;
    deleteMany(args: { where: { expiresAt: { lt: Date } } }): Promise<unknown>;
  };
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

let sharedTicketRedisClient: RedisClient | undefined;

export function createTicketStore(config: RealtimeConfig, db?: TicketDb): TicketStore {
  if (config.backend === "memory") return new MemoryTicketStore();

  if (config.backend === "postgres") {
    if (!db) throw new Error("REALTIME_BACKEND=postgres requires a Prisma client to back the ticket store");
    return new PostgresTicketStore(db);
  }

  if (!sharedTicketRedisClient) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const IORedis = require("ioredis").default ?? require("ioredis");
    const client: RedisClient = new IORedis(config.redisUrl, { lazyConnect: false, maxRetriesPerRequest: 2 });
    client.on("error", (err: Error) => console.error("[ticketStore] Redis error:", err.message));
    sharedTicketRedisClient = client;
  }
  return new RedisTicketStore(sharedTicketRedisClient);
}
