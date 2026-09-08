/**
 * Real-Postgres integration test for the candle worker's whole-tick
 * orchestration (src/candles/candleAggregationService.ts) — same opt-in
 * convention as every other *.dbIntegration.test.ts in this repo.
 *
 * Run:
 *   CANDLES_RUN_DB_TESTS=true DATABASE_URL=postgresql://... npx vitest run src/candles/__tests__/candleAggregationService.dbIntegration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { runCandleAggregationTick } from "../candleAggregationService";
import { NullQuoteUsdRateProvider } from "../usdPricing";
import { CandleFakeChainReader } from "./candleTestSupport";
import { FakeChainReader } from "../../pons/__tests__/testSupport";
import { TRADE_CHECKPOINT_SOURCE } from "../../pons/tradeListener";
import { DISCOVERY_CHECKPOINT_SOURCE } from "../../pons/discoveryListener";
import { resetDecimalsResolverMemo } from "../decimalsResolver";

const RUN_DB_TESTS = process.env.CANDLES_RUN_DB_TESTS === "true";

const CHAIN = "robinhood";
const VENUE = "pons";
const TOKEN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const QUOTE = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

describe.skipIf(!RUN_DB_TESTS)("candleAggregationService — real Postgres integration", () => {
  const prisma = new PrismaClient();

  async function cleanup() {
    await prisma.marketCandle.deleteMany({ where: { chain: CHAIN, tokenAddress: TOKEN } });
    await prisma.candleInvalidation.deleteMany({ where: { chain: CHAIN, tokenAddress: TOKEN } });
    await prisma.candleAggregationCheckpoint.deleteMany({ where: { chain: CHAIN, tokenAddress: TOKEN } });
    await prisma.candleWorkerRunState.deleteMany({ where: { chain: CHAIN } });
    await prisma.chainTrade.deleteMany({ where: { chain: CHAIN, tokenAddress: TOKEN } });
    await prisma.discoveredToken.deleteMany({ where: { chain: CHAIN, tokenAddress: TOKEN } });
    await prisma.chainIngestionCheckpoint.deleteMany({ where: { source: { in: [TRADE_CHECKPOINT_SOURCE, DISCOVERY_CHECKPOINT_SOURCE] } } });
  }

  beforeAll(cleanup);
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await cleanup();
    resetDecimalsResolverMemo();
  });

  async function seedToken() {
    await prisma.discoveredToken.create({
      data: {
        chain: CHAIN,
        venue: VENUE,
        tokenAddress: TOKEN,
        deployer: "0xc0ffee0000000000000000000000000000c0ff",
        poolAddress: "0xdddddddddddddddddddddddddddddddddddddd",
        quoteAddress: QUOTE,
        supply: "1000000000000000000000000000",
        initialBuyAmount: "1000000000000000000",
        isToken0: true,
        poolFee: 10_000,
        sourceHeight: 100n,
        sourceHash: "0xhash-100",
        sourceTxHash: "0xtx-launch",
        sourceIndex: 0,
      },
    });
  }

  async function seedTrade(params: { sourceHeight: bigint; sourceIndex: number; tokenAmount: string; quoteAmount: string; side?: "buy" | "sell"; trader?: string; sourceTimestamp: Date; canonicalStatus?: "CANONICAL" | "ORPHANED" }) {
    await prisma.chainTrade.create({
      data: {
        chain: CHAIN,
        venue: VENUE,
        tokenAddress: TOKEN,
        poolAddress: "0xdddddddddddddddddddddddddddddddddddddd",
        side: params.side ?? "buy",
        tokenAmount: params.tokenAmount,
        quoteAmount: params.quoteAmount,
        quoteAddress: QUOTE,
        priceQuote: "1",
        trader: params.trader ?? "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        sourceHeight: params.sourceHeight,
        sourceHash: `0xhash-${params.sourceHeight}`,
        sourceTxHash: `0xtx-${params.sourceHeight}-${params.sourceIndex}`,
        sourceIndex: params.sourceIndex,
        sourceTimestamp: params.sourceTimestamp,
        canonicalStatus: params.canonicalStatus ?? "CANONICAL",
      },
    });
  }

  async function setTradeCheckpoint(lastHeightTimestamp: Date | null, unresolvedReorg = false) {
    await prisma.chainIngestionCheckpoint.upsert({
      where: { source: TRADE_CHECKPOINT_SOURCE },
      create: { source: TRADE_CHECKPOINT_SOURCE, lastHeight: 999_999n, lastHash: "0xhash", lastHeightTimestamp, reorgUnresolvedAt: unresolvedReorg ? new Date() : null },
      update: { lastHeightTimestamp, reorgUnresolvedAt: unresolvedReorg ? new Date() : null },
    });
  }

  function newDeps(chainClient: CandleFakeChainReader, overrides: Partial<Parameters<typeof runCandleAggregationTick>[0]> = {}) {
    return {
      db: prisma,
      chainClient,
      chain: CHAIN,
      venue: VENUE,
      usdRateProvider: new NullQuoteUsdRateProvider(),
      maxInvalidationTokensPerTick: 10,
      maxForwardTokensPerTick: 10,
      tradePageCap: 1000,
      logger: noopLogger,
      ...overrides,
    };
  }

  const BASE_TS = new Date("2026-01-01T00:00:00.000Z");

  it("aggregates BUY and SELL trades with verified (non-18) decimals into a correct candle", async () => {
    await seedToken();
    const fake = new CandleFakeChainReader(new FakeChainReader(1n));
    fake.decimalsByAddress.set(TOKEN, 9); // representative 9-decimal token
    fake.decimalsByAddress.set(QUOTE, 18);

    // buy: 2 token (9 dec) for 4 quote (18 dec) => price 2
    await seedTrade({ sourceHeight: 1n, sourceIndex: 0, tokenAmount: "2000000000", quoteAmount: "4000000000000000000", side: "buy", sourceTimestamp: BASE_TS });
    // sell: 1 token (9 dec) for 3 quote (18 dec) => price 3
    await seedTrade({ sourceHeight: 1n, sourceIndex: 1, tokenAmount: "1000000000", quoteAmount: "3000000000000000000", side: "sell", sourceTimestamp: BASE_TS });

    await runCandleAggregationTick(newDeps(fake));

    const candle = await prisma.marketCandle.findFirst({ where: { chain: CHAIN, tokenAddress: TOKEN, resolution: "H1" } });
    expect(candle).not.toBeNull();
    expect(candle!.open.toFixed()).toBe("2");
    expect(candle!.close.toFixed()).toBe("3");
    expect(candle!.high.toFixed()).toBe("3");
    expect(candle!.low.toFixed()).toBe("2");
    expect(candle!.volumeToken.toFixed()).toBe("3"); // 2 + 1 normalized token
    expect(candle!.volumeQuote.toFixed()).toBe("7"); // 4 + 3 normalized quote
    expect(candle!.tradeCount).toBe(2);
  });

  it("never assumes 18 decimals — a 6-decimal quote against an 18-decimal token normalizes correctly", async () => {
    await seedToken();
    const fake = new CandleFakeChainReader(new FakeChainReader(1n));
    fake.decimalsByAddress.set(TOKEN, 18);
    fake.decimalsByAddress.set(QUOTE, 6);

    // 1 token (18 dec) for 5 quote (6 dec) => price 5
    await seedTrade({ sourceHeight: 1n, sourceIndex: 0, tokenAmount: "1000000000000000000", quoteAmount: "5000000", sourceTimestamp: BASE_TS });

    await runCandleAggregationTick(newDeps(fake));
    const candle = await prisma.marketCandle.findFirst({ where: { chain: CHAIN, tokenAddress: TOKEN, resolution: "H1" } });
    expect(candle!.open.toFixed()).toBe("5");
    expect(candle!.volumeQuote.toFixed()).toBe("5");
  });

  it("excludes ORPHANED trades from every bucket", async () => {
    await seedToken();
    const fake = new CandleFakeChainReader(new FakeChainReader(1n));
    await seedTrade({ sourceHeight: 1n, sourceIndex: 0, tokenAmount: "1000000000000000000", quoteAmount: "1000000000000000000", sourceTimestamp: BASE_TS });
    await seedTrade({ sourceHeight: 1n, sourceIndex: 1, tokenAmount: "5000000000000000000", quoteAmount: "5000000000000000000", sourceTimestamp: BASE_TS, canonicalStatus: "ORPHANED" });

    await runCandleAggregationTick(newDeps(fake));
    const candle = await prisma.marketCandle.findFirst({ where: { chain: CHAIN, tokenAddress: TOKEN, resolution: "H1" } });
    expect(candle!.tradeCount).toBe(1);
    expect(candle!.volumeToken.toFixed()).toBe("1");
  });

  it("produces no candle for a bucket with no canonical trades (no fake flat candle)", async () => {
    await seedToken();
    const fake = new CandleFakeChainReader(new FakeChainReader(1n));
    await seedTrade({ sourceHeight: 1n, sourceIndex: 0, tokenAmount: "1000000000000000000", quoteAmount: "1000000000000000000", sourceTimestamp: BASE_TS, canonicalStatus: "ORPHANED" });

    await runCandleAggregationTick(newDeps(fake));
    const count = await prisma.marketCandle.count({ where: { chain: CHAIN, tokenAddress: TOKEN } });
    expect(count).toBe(0);
  });

  it("provisional/final: a bucket stays provisional until confirmed trade-checkpoint progress passes its end, and never becomes final under an unresolved reorg", async () => {
    await seedToken();
    const fake = new CandleFakeChainReader(new FakeChainReader(1n));
    await seedTrade({ sourceHeight: 1n, sourceIndex: 0, tokenAmount: "1000000000000000000", quoteAmount: "1000000000000000000", sourceTimestamp: BASE_TS });

    // No trade-checkpoint evidence at all yet.
    await runCandleAggregationTick(newDeps(fake));
    let candle = await prisma.marketCandle.findFirst({ where: { chain: CHAIN, tokenAddress: TOKEN, resolution: "H1" } });
    expect(candle!.status).toBe("PROVISIONAL");

    // Confirmed progress now well past the 1h bucket's end.
    await setTradeCheckpoint(new Date(BASE_TS.getTime() + 3 * 3_600_000));
    await runCandleAggregationTick(newDeps(fake));
    candle = await prisma.marketCandle.findFirst({ where: { chain: CHAIN, tokenAddress: TOKEN, resolution: "H1" } });
    expect(candle!.status).toBe("FINAL");

    // An unresolved reorg must prevent it from staying/being final.
    await setTradeCheckpoint(new Date(BASE_TS.getTime() + 3 * 3_600_000), true);
    // A fresh reorg-affecting trade forces a real recompute pass.
    await prisma.candleInvalidation.create({ data: { chain: CHAIN, tokenAddress: TOKEN, invalidatedFromTimestamp: BASE_TS } });
    await runCandleAggregationTick(newDeps(fake));
    candle = await prisma.marketCandle.findFirst({ where: { chain: CHAIN, tokenAddress: TOKEN, resolution: "H1" } });
    expect(candle!.status).toBe("PROVISIONAL");
  });

  it("restart idempotency: a second tick with a fresh PrismaClient against unchanged data writes nothing new", async () => {
    await seedToken();
    const fake = new CandleFakeChainReader(new FakeChainReader(1n));
    await seedTrade({ sourceHeight: 1n, sourceIndex: 0, tokenAmount: "1000000000000000000", quoteAmount: "1000000000000000000", sourceTimestamp: BASE_TS });

    await runCandleAggregationTick(newDeps(fake));
    const countAfterFirst = await prisma.marketCandle.count({ where: { chain: CHAIN, tokenAddress: TOKEN } });

    const prisma2 = new PrismaClient();
    const fake2 = new CandleFakeChainReader(new FakeChainReader(1n));
    fake2.decimalsByAddress = fake.decimalsByAddress;
    await runCandleAggregationTick({ ...newDeps(fake2), db: prisma2 });
    await prisma2.$disconnect();

    const countAfterSecond = await prisma.marketCandle.count({ where: { chain: CHAIN, tokenAddress: TOKEN } });
    expect(countAfterSecond).toBe(countAfterFirst);

    const candle = await prisma.marketCandle.findFirst({ where: { chain: CHAIN, tokenAddress: TOKEN, resolution: "H1" } });
    expect(candle!.revision).toBe(1); // never bumped by the redundant second tick
  });

  it("rebuild idempotency: recompute-from-scratch (no checkpoint) run twice converges to the same values", async () => {
    await seedToken();
    const fake = new CandleFakeChainReader(new FakeChainReader(1n));
    await seedTrade({ sourceHeight: 1n, sourceIndex: 0, tokenAmount: "1000000000000000000", quoteAmount: "2000000000000000000", sourceTimestamp: BASE_TS });
    await seedTrade({ sourceHeight: 1n, sourceIndex: 1, tokenAmount: "1000000000000000000", quoteAmount: "3000000000000000000", sourceTimestamp: BASE_TS });

    await runCandleAggregationTick(newDeps(fake));
    const first = await prisma.marketCandle.findFirst({ where: { chain: CHAIN, tokenAddress: TOKEN, resolution: "H1" } });

    // Force a full rebuild by deleting the checkpoint (same effect as the explicit rebuild path).
    await prisma.candleAggregationCheckpoint.deleteMany({ where: { chain: CHAIN, tokenAddress: TOKEN } });
    await runCandleAggregationTick(newDeps(fake));
    const second = await prisma.marketCandle.findFirst({ where: { chain: CHAIN, tokenAddress: TOKEN, resolution: "H1" } });

    expect(second!.open.toFixed()).toBe(first!.open.toFixed());
    expect(second!.close.toFixed()).toBe(first!.close.toFixed());
    expect(second!.volumeToken.toFixed()).toBe(first!.volumeToken.toFixed());
    expect(second!.tradeCount).toBe(first!.tradeCount);
  });

  it("multiple swaps in the same block order deterministically by sourceIndex, not insertion order", async () => {
    await seedToken();
    const fake = new CandleFakeChainReader(new FakeChainReader(1n));
    // Insert the higher-sourceIndex trade FIRST to prove insertion order is irrelevant.
    await seedTrade({ sourceHeight: 5n, sourceIndex: 9, tokenAmount: "1000000000000000000", quoteAmount: "9000000000000000000", sourceTimestamp: BASE_TS });
    await seedTrade({ sourceHeight: 5n, sourceIndex: 1, tokenAmount: "1000000000000000000", quoteAmount: "1000000000000000000", sourceTimestamp: BASE_TS });

    await runCandleAggregationTick(newDeps(fake));
    const candle = await prisma.marketCandle.findFirst({ where: { chain: CHAIN, tokenAddress: TOKEN, resolution: "H1" } });
    expect(candle!.open.toFixed()).toBe("1"); // sourceIndex 1 first
    expect(candle!.close.toFixed()).toBe("9"); // sourceIndex 9 last
  });

  it("decimals-unavailable fails closed: no candle is produced and the tick reports the error rather than assuming 18", async () => {
    await seedToken();
    const fake = new CandleFakeChainReader(new FakeChainReader(1n));
    fake.decimalsByAddress.set(TOKEN, "FAIL");
    await seedTrade({ sourceHeight: 1n, sourceIndex: 0, tokenAmount: "1000000000000000000", quoteAmount: "1000000000000000000", sourceTimestamp: BASE_TS });

    const summary = await runCandleAggregationTick(newDeps(fake));
    expect(summary.errors.length).toBeGreaterThan(0);
    const count = await prisma.marketCandle.count({ where: { chain: CHAIN, tokenAddress: TOKEN } });
    expect(count).toBe(0);
  });
});
