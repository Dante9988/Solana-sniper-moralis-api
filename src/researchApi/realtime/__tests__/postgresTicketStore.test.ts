import { describe, expect, it, vi } from "vitest";

import { PostgresTicketStore, type TicketDb } from "../ticketStore";

/**
 * Phase 7D.6. `REALTIME_BACKEND=postgres` is the new default, so its ticket store has to hold
 * the same line Redis' `GETDEL` holds: a ticket works exactly once. Falling back to the
 * in-memory store here would have reintroduced the multi-instance hole this phase set out to
 * close, just somewhere quieter.
 */

function makeDb(): TicketDb & { rows: Map<string, { userId: string; expiresAt: Date }>; deletedExpiredBefore: Date[] } {
  const rows = new Map<string, { userId: string; expiresAt: Date }>();
  const deletedExpiredBefore: Date[] = [];
  return {
    rows,
    deletedExpiredBefore,
    realtimeTicket: {
      async create({ data }) {
        rows.set(data.id, { userId: data.userId, expiresAt: data.expiresAt });
        return data;
      },
      async deleteMany({ where }) {
        deletedExpiredBefore.push(where.expiresAt.lt);
        return { count: 0 };
      },
    },
    async $queryRaw<T>(_query: TemplateStringsArray, ...values: unknown[]): Promise<T> {
      // Mirrors `DELETE … RETURNING`: the row is gone whether or not it was still valid.
      const id = values[0] as string;
      const row = rows.get(id);
      rows.delete(id);
      return (row ? [row] : []) as T;
    },
  };
}

describe("PostgresTicketStore", () => {
  it("issues a ticket that consumes to its user", async () => {
    const db = makeDb();
    const store = new PostgresTicketStore(db);
    const ticket = await store.issue("user-a", 45_000);
    expect(await store.consume(ticket)).toEqual({ userId: "user-a" });
  });

  it("consumes exactly once — a replayed ticket gets nothing", async () => {
    const db = makeDb();
    const store = new PostgresTicketStore(db);
    const ticket = await store.issue("user-a", 45_000);
    await store.consume(ticket);
    expect(await store.consume(ticket)).toBeNull();
  });

  it("refuses an expired ticket, and still consumes it", async () => {
    const db = makeDb();
    const store = new PostgresTicketStore(db);
    const ticket = await store.issue("user-a", -1); // already expired
    expect(await store.consume(ticket)).toBeNull();
    // Deleted regardless: an expired ticket left in the table is a ticket someone can keep retrying.
    expect(db.rows.has(ticket)).toBe(false);
  });

  it("returns null for a ticket that never existed", async () => {
    const store = new PostgresTicketStore(makeDb());
    expect(await store.consume("never-issued")).toBeNull();
  });

  it("refuses the upgrade when the database is unavailable, rather than admitting it", async () => {
    const db = makeDb();
    db.$queryRaw = (async () => {
      throw new Error("connection terminated");
    }) as TicketDb["$queryRaw"];
    const store = new PostgresTicketStore(db);
    expect(await store.consume("anything")).toBeNull();
  });

  it("does not let a failed expiry sweep break issuing", async () => {
    const db = makeDb();
    db.realtimeTicket.deleteMany = vi.fn().mockRejectedValue(new Error("statement timeout"));
    const store = new PostgresTicketStore(db);
    await expect(store.issue("user-a", 45_000)).resolves.toBeTypeOf("string");
  });

  it("issues unique tickets", async () => {
    const store = new PostgresTicketStore(makeDb());
    const tickets = await Promise.all(Array.from({ length: 50 }, () => store.issue("user-a", 45_000)));
    expect(new Set(tickets).size).toBe(50);
  });
});
