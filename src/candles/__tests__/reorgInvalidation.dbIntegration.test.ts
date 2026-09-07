/**
 * Real-Postgres integration test proving the mandatory §9 invariant:
 * reorg recovery (src/pons/reorgRecovery.ts, unchanged production code) ->
 * CandleInvalidation rows written in the same transaction -> the candle
 * worker (src/candles/candleAggregationService.ts) fully recomputes every
 * affected bucket from `ChainTrade WHERE canonicalStatus = CANONICAL` ->
 * querying candles afterward never returns orphan-only values.
 *
 * Run:
 *   CANDLES_RUN_DB_TESTS=true DATABASE_URL=postgresql://... npx vitest run src/candles/__tests__/reorgInvalidation.dbIntegration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { attemptReorgRecovery } from "../../pons/reorgRecovery";
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
const TOKEN = "0x1111111111111111111111111111111111111a";
const QUOTE = "0x2222222222222222222222222222222222222b";
const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

describe.skipIf(!RUN_DB_TESTS)("reorg -> candle invalidation -> recompute — real Postgres integration", () => {
  const prisma = new PrismaClient();

  async function cleanup() {
    await prisma.marketCandle.deleteMany({ where: { chain: CHAIN, tokenAddress: TOKEN } });
    await prisma.candleInvalidation.deleteMany({ where: { chain: CHAIN, tokenAddress: TOKEN } });
    await prisma.candleAggregationCheckpoint.deleteMany({ where: { chain: CHAIN, tokenAddress: TOKEN } });
    await prisma.candleWorkerRunState.deleteMany({ where: { chain: CHAIN } });
    await prisma.chainTrade.deleteMany({ where: { chain: CHAIN, tokenAddress: TOKEN } });
    await prisma.discoveredToken.deleteMany({ where: { chain: CHAIN, tokenAddress: TOKEN } });
    await prisma.chainIngestionCheckpoint.deleteMany({ where: { source: { in: [TRADE_CHECKPOINT_SOURCE, DISCOVERY_CHECKPOINT_SOURCE] } } });
    await prisma.chainBlockCheckpoint.deleteMany({ where: { chain: CHAIN } });
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

  async function seedToken(sourceHeight: bigint) {
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
        sourceHeight,
        sourceHash: `0xhash-${sourceHeight}`,
        sourceTxHash: "0xtx-launch",
        sourceIndex: 0,
      },
    });
  }

  async function seedTrade(params: { sourceHeight: bigint; sourceIndex: number; tokenAmount: string; quoteAmount: string; sourceTimestamp: Date }) {
    await prisma.chainTrade.create({
      data: {
        chain: CHAIN,
        venue: VENUE,
        tokenAddress: TOKEN,
        poolAddress: "0xdddddddddddddddddddddddddddddddddddddd",
        side: "buy",
        tokenAmount: params.tokenAmount,
        quoteAmount: params.quoteAmount,
        quoteAddress: QUOTE,
        priceQuote: "1",
        trader: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        sourceHeight: params.sourceHeight,
        sourceHash: `0xhash-${params.sourceHeight}`,
        sourceTxHash: `0xtx-${params.sourceHeight}-${params.sourceIndex}`,
        sourceIndex: params.sourceIndex,
        sourceTimestamp: params.sourceTimestamp,
        canonicalStatus: "CANONICAL",
      },
    });
  }

  function newFake(latest: bigint) {
    const fake = new CandleFakeChainReader(new FakeChainReader(latest));
    fake.decimalsByAddress.set(TOKEN, 18);
    fake.decimalsByAddress.set(QUOTE, 18);
    return fake;
  }

  function newDeps(chainClient: CandleFakeChainReader) {
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
    };
  }

  const BASE_TS = new Date("2026-01-01T00:00:00.000Z");
  const BASE_SECONDS = Math.floor(BASE_TS.getTime() / 1000);

  it("a trade inside a candle becoming orphaned causes the whole bucket to be recomputed, excluding it", async () => {
    await seedToken(10n);
    const fake = newFake(200n);

    await seedTrade({ sourceHeight: 10n, sourceIndex: 0, tokenAmount: "1000000000000000000", quoteAmount: "1000000000000000000", sourceTimestamp: BASE_TS });
    await seedTrade({ sourceHeight: 11n, sourceIndex: 0, tokenAmount: "1000000000000000000", quoteAmount: "5000000000000000000", sourceTimestamp: BASE_TS });

    await runCandleAggregationTick(newDeps(fake));
    let candle = await prisma.marketCandle.findFirst({ where: { chain: CHAIN, tokenAddress: TOKEN, resolution: "H1" } });
    expect(candle!.tradeCount).toBe(2);
    expect(candle!.high.toFixed()).toBe("5");

    // Seed checkpoint history so reorgRecovery can find an ancestor at height 10.
    await prisma.chainBlockCheckpoint.create({ data: { chain: CHAIN, height: 10n, hash: "0xhash-10" } });
    await prisma.chainIngestionCheckpoint.upsert({
      where: { source: TRADE_CHECKPOINT_SOURCE },
      create: { source: TRADE_CHECKPOINT_SOURCE, lastHeight: 11n, lastHash: "0xhash-11" },
      update: { lastHeight: 11n, lastHash: "0xhash-11" },
    });
    await prisma.chainIngestionCheckpoint.upsert({
      where: { source: DISCOVERY_CHECKPOINT_SOURCE },
      create: { source: DISCOVERY_CHECKPOINT_SOURCE, lastHeight: 11n, lastHash: "0xhash-11" },
      update: { lastHeight: 11n, lastHash: "0xhash-11" },
    });

    // The real reorg recovery algorithm — production code, unmodified in its actual logic — orphans trade at height 11 and writes a CandleInvalidation row.
    const recovery = await attemptReorgRecovery({ chainClient: fake, db: prisma, chain: CHAIN });
    expect(recovery.status).toBe("RECOVERED");
    if (recovery.status !== "RECOVERED") throw new Error("expected RECOVERED");
    expect(recovery.orphanedTrades).toBe(1);
    expect(recovery.candlesInvalidated).toBe(1);

    const pendingInvalidation = await prisma.candleInvalidation.findFirst({ where: { chain: CHAIN, tokenAddress: TOKEN, processedAt: null } });
    expect(pendingInvalidation).not.toBeNull();

    await runCandleAggregationTick(newDeps(fake));

    candle = await prisma.marketCandle.findFirst({ where: { chain: CHAIN, tokenAddress: TOKEN, resolution: "H1" } });
    expect(candle!.tradeCount).toBe(1);
    expect(candle!.high.toFixed()).toBe("1"); // the orphaned trade's price (5) must never appear again

    const processed = await prisma.candleInvalidation.findFirst({ where: { chain: CHAIN, tokenAddress: TOKEN, processedAt: null } });
    expect(processed).toBeNull();
  });

  it("a reorg crossing a candle (1h) boundary recomputes buckets on both sides", async () => {
    await seedToken(10n);
    const fake = newFake(200n);

    // One trade well before the boundary, one right after — both in the same 1h bucket as far as candle math goes (same hour), but this proves the aligned recompute window still covers everything correctly around an arbitrary ancestor height.
    await seedTrade({ sourceHeight: 10n, sourceIndex: 0, tokenAmount: "1000000000000000000", quoteAmount: "1000000000000000000", sourceTimestamp: BASE_TS });
    await seedTrade({ sourceHeight: 11n, sourceIndex: 0, tokenAmount: "1000000000000000000", quoteAmount: "2000000000000000000", sourceTimestamp: new Date((BASE_SECONDS + 1800) * 1000) }); // +30 min, same 1h bucket
    await seedTrade({ sourceHeight: 12n, sourceIndex: 0, tokenAmount: "1000000000000000000", quoteAmount: "3000000000000000000", sourceTimestamp: new Date((BASE_SECONDS + 3900) * 1000) }); // +65 min, NEXT 1h bucket

    await runCandleAggregationTick(newDeps(fake));
    const bucketsBefore = await prisma.marketCandle.findMany({ where: { chain: CHAIN, tokenAddress: TOKEN, resolution: "H1" }, orderBy: { bucketStart: "asc" } });
    expect(bucketsBefore).toHaveLength(2);

    await prisma.chainBlockCheckpoint.create({ data: { chain: CHAIN, height: 10n, hash: "0xhash-10" } });
    await prisma.chainIngestionCheckpoint.upsert({
      where: { source: TRADE_CHECKPOINT_SOURCE },
      create: { source: TRADE_CHECKPOINT_SOURCE, lastHeight: 12n, lastHash: "0xhash-12" },
      update: { lastHeight: 12n, lastHash: "0xhash-12" },
    });
    await prisma.chainIngestionCheckpoint.upsert({
      where: { source: DISCOVERY_CHECKPOINT_SOURCE },
      create: { source: DISCOVERY_CHECKPOINT_SOURCE, lastHeight: 12n, lastHash: "0xhash-12" },
      update: { lastHeight: 12n, lastHash: "0xhash-12" },
    });

    const recovery = await attemptReorgRecovery({ chainClient: fake, db: prisma, chain: CHAIN });
    expect(recovery.status).toBe("RECOVERED");
    if (recovery.status !== "RECOVERED") throw new Error("expected RECOVERED");
    expect(recovery.orphanedTrades).toBe(2); // heights 11 and 12, spanning the boundary

    await runCandleAggregationTick(newDeps(fake));
    const bucketsAfter = await prisma.marketCandle.findMany({ where: { chain: CHAIN, tokenAddress: TOKEN, resolution: "H1" }, orderBy: { bucketStart: "asc" } });
    // Only the first bucket's first trade remains canonical.
    expect(bucketsAfter).toHaveLength(1);
    expect(bucketsAfter[0].tradeCount).toBe(1);
  });

  it("a trade orphaned and later canonically revived on replay converges back to including it — never stuck on the orphan-only value", async () => {
    // The token launch itself is well before the reorg's ancestor height —
    // only the trade (height 10) is orphaned, isolating exactly the
    // scenario under test (trade revival). Launch revival-on-replay is
    // already covered by discoveryListener's own reorgRecovery.dbIntegration.test.ts.
    await seedToken(1n);
    const fake = newFake(200n);

    await seedTrade({ sourceHeight: 10n, sourceIndex: 0, tokenAmount: "1000000000000000000", quoteAmount: "1000000000000000000", sourceTimestamp: BASE_TS });

    await runCandleAggregationTick(newDeps(fake));

    await prisma.chainBlockCheckpoint.create({ data: { chain: CHAIN, height: 9n, hash: "0xhash-9" } });
    await prisma.chainIngestionCheckpoint.upsert({
      where: { source: TRADE_CHECKPOINT_SOURCE },
      create: { source: TRADE_CHECKPOINT_SOURCE, lastHeight: 10n, lastHash: "0xhash-10" },
      update: { lastHeight: 10n, lastHash: "0xhash-10" },
    });
    await prisma.chainIngestionCheckpoint.upsert({
      where: { source: DISCOVERY_CHECKPOINT_SOURCE },
      create: { source: DISCOVERY_CHECKPOINT_SOURCE, lastHeight: 10n, lastHash: "0xhash-10" },
      update: { lastHeight: 10n, lastHash: "0xhash-10" },
    });

    const recovery = await attemptReorgRecovery({ chainClient: fake, db: prisma, chain: CHAIN });
    expect(recovery.status).toBe("RECOVERED");

    await runCandleAggregationTick(newDeps(fake));
    const afterOrphan = await prisma.marketCandle.count({ where: { chain: CHAIN, tokenAddress: TOKEN } });
    expect(afterOrphan).toBe(0); // its only trade was orphaned — no-trade bucket = no candle

    // Simulate replay reviving the exact same fact (same unique key) back to canonical — exactly what discoveryListener.ts/tradeListener.ts's upsert `update` branch does.
    await prisma.chainTrade.updateMany({ where: { chain: CHAIN, tokenAddress: TOKEN }, data: { canonicalStatus: "CANONICAL", orphanedAt: null } });

    await runCandleAggregationTick(newDeps(fake));
    const candle = await prisma.marketCandle.findFirst({ where: { chain: CHAIN, tokenAddress: TOKEN, resolution: "H1" } });
    expect(candle).not.toBeNull();
    expect(candle!.tradeCount).toBe(1);
  });

  it("querying candles after convergence never returns orphan-only values, across every resolution", async () => {
    await seedToken(10n);
    const fake = newFake(200n);
    await seedTrade({ sourceHeight: 10n, sourceIndex: 0, tokenAmount: "1000000000000000000", quoteAmount: "1000000000000000000", sourceTimestamp: BASE_TS });
    await seedTrade({ sourceHeight: 11n, sourceIndex: 0, tokenAmount: "1000000000000000000", quoteAmount: "999000000000000000000", sourceTimestamp: BASE_TS }); // extreme outlier price, to be orphaned

    await runCandleAggregationTick(newDeps(fake));

    await prisma.chainBlockCheckpoint.create({ data: { chain: CHAIN, height: 10n, hash: "0xhash-10" } });
    await prisma.chainIngestionCheckpoint.upsert({
      where: { source: TRADE_CHECKPOINT_SOURCE },
      create: { source: TRADE_CHECKPOINT_SOURCE, lastHeight: 11n, lastHash: "0xhash-11" },
      update: { lastHeight: 11n, lastHash: "0xhash-11" },
    });
    await prisma.chainIngestionCheckpoint.upsert({
      where: { source: DISCOVERY_CHECKPOINT_SOURCE },
      create: { source: DISCOVERY_CHECKPOINT_SOURCE, lastHeight: 11n, lastHash: "0xhash-11" },
      update: { lastHeight: 11n, lastHash: "0xhash-11" },
    });
    await attemptReorgRecovery({ chainClient: fake, db: prisma, chain: CHAIN });
    await runCandleAggregationTick(newDeps(fake));

    const allCandles = await prisma.marketCandle.findMany({ where: { chain: CHAIN, tokenAddress: TOKEN } });
    for (const c of allCandles) {
      expect(c.high.toFixed()).not.toBe("999");
      expect(c.close.toFixed()).not.toBe("999");
    }
  });
});
