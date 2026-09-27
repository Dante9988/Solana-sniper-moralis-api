/**
 * Phase 7E.4.3 §18 (Postgres integration) — token upsert, duplicate CreateEvent, duplicate
 * TradeEvent, restart/replay, lifecycle transition, canonical trade persistence.
 *
 * Against real Postgres, because every claim here is a claim about database constraints. §6 is
 * explicit that "Database uniqueness should make duplicate processing harmless" and that the
 * listener must not "rely only on an in-memory Set" — an in-memory mock would let a broken
 * constraint pass this file unnoticed.
 *
 * Opt-in, following the convention the existing dbIntegration tests set:
 *   SOLANA_RUN_DB_TESTS=true DATABASE_URL=postgresql://... npx vitest run src/solana/__tests__/pumpfunPersistence.dbIntegration.test.ts
 */

import fs from "fs";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { findEvents } from "../../pump/eventWalker";
import type { RawTransactionLike } from "../../pump/eventWalker";
import { decodePumpfunTransaction } from "../pumpfunDecode";
import type { DecodedPumpfunBatch } from "../pumpfunDecode";
import { persistPumpfunBatch } from "../pumpfunPersistence";

const RUN_DB_TESTS = process.env.SOLANA_RUN_DB_TESTS === "true";

const FIXTURES = path.join(__dirname, "../../pump/__tests__/fixtures/mainnet");
const CREATE_FIXTURE = "pump_create_and_dev_buy_with_completion.json";
const MIGRATE_FIXTURE = "pump_migrate_v2_atomic_pool_creation.json";
/** A real PumpSwap Buy against the SAME mint CREATE_FIXTURE launches. */
const PUMPSWAP_BUY_FIXTURE = "pumpswap_buy.json";
const WSOL = "So11111111111111111111111111111111111111112";

const CHAIN = "solana";
const MINT = "bKU4TGmXxaMmcjL2htnSKfRT9Voig9KmPvo8Scupump";
const SLOT = 444127554;
const BLOCKHASH = "TestBlockhash1111111111111111111111111111111";
const BLOCK_TIME = 1788487825;

function loadFixture(name: string): RawTransactionLike {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8")).result as RawTransactionLike;
}

function batchFor(fixture: string, confidence: "provisional" | "final" = "provisional"): DecodedPumpfunBatch {
  return decodePumpfunTransaction({
    tx: loadFixture(fixture),
    block: { slot: SLOT, blockhash: BLOCKHASH, blockTime: BLOCK_TIME },
    observedAt: new Date().toISOString(),
    confidence,
    decimals: new Map([
      [MINT, 6],
      ["11111111111111111111111111111111", 9],
      ["So11111111111111111111111111111111111111112", 9],
    ]),
  });
}

