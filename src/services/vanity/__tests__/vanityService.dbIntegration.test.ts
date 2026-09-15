/**
 * Phase 7D.4 §7 — vanity reservation and handoff on real PostgreSQL. Disposable database only.
 *
 *   PAPER_RUN_DB_TESTS=true DATABASE_URL=postgresql://…/ci_x_test npx vitest run --no-file-parallelism src/services/vanity/__tests__/vanityService.dbIntegration.test.ts
 */
import { PrismaClient } from "@prisma/client";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { consumeReservation, getAvailability, getActiveReservation, releaseReservation, reserveVanityAddress, retireAddresses, VANITY_RESERVATION_TTL_MS } from "../vanityService";

const RUN = process.env.PAPER_RUN_DB_TESTS === "true";
const USER_A = "aaaaaaaa-7d47-4000-8000-00000000000a";
const USER_B = "bbbbbbbb-7d47-4000-8000-00000000000b";
const TEST_SUFFIX = "tst7d47";

describe.skipIf(!RUN)("vanityService — real Postgres", () => {
  const db = new PrismaClient();
  let seq = 0;
  const key = () => `vk-${Date.now()}-${seq++}`;

  async function seed(n: number) {
    const addresses: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const address = bs58.encode(nacl.sign.keyPair().publicKey);
      addresses.push(address);
      await db.vanityAddress.create({ data: { chain: "solana", address, generationType: "ed25519-keypair-suffix", suffix: TEST_SUFFIX, secretRef: `keystore:v1:${address}` } });
    }
    return addresses;
  }
  const cleanup = () => db.vanityAddress.deleteMany({ where: { suffix: TEST_SUFFIX } });
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await db.$disconnect();
  });

  it("reports Robinhood as unsupported and counts only usable Solana stock", async () => {
    await seed(3);
    const rh = await getAvailability(db, "robinhood");
    expect(rh).toMatchObject({ supported: false, available: 0 });
    expect(rh.reason).toMatch(/Pons factory/);
    expect((await getAvailability(db, "solana")).available).toBeGreaterThanOrEqual(3);
    expect(await reserveVanityAddress(db, { userId: USER_A, chain: "robinhood", idempotencyKey: key() })).toMatchObject({ ok: false, code: "UNSUPPORTED_CHAIN" });
  });

  it("reserves idempotently, one live reservation per user, and never exposes the secret reference", async () => {
    await seed(2);
    const k = key();
    const first = await reserveVanityAddress(db, { userId: USER_A, chain: "solana", idempotencyKey: k });
    const replay = await reserveVanityAddress(db, { userId: USER_A, chain: "solana", idempotencyKey: k });
    const otherKey = await reserveVanityAddress(db, { userId: USER_A, chain: "solana", idempotencyKey: key() });
    if (!first.ok || !replay.ok || !otherKey.ok) throw new Error("reserve failed");
    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.value.reservationId).toBe(first.value.reservationId);
    expect(otherKey.value.reservationId).toBe(first.value.reservationId);
    expect(first.value).toMatchObject({ version: 1, chain: "solana", status: "RESERVED", deployed: false, generationType: "ed25519-keypair-suffix" });
    expect(JSON.stringify(first.value)).not.toMatch(/keystore|secret/i);
  });

  it("never hands one address to two concurrent users and refuses when stock is empty", async () => {
    await db.vanityAddress.updateMany({ where: { status: "AVAILABLE" }, data: { status: "RETIRED", retiredReason: "test isolation" } });
    try {
      await seed(3);
      const users = Array.from({ length: 6 }, (_, i) => `cccccccc-7d47-4000-8000-00000000000${i}`);
      const results = await Promise.all(users.map((userId) => reserveVanityAddress(db, { userId, chain: "solana", idempotencyKey: key() })));
      const won = results.filter((r) => r.ok).map((r) => (r.ok ? r.value.address : ""));
      expect(won).toHaveLength(3);
      expect(new Set(won).size).toBe(3);
      expect(results.filter((r) => !r.ok && r.code === "NONE_AVAILABLE")).toHaveLength(3);
    } finally {
      await db.vanityAddress.updateMany({ where: { retiredReason: "test isolation" }, data: { status: "AVAILABLE", retiredReason: null } });
    }
  });

  it("releases back to stock, lets an expired reservation be taken by someone else, and scopes by owner", async () => {
    await db.vanityAddress.updateMany({ where: { status: "AVAILABLE" }, data: { status: "RETIRED", retiredReason: "test isolation" } });
    try {
      await seed(1);
      const a = await reserveVanityAddress(db, { userId: USER_A, chain: "solana", idempotencyKey: key() });
      if (!a.ok) throw new Error(a.message);
      expect(await releaseReservation(db, { userId: USER_B, reservationId: a.value.reservationId })).toMatchObject({ ok: false, code: "NOT_FOUND" });
      expect(await releaseReservation(db, { userId: USER_A, reservationId: a.value.reservationId })).toMatchObject({ ok: true });
      const b = await reserveVanityAddress(db, { userId: USER_B, chain: "solana", idempotencyKey: key() });
      expect(b.ok && b.value.address === a.value.address).toBe(true);

      const later = new Date(Date.now() + VANITY_RESERVATION_TTL_MS + 1000);
      const c = await reserveVanityAddress(db, { userId: USER_A, chain: "solana", idempotencyKey: key(), now: later });
      expect(c.ok && b.ok && c.value.address === b.value.address && c.value.reservationId !== b.value.reservationId).toBe(true);
      expect(await getActiveReservation(db, USER_B, "solana", later)).toBeNull();
    } finally {
      await db.vanityAddress.updateMany({ where: { retiredReason: "test isolation" }, data: { status: "AVAILABLE", retiredReason: null } });
    }
  });

  it("consumes once, idempotently, refuses expired or re-consumed reservations, and a consumed address never returns", async () => {
    await seed(2);
    const a = await reserveVanityAddress(db, { userId: USER_A, chain: "solana", idempotencyKey: key() });
    if (!a.ok) throw new Error(a.message);
    const ck = key();
    const first = await consumeReservation(db, { reservationId: a.value.reservationId, idempotencyKey: ck });
    const replay = await consumeReservation(db, { reservationId: a.value.reservationId, idempotencyKey: ck });
    expect(first.ok && first.created && first.value.status === "CONSUMED" && first.value.secretRef.startsWith("keystore:v1:")).toBe(true);
    expect(replay.ok && replay.created === false).toBe(true);
    expect(await consumeReservation(db, { reservationId: a.value.reservationId, idempotencyKey: key() })).toMatchObject({ ok: false, code: "ALREADY_CONSUMED" });
    expect(await releaseReservation(db, { userId: USER_A, reservationId: a.value.reservationId })).toMatchObject({ ok: false, code: "ALREADY_CONSUMED" });
    expect(await retireAddresses(db, [a.value.address], "exposed")).toBe(0);

    const b = await reserveVanityAddress(db, { userId: USER_B, chain: "solana", idempotencyKey: key() });
    if (!b.ok) throw new Error(b.message);
    expect(b.value.address).not.toBe(a.value.address);
    const late = new Date(Date.now() + VANITY_RESERVATION_TTL_MS + 1000);
    expect(await consumeReservation(db, { reservationId: b.value.reservationId, idempotencyKey: key(), now: late })).toMatchObject({ ok: false, code: "RESERVATION_EXPIRED" });
  });

  it("the database refuses a reserved row without an owner", async () => {
    const [address] = await seed(1);
    await expect(db.vanityAddress.update({ where: { address }, data: { status: "RESERVED" } })).rejects.toThrow();
  });
});
