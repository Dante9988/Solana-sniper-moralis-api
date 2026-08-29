import { describe, expect, it, vi } from "vitest";
import { MemoryTicketStore, RedisTicketStore } from "../realtime/ticketStore";

describe("MemoryTicketStore (phase7b2.txt §4)", () => {
  it("issues a ticket that consume() resolves to the bound userId", async () => {
    const store = new MemoryTicketStore();
    const ticket = await store.issue("user-1", 30_000);
    await expect(store.consume(ticket)).resolves.toEqual({ userId: "user-1" });
  });

  it("is single-use: a second consume of the same ticket returns null", async () => {
    const store = new MemoryTicketStore();
    const ticket = await store.issue("user-1", 30_000);
    await store.consume(ticket);
    await expect(store.consume(ticket)).resolves.toBeNull();
  });

  it("rejects an unknown ticket", async () => {
    const store = new MemoryTicketStore();
    await expect(store.consume("never-issued")).resolves.toBeNull();
  });

  it("rejects an expired ticket, and still burns it (single-use even when expired)", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryTicketStore();
      const ticket = await store.issue("user-1", 1_000);
      vi.advanceTimersByTime(1_001);
      await expect(store.consume(ticket)).resolves.toBeNull();
      await expect(store.consume(ticket)).resolves.toBeNull(); // still null the second time, not "already knows it's gone" vs a different reason
    } finally {
      vi.useRealTimers();
    }
  });

  it("two different tickets for the same user are independent", async () => {
    const store = new MemoryTicketStore();
    const t1 = await store.issue("user-1", 30_000);
    const t2 = await store.issue("user-1", 30_000);
    expect(t1).not.toBe(t2);
    await expect(store.consume(t1)).resolves.toEqual({ userId: "user-1" });
    await expect(store.consume(t2)).resolves.toEqual({ userId: "user-1" });
  });
});

describe("RedisTicketStore (mocked ioredis client — never a live Redis connection, phase7b2.txt §11)", () => {
  function fakeRedis() {
    const store = new Map<string, string>();
    return {
      set: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
        return "OK";
      }),
      getdel: vi.fn(async (key: string) => {
        const value = store.get(key);
        store.delete(key);
        return value ?? null;
      }),
    };
  }

  it("issue() SETs a key, consume() atomically GETDELs it", async () => {
    const redis = fakeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = new RedisTicketStore(redis as any);
    const ticket = await store.issue("user-1", 45_000);
    expect(redis.set).toHaveBeenCalledWith(`wsticket:${ticket}`, JSON.stringify({ userId: "user-1" }), "PX", 45_000);

    const payload = await store.consume(ticket);
    expect(payload).toEqual({ userId: "user-1" });
    expect(redis.getdel).toHaveBeenCalledWith(`wsticket:${ticket}`);
  });

  it("is single-use — GETDEL only ever returns the value once, from Redis's own semantics", async () => {
    const redis = fakeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = new RedisTicketStore(redis as any);
    const ticket = await store.issue("user-1", 45_000);
    await store.consume(ticket);
    await expect(store.consume(ticket)).resolves.toBeNull();
  });

  it("returns null for a value that fails to parse as JSON rather than throwing", async () => {
    const redis = { set: vi.fn(), getdel: vi.fn(async () => "not-json") };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = new RedisTicketStore(redis as any);
    await expect(store.consume("whatever")).resolves.toBeNull();
  });
});
