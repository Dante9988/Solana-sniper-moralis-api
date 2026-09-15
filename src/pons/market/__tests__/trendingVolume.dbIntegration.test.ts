/**
 * Phase 7D.4 — volume-based Trending on real PostgreSQL.
 *   PONS_RUN_DB_TESTS=true DATABASE_URL=postgresql://…/ci_x_test npx vitest run --no-file-parallelism src/pons/market/__tests__/trendingVolume.dbIntegration.test.ts
 */
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { QuoteUsdRateProvider } from "../../../candles/usdPricing";
import { CURVE_TRADE_CHECKPOINT_SOURCE } from "../../curveTradeListener";
import { DISCOVERY_V2_CHECKPOINT_SOURCE } from "../../discoveryV2Listener";
import { TRADE_V2_CHECKPOINT_SOURCE } from "../../tradeV2Listener";
import { computeTrending } from "../trendingVolume";

const RUN = process.env.PONS_RUN_DB_TESTS === "true";
const ETH = "0x0000000000000000000000000000000000000000";
const SURGING = "0x7e7e000000000000000000000000000000000001";
const STEADY = "0x7e7e000000000000000000000000000000000002";
const WASH = "0x7e7e000000000000000000000000000000000003"; // big volume, two wallets
const TOKENS = [SURGING, STEADY, WASH];
const E18 = 10n ** 18n;
const usd: QuoteUsdRateProvider = { name: "fixed", getHistoricalRate: async () => ({ status: "AVAILABLE", rate: { rateUsdPerQuote: "2000", observedAt: new Date(), source: "test" } }) };

describe.skipIf(!RUN)("computeTrending — real Postgres", () => {
  const db = new PrismaClient();
  const now = new Date("2026-09-15T15:00:00Z");
  let seq = 0;
  const trade = (tokenAddress: string, minutesAgo: number, eth: bigint, trader: string, side: "buy" | "sell" = "buy") => {
    seq += 1;
    return db.chainTrade.create({
      data: {
        chain: "robinhood", venue: "pons_v2", tokenAddress, poolAddress: "0x" + "c".repeat(40), side, tokenAmount: "1", quoteAmount: eth.toString(), quoteAddress: ETH, priceQuote: "1",
        trader, sourceHeight: BigInt(1_000_000 + seq), sourceHash: "0xh", sourceTxHash: "0x" + seq.toString(16).padStart(64, "0"), sourceIndex: 0, sourceTimestamp: new Date(now.getTime() - minutesAgo * 60_000),
      },
    });
  };
  const cleanup = async () => {
    await db.chainTrade.deleteMany({ where: { tokenAddress: { in: TOKENS } } });
    await db.tokenMarketSnapshot.deleteMany({ where: { tokenAddress: { in: TOKENS } } });
    await db.discoveredToken.deleteMany({ where: { tokenAddress: { in: TOKENS } } });
    await db.chainIngestionCheckpoint.deleteMany({ where: { source: { in: [CURVE_TRADE_CHECKPOINT_SOURCE, TRADE_V2_CHECKPOINT_SOURCE, DISCOVERY_V2_CHECKPOINT_SOURCE] } } });
  };
  const indexedUntil = async (at: Date) => {
    for (const source of [CURVE_TRADE_CHECKPOINT_SOURCE, TRADE_V2_CHECKPOINT_SOURCE]) {
      await db.chainIngestionCheckpoint.upsert({ where: { source }, create: { source, lastHeight: 1n, lastHash: "0x1", lastHeightTimestamp: at }, update: { lastHeightTimestamp: at } });
    }
  };

  beforeEach(async () => {
    await cleanup();
    for (const [i, t] of TOKENS.entries()) {
      await db.discoveredToken.create({ data: { chain: "robinhood", venue: "pons_v2", tokenAddress: t, deployer: ETH, quoteAddress: ETH, initialBuyAmount: 0, sourceHeight: BigInt(i + 1), sourceHash: "0x", sourceTxHash: "0x" + (900 + i).toString(16).padStart(64, "0"), sourceIndex: i } });
      await db.tokenMarketSnapshot.create({ data: { chain: "robinhood", tokenAddress: t, status: "OK" } });
    }
    // SURGING: $200/h for six hours, then $6,000 in the last hour from 12 wallets, hot last 5 minutes.
    for (let h = 1; h <= 6; h += 1) await trade(SURGING, 60 * h + 10, E18 / 10n, "0xa1");
    for (let i = 0; i < 12; i += 1) await trade(SURGING, i < 4 ? 2 : 30, (E18 * 3n) / 12n, `0xb${i}`, i % 3 === 0 ? "sell" : "buy");
    // STEADY: the same $2,000 every hour.
    for (let h = 0; h < 7; h += 1) for (let i = 0; i < 10; i += 1) await trade(STEADY, 60 * h + 5 + i, E18 / 10n, `0xc${i}`);
    // WASH: $20,000 in the hour, but only two wallets.
    for (let i = 0; i < 20; i += 1) await trade(WASH, 20, E18 / 2n, i % 2 ? "0xd1" : "0xd2");
  });
  afterAll(async () => {
    await cleanup();
    await db.$disconnect();
  });

  it("ranks only a real volume surge, with its windows", async () => {
    await indexedUntil(new Date(now.getTime() - 60_000));
    const r = await computeTrending(db, usd, now);
    expect(r.status.available).toBe(true);
    const s = await db.tokenMarketSnapshot.findUniqueOrThrow({ where: { chain_tokenAddress: { chain: "robinhood", tokenAddress: SURGING } } });
    expect(Number(s.volume1hUsd)).toBeCloseTo(6_000, 3);
    expect(Number(s.volumeBaselineHourlyUsd)).toBeCloseTo(200, 3);
    expect(Number(s.volumeSurge)).toBeCloseTo(30, 3);
    expect(s).toMatchObject({ trades1h: 12, traders1h: 12, buys1h: 8, sells1h: 4 });
    expect(Number(s.trendingScore)).toBeGreaterThan(0);
    const steady = await db.tokenMarketSnapshot.findUniqueOrThrow({ where: { chain_tokenAddress: { chain: "robinhood", tokenAddress: STEADY } } });
    expect(steady.trendingScore).toBeNull();
    expect(Number(steady.volumeSurge)).toBeCloseTo(1, 3);
    const wash = await db.tokenMarketSnapshot.findUniqueOrThrow({ where: { chain_tokenAddress: { chain: "robinhood", tokenAddress: WASH } } });
    expect(wash.trendingScore).toBeNull();
    expect(r.trending).toBeGreaterThanOrEqual(1);
  });

  it("reports Trending unavailable, with the lag, while trade indexing trails the chain, and clears old scores", async () => {
    await indexedUntil(new Date(now.getTime() - 60_000));
    await computeTrending(db, usd, now);
    await indexedUntil(new Date(now.getTime() - 3 * 3_600_000));
    const r = await computeTrending(db, usd, now);
    expect(r.status).toMatchObject({ available: false, lagSeconds: 3 * 3600 });
    expect(r.status.reason).toMatch(/3 h behind/);
    expect(await db.tokenMarketSnapshot.count({ where: { tokenAddress: { in: TOKENS }, trendingScore: { not: null } } })).toBe(0);
  });
});