describe.skipIf(!RUN_DB_TESTS)("Pump.fun persistence — real Postgres", () => {
  const prisma = new PrismaClient();

  /** Every mint any fixture in this file touches, so cleanup cannot leave a row behind. */
  const mints = new Set<string>();

  async function cleanup(): Promise<void> {
    for (const fixture of [CREATE_FIXTURE, MIGRATE_FIXTURE, PUMPSWAP_BUY_FIXTURE]) {
      for (const batch of [batchFor(fixture)]) {
        for (const row of [...batch.discovered, ...batch.trades, ...batch.lifecycle]) mints.add(row.tokenAddress);
      }
    }
    const list = [...mints];
    await prisma.chainTrade.deleteMany({ where: { chain: CHAIN, tokenAddress: { in: list } } });
    await prisma.discoveredToken.deleteMany({ where: { chain: CHAIN, tokenAddress: { in: list } } });
    await prisma.pumpLifecycleEvent.deleteMany({ where: { mint: { in: list } } });
    await prisma.tokenLifecycleState.deleteMany({ where: { mint: { in: list } } });
    await prisma.tokenMarketSnapshot.deleteMany({ where: { chain: CHAIN, tokenAddress: { in: list } } });
  }

  beforeAll(cleanup);
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("persists the token, its dev buy and both lifecycle events from one real transaction", async () => {
    const result = await persistPumpfunBatch({ db: prisma, batch: batchFor(CREATE_FIXTURE), source: "live stream" });

    expect(result.tokensCreated).toBe(1);
    expect(result.tradesPersisted).toBe(1);
    expect(result.lifecyclePersisted).toBe(2);
    expect(result.skippedIncomplete).toBe(0);

    const token = await prisma.discoveredToken.findUnique({ where: { chain_tokenAddress: { chain: CHAIN, tokenAddress: MINT } } });
    expect(token).not.toBeNull();
    expect(token!.venue).toBe("pumpfun");
    expect(token!.tokenDecimals).toBe(6);
    expect(token!.quoteDecimals).toBe(9);
    expect(token!.enrichmentStatus).toBe("COMPLETE");
    expect(token!.name).toBeTruthy();
    expect(token!.symbol).toBeTruthy();
    expect(token!.curveAddress).toBeTruthy();
    expect(token!.sourceHeight).toBe(BigInt(SLOT));
    expect(token!.sourceHash).toBe(BLOCKHASH);
    expect(token!.canonicalStatus).toBe("CANONICAL");

    const trades = await prisma.chainTrade.findMany({ where: { chain: CHAIN, tokenAddress: MINT } });
    expect(trades).toHaveLength(1);
    expect(trades[0].side).toBe("buy");
    expect(trades[0].venue).toBe("pump");
    // The real chain time for the slot, which is what a candle bucket is derived from.
    expect(trades[0].sourceTimestamp?.getTime()).toBe(BLOCK_TIME * 1000);
    expect(trades[0].quoteAmount.toFixed()).toMatch(/^\d+$/);
  });

  it("is idempotent across a replay: the same transaction twice writes nothing new", async () => {
    const first = await persistPumpfunBatch({ db: prisma, batch: batchFor(CREATE_FIXTURE), source: "live stream" });
    // Exactly what a duplicate WebSocket frame, or a recovery sweep re-walking the boundary slot,
    // produces. The second pass must be inert.
    const second = await persistPumpfunBatch({ db: prisma, batch: batchFor(CREATE_FIXTURE), source: "historical backfill" });

    expect(first.tokensCreated).toBe(1);
    expect(second.tokensCreated).toBe(0);
    expect(second.tradesPersisted).toBe(0);
    expect(second.tradesDuplicate).toBe(1);
    expect(second.lifecyclePersisted).toBe(0);
    expect(second.lifecycleDuplicate).toBe(2);

    expect(await prisma.chainTrade.count({ where: { chain: CHAIN, tokenAddress: MINT } })).toBe(1);
    expect(await prisma.discoveredToken.count({ where: { chain: CHAIN, tokenAddress: MINT } })).toBe(1);
    expect(await prisma.pumpLifecycleEvent.count({ where: { mint: MINT } })).toBe(2);
  });

  it("survives a restart: five replays leave exactly one of everything", async () => {
    for (let i = 0; i < 5; i += 1) {
      await persistPumpfunBatch({ db: prisma, batch: batchFor(CREATE_FIXTURE), source: i === 0 ? "live stream" : "block reconciliation" });
    }
    expect(await prisma.chainTrade.count({ where: { chain: CHAIN, tokenAddress: MINT } })).toBe(1);
    expect(await prisma.pumpLifecycleEvent.count({ where: { mint: MINT } })).toBe(2);
    expect(await prisma.discoveredToken.count({ where: { chain: CHAIN, tokenAddress: MINT } })).toBe(1);
  });

  it("does not let a replayed CreateEvent rewrite the token's origin", async () => {
    await persistPumpfunBatch({ db: prisma, batch: batchFor(CREATE_FIXTURE), source: "live stream" });
    const before = await prisma.discoveredToken.findUniqueOrThrow({ where: { chain_tokenAddress: { chain: CHAIN, tokenAddress: MINT } } });

    // A later observation of the same create, reported from a different block identity (which is
    // what a confused reader would produce). First-observation provenance must win.
    const replayed = decodePumpfunTransaction({
      tx: loadFixture(CREATE_FIXTURE),
      block: { slot: SLOT + 1_000, blockhash: "DifferentBlockhash111111111111111111111111", blockTime: BLOCK_TIME + 400 },
      observedAt: new Date().toISOString(),
      confidence: "final",
      decimals: new Map([[MINT, 6], ["11111111111111111111111111111111", 9]]),
    });
    await persistPumpfunBatch({ db: prisma, batch: replayed, source: "historical backfill" });

    const after = await prisma.discoveredToken.findUniqueOrThrow({ where: { chain_tokenAddress: { chain: CHAIN, tokenAddress: MINT } } });
    expect(after.sourceHeight).toBe(before.sourceHeight);
    expect(after.sourceHash).toBe(before.sourceHash);
    expect(after.sourceTxHash).toBe(before.sourceTxHash);
    expect(after.deployer).toBe(before.deployer);
  });

  it("fills in decimals a failed read left null, without touching anything else", async () => {
    const withoutDecimals = decodePumpfunTransaction({
      tx: loadFixture(CREATE_FIXTURE),
      block: { slot: SLOT, blockhash: BLOCKHASH, blockTime: BLOCK_TIME },
      observedAt: new Date().toISOString(),
      confidence: "provisional",
      decimals: new Map(),
    });
    await persistPumpfunBatch({ db: prisma, batch: withoutDecimals, source: "live stream" });

    const partial = await prisma.discoveredToken.findUniqueOrThrow({ where: { chain_tokenAddress: { chain: CHAIN, tokenAddress: MINT } } });
    expect(partial.tokenDecimals).toBeNull();
    // PENDING, so it is retried — and so the candle feed fails closed rather than guessing.
    expect(partial.enrichmentStatus).toBe("PENDING");

    await persistPumpfunBatch({ db: prisma, batch: batchFor(CREATE_FIXTURE), source: "block reconciliation" });
    const completed = await prisma.discoveredToken.findUniqueOrThrow({ where: { chain_tokenAddress: { chain: CHAIN, tokenAddress: MINT } } });
    expect(completed.tokenDecimals).toBe(6);
    expect(completed.quoteDecimals).toBe(9);
    expect(completed.enrichmentStatus).toBe("COMPLETE");
  });

  it("records bonding_complete without claiming graduation", async () => {
    await persistPumpfunBatch({ db: prisma, batch: batchFor(CREATE_FIXTURE), source: "live stream" });

    const state = await prisma.tokenLifecycleState.findUniqueOrThrow({ where: { mint: MINT } });
    // The curve finished in this very transaction, but nothing named a destination pool.
    expect(state.state).toBe("bonding_complete");
    expect(state.pumpswapPool).toBeNull();
    expect(state.bondingCurve).toBeTruthy();

    const token = await prisma.discoveredToken.findUniqueOrThrow({ where: { chain_tokenAddress: { chain: CHAIN, tokenAddress: MINT } } });
    // `graduated` is the field the API and frontend read. CompleteEvent must never set it.
    expect(token.graduated).toBe(false);

    const events = await prisma.pumpLifecycleEvent.findMany({ where: { mint: MINT }, orderBy: { eventType: "asc" } });
    expect(events.map((e) => e.eventType)).toEqual(["completed", "created"]);
    for (const event of events) {
      expect(event.status).toBe("provisional");
      expect(event.blockTime.getTime()).toBe(BLOCK_TIME * 1000);
    }
    expect(events.find((e) => e.eventType === "completed")!.poolAddress).toBeNull();
  });

  it("advances to pumpswap only when an event proves the destination pool", async () => {
    const migration = batchFor(MIGRATE_FIXTURE, "final");
    const transition = migration.lifecycle.find((l) => l.phase === "pumpswap")!;
    await persistPumpfunBatch({ db: prisma, batch: migration, source: "live stream" });

    const state = await prisma.tokenLifecycleState.findUniqueOrThrow({ where: { mint: transition.tokenAddress } });
    expect(state.state).toBe("pumpswap");
    expect(state.pumpswapPool).toBe(transition.destinationPool);

    const event = await prisma.pumpLifecycleEvent.findFirstOrThrow({ where: { mint: transition.tokenAddress, eventType: "pumpswap_pool_created" } });
    expect(event.poolAddress).toBe(transition.destinationPool);
    expect(event.status).toBe("final");
    // §13's contract: a later social consumer can act on the stored payload with no RPC call.
    const payload = event.payload as Record<string, unknown>;
    expect(payload.chain).toBe("solana");
    expect(payload.launchpad).toBe("pumpfun");
    expect(payload.sourceVenue).toBe("pump");
    expect(payload.destinationVenue).toBe("pumpswap");
    expect(payload.destinationPool).toBe(transition.destinationPool);
    expect(payload.solAmount).toMatch(/^\d+$/);
  });

  it("never drags lifecycle state backwards when recovery replays an older event", async () => {
    const migration = batchFor(MIGRATE_FIXTURE, "final");
    const mint = migration.lifecycle.find((l) => l.phase === "pumpswap")!.tokenAddress;
    await persistPumpfunBatch({ db: prisma, batch: migration, source: "live stream" });
    expect((await prisma.tokenLifecycleState.findUniqueOrThrow({ where: { mint } })).state).toBe("pumpswap");

    // Recovery legitimately walks history and can hand us this token's much older create.
    const older = {
      ...batchFor(CREATE_FIXTURE),
      lifecycle: batchFor(CREATE_FIXTURE).lifecycle.map((l) => ({
        ...l,
        tokenAddress: mint,
        phase: "bonding_curve" as const,
        eventType: "created",
        provenance: { ...l.provenance, sourceHeight: "1", sourceTxHash: `older-${l.provenance.sourceIndex}` },
      })),
      discovered: [],
      trades: [],
    };
    await persistPumpfunBatch({ db: prisma, batch: older, source: "historical backfill" });

    const state = await prisma.tokenLifecycleState.findUniqueOrThrow({ where: { mint } });
    expect(state.state).toBe("pumpswap");
    expect(state.pumpswapPool).not.toBeNull();
  });

  it("counts a trade whose token was never discovered instead of storing it half-interpretable", async () => {
    const tradeOnly = { ...batchFor(CREATE_FIXTURE), discovered: [], lifecycle: [] };
    const result = await persistPumpfunBatch({ db: prisma, batch: tradeOnly, source: "live stream" });

    expect(result.tradesPersisted).toBe(0);
    // Visible in the counters, not silently discarded — nothing downstream can price a trade whose
    // token has no verified decimals.
    expect(result.tradesForUnknownToken).toBe(1);
    expect(await prisma.chainTrade.count({ where: { chain: CHAIN, tokenAddress: MINT } })).toBe(0);
  });

  it("refuses to write a fact with no chain time rather than inventing one", async () => {
    const noBlockTime = decodePumpfunTransaction({
      tx: loadFixture(CREATE_FIXTURE),
      block: { slot: SLOT, blockhash: BLOCKHASH, blockTime: null },
      observedAt: new Date().toISOString(),
      confidence: "provisional",
      decimals: new Map([[MINT, 6], ["11111111111111111111111111111111", 9]]),
    });
    const result = await persistPumpfunBatch({ db: prisma, batch: noBlockTime, source: "live stream" });

    // The token is still discovered — that needs no block time. The trade and lifecycle rows are not.
    expect(result.tokensCreated).toBe(1);
    expect(result.tradesPersisted).toBe(0);
    expect(result.lifecyclePersisted).toBe(0);
    expect(result.skippedIncomplete).toBe(3);
    expect(await prisma.chainTrade.count({ where: { chain: CHAIN, tokenAddress: MINT } })).toBe(0);
  });

  it("stores two events from one outer instruction as two distinct rows", async () => {
    // The packed sourceIndex under test: this fixture's buy emits TradeEvent and CompleteEvent under
    // the same outer instruction. A truncated index would silently store only one of them.
    const events = findEvents(loadFixture(CREATE_FIXTURE));
    const sharedOuter = events.filter((e) => e.eventName !== "CreateEvent").map((e) => e.outerInstructionIndex);
    expect(new Set(sharedOuter).size).toBe(1);

    await persistPumpfunBatch({ db: prisma, batch: batchFor(CREATE_FIXTURE), source: "live stream" });
    const rows = await prisma.pumpLifecycleEvent.findMany({ where: { mint: MINT } });
    const trade = await prisma.chainTrade.findFirstOrThrow({ where: { chain: CHAIN, tokenAddress: MINT } });
    const completed = rows.find((r) => r.eventType === "completed")!;
    expect(trade.sourceIndex).not.toBe(
      completed.outerInstructionIndex * 4096 + completed.innerPosition + 1
    );
  });

  it("keeps ONE token row across both venues — a migrated token is not a new token", async () => {
    // Two real mainnet transactions for mint bKU4TGm…Scupump: its bonding-curve launch, and a
    // PumpSwap trade of it. §4/§14: only venue and lifecycle change.
    await persistPumpfunBatch({ db: prisma, batch: batchFor(CREATE_FIXTURE), source: "live stream" });
    const pool = await persistPumpfunBatch({ db: prisma, batch: batchFor(PUMPSWAP_BUY_FIXTURE), source: "live stream" });

    expect(pool.tokensCreated).toBe(0);
    expect(pool.tradesPersisted).toBeGreaterThan(0);
    expect(await prisma.discoveredToken.count({ where: { chain: CHAIN, tokenAddress: MINT } })).toBe(1);

    const trades = await prisma.chainTrade.findMany({ where: { chain: CHAIN, tokenAddress: MINT }, orderBy: { venue: "asc" } });
    expect(trades.map((t) => t.venue)).toEqual(["pump", "pumpswap"]);
    // Both trades hang off the same token address; the pool one names its pool, the curve one cannot.
    expect(trades.find((t) => t.venue === "pumpswap")!.poolAddress).toBe("D3XknHGytS2yLQNxAJ5EcMjEAT11JKRY6EM5E4jNwFPF");
    expect(trades.find((t) => t.venue === "pump")!.poolAddress).toBeNull();
  });

  it("does not graduate a token because PumpSwap trades appeared", async () => {
    await persistPumpfunBatch({ db: prisma, batch: batchFor(CREATE_FIXTURE), source: "live stream" });
    const before = await prisma.tokenLifecycleState.findUniqueOrThrow({ where: { mint: MINT } });

    const result = await persistPumpfunBatch({ db: prisma, batch: batchFor(PUMPSWAP_BUY_FIXTURE), source: "live stream" });

    const after = await prisma.tokenLifecycleState.findUniqueOrThrow({ where: { mint: MINT } });
    // Unchanged. Graduation comes only from a migration event that named a pool.
    expect(after.state).toBe(before.state);
    expect(after.pumpswapPool).toBeNull();
    expect((await prisma.discoveredToken.findUniqueOrThrow({ where: { chain_tokenAddress: { chain: CHAIN, tokenAddress: MINT } } })).graduated).toBe(false);
    // The discrepancy is reported rather than resolved by inference.
    expect(result.pumpSwapTradesWithoutGraduation).toBeGreaterThan(0);
    expect(result.lifecyclePersisted).toBe(0);
  });

  it("stops counting the discrepancy once a migration event has proven the pool", async () => {
    const migration = batchFor(MIGRATE_FIXTURE, "final");
    const graduatedMint = migration.lifecycle.find((l) => l.phase === "pumpswap")!.tokenAddress;
    await persistPumpfunBatch({ db: prisma, batch: migration, source: "live stream" });

    // A PumpSwap trade of that now-proven-graduated mint.
    const trade = { ...batchFor(PUMPSWAP_BUY_FIXTURE).trades[0], tokenAddress: graduatedMint };
    await prisma.discoveredToken.create({
      data: {
        chain: CHAIN, venue: "pumpfun", tokenAddress: graduatedMint, deployer: "d", quoteAddress: WSOL,
        supply: "1", initialBuyAmount: "0", tokenDecimals: 6, quoteDecimals: 9,
        sourceHeight: 1n, sourceHash: "h", sourceTxHash: "grad-create", sourceIndex: 0,
      },
    });
    const result = await persistPumpfunBatch({
      db: prisma,
      batch: { ...batchFor(PUMPSWAP_BUY_FIXTURE), discovered: [], lifecycle: [], trades: [trade] },
      source: "live stream",
    });

    expect(result.tradesPersisted).toBe(1);
    expect(result.pumpSwapTradesWithoutGraduation).toBe(0);
  });

  it("refuses a trade whose quote asset has a different decimal scale than the token's", async () => {
    await persistPumpfunBatch({ db: prisma, batch: batchFor(CREATE_FIXTURE), source: "live stream" });
    const tradesBefore = await prisma.chainTrade.count({ where: { chain: CHAIN, tokenAddress: MINT } });

    // A PumpSwap pool quoted in a 6-decimal asset — a real shape on mainnet. The token's row says 9.
    const base = batchFor(PUMPSWAP_BUY_FIXTURE).trades[0];
    const result = await persistPumpfunBatch({
      db: prisma,
      batch: {
        ...batchFor(PUMPSWAP_BUY_FIXTURE),
        discovered: [],
        lifecycle: [],
        trades: [{ ...base, quoteAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", quoteDecimals: 6 }],
      },
      source: "live stream",
    });

    // Refused, not stored: the aggregator would have valued it at the token's 9-decimal scale and
    // reported a figure a thousand times too small.
    expect(result.tradesQuoteScaleMismatch).toBe(1);
    expect(result.tradesPersisted).toBe(0);
    expect(await prisma.chainTrade.count({ where: { chain: CHAIN, tokenAddress: MINT } })).toBe(tradesBefore);
  });

  it("accepts wrapped SOL against a native-SOL token row — same asset, same scale", async () => {
    // This is the normal graduated case and must NOT be refused: the curve reports the native
    // sentinel as its quote mint, the PumpSwap pool reports wrapped SOL. Different address, both 9.
    await persistPumpfunBatch({ db: prisma, batch: batchFor(CREATE_FIXTURE), source: "live stream" });
    const token = await prisma.discoveredToken.findUniqueOrThrow({ where: { chain_tokenAddress: { chain: CHAIN, tokenAddress: MINT } } });
    expect(token.quoteAddress).toBe("11111111111111111111111111111111");
    expect(token.quoteDecimals).toBe(9);

    const result = await persistPumpfunBatch({ db: prisma, batch: batchFor(PUMPSWAP_BUY_FIXTURE), source: "live stream" });
    expect(result.tradesQuoteScaleMismatch).toBe(0);
    expect(result.tradesPersisted).toBe(1);
    const pumpswap = await prisma.chainTrade.findFirstOrThrow({ where: { chain: CHAIN, tokenAddress: MINT, venue: "pumpswap" } });
    expect(pumpswap.quoteAddress).toBe(WSOL);
  });

  it("is idempotent for PumpSwap trades too", async () => {
    await persistPumpfunBatch({ db: prisma, batch: batchFor(CREATE_FIXTURE), source: "live stream" });
    const first = await persistPumpfunBatch({ db: prisma, batch: batchFor(PUMPSWAP_BUY_FIXTURE), source: "live stream" });
    const second = await persistPumpfunBatch({ db: prisma, batch: batchFor(PUMPSWAP_BUY_FIXTURE), source: "historical backfill" });
    expect(first.tradesPersisted).toBe(1);
    expect(second.tradesPersisted).toBe(0);
    expect(second.tradesDuplicate).toBe(1);
    expect(await prisma.chainTrade.count({ where: { chain: CHAIN, tokenAddress: MINT, venue: "pumpswap" } })).toBe(1);
  });

  describe("Phase 7E.4.4 — market snapshot from the trade's own curve/pool state", () => {
    function batchAt(fixture: string, slot: number): DecodedPumpfunBatch {
      return decodePumpfunTransaction({
        tx: loadFixture(fixture),
        block: { slot, blockhash: BLOCKHASH, blockTime: BLOCK_TIME },
        observedAt: new Date().toISOString(),
        confidence: "provisional",
        decimals: new Map([[MINT, 6], ["11111111111111111111111111111111", 9], [WSOL, 9]]),
      });
    }
    const snapshot = () => prisma.tokenMarketSnapshot.findUnique({ where: { chain_tokenAddress: { chain: CHAIN, tokenAddress: MINT } } });

    it("writes the curve state with the trade, and marks a sold-out curve ready — not graduated", async () => {
      const result = await persistPumpfunBatch({ db: prisma, batch: batchAt(CREATE_FIXTURE, SLOT), source: "live stream" });
      expect(result.marketSnapshotsWritten).toBe(1);
      const s = await snapshot();
      expect(s!.status).toBe("OK");
      expect(s!.venue).toBe("PUMPFUN_BONDING_CURVE");
      expect(s!.bondingProgressBps).toBe(10_000);
      expect(s!.quoteRaised!.toFixed()).toBe("85005359057");
      expect(s!.liquidityQuote!.toFixed()).toBe("85005359057");
      expect(s!.readyToGraduate).toBe(true);
      expect(s!.graduated).toBe(false);
      // No USD anywhere: there is no trusted SOL/USD rate.
      expect(s!.priceUsd).toBeNull();
      expect(s!.marketCapUsd).toBeNull();
      expect(s!.liquidityUsd).toBeNull();
      const token = await prisma.discoveredToken.findUnique({ where: { chain_tokenAddress: { chain: CHAIN, tokenAddress: MINT } } });
      expect(token!.graduated).toBe(false);
    });

    it("graduates the SAME token only on the proven migration, with its pool", async () => {
      await persistPumpfunBatch({ db: prisma, batch: batchAt(CREATE_FIXTURE, SLOT), source: "live stream" });
      await persistPumpfunBatch({ db: prisma, batch: batchAt(MIGRATE_FIXTURE, SLOT + 1), source: "live stream" });
      const token = await prisma.discoveredToken.findUnique({ where: { chain_tokenAddress: { chain: CHAIN, tokenAddress: MINT } } });
      const state = await prisma.tokenLifecycleState.findUnique({ where: { mint: MINT } });
      expect(state!.state).toBe("pumpswap");
      expect(token!.graduated).toBe(true);
      expect(token!.poolAddress).toBe(state!.pumpswapPool);
      expect((await snapshot())!.graduated).toBe(true);
      expect(await prisma.discoveredToken.count({ where: { chain: CHAIN, tokenAddress: MINT } })).toBe(1);
    });

    it("moves to the pool's post-trade state on a later PumpSwap trade, and an older replay cannot roll it back", async () => {
      await persistPumpfunBatch({ db: prisma, batch: batchAt(CREATE_FIXTURE, SLOT), source: "live stream" });
      await persistPumpfunBatch({ db: prisma, batch: batchAt(PUMPSWAP_BUY_FIXTURE, SLOT + 10), source: "live stream" });
      let s = await snapshot();
      expect(s!.venue).toBe("PUMPSWAP_POOL");
      expect(s!.liquidityQuote!.toFixed()).toBe("10482126905280");
      // The last curve progress survives a pool trade rather than being erased.
      expect(s!.bondingProgressBps).toBe(10_000);

      const replay = await persistPumpfunBatch({ db: prisma, batch: batchAt(CREATE_FIXTURE, SLOT), source: "historical backfill" });
      expect(replay.marketSnapshotsWritten).toBe(0);
      s = await snapshot();
      expect(s!.venue).toBe("PUMPSWAP_POOL");
      expect(s!.blockNumber).toBe(BigInt(SLOT + 10));
    });
  });
});
