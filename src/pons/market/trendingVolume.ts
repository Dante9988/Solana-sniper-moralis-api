/**
 * Phase 7D.4 — Trending by trade volume.
 *
 * A token trends when its trading volume surges: last-hour USD volume against its own average
 * hourly volume over the six hours before, boosted when the last five minutes run hotter than the
 * hour. Everything comes from indexed, canonical `ChainTrade` rows (trader-side quote amounts,
 * each trade once), valued at the current verified Chainlink rate of the pair asset.
 *
 * Trending is only computed when trade indexing covers the present (every required trade stream
 * indexed to within `MAX_INDEX_LAG_MS` of now). While indexing trails the chain tip, the list is
 * reported unavailable with the lag, rather than ranking tokens on an old or partial hour.
 *
 * Guards against thin or self-traded volume: at least $500 in the hour, 10 trades and 3 distinct
 * traders. Tokens without a six-hour history (new launches) qualify on volume alone, at $1,000.
 */

import type { PrismaClient } from "@prisma/client";

import { loadFinality } from "../../candles/candleAggregationService";
import type { QuoteUsdRateProvider } from "../../candles/usdPricing";
import { lookupQuoteAsset } from "../usd/chainlinkQuoteUsdRateProvider";
import { parseDecimal } from "./marketSnapshot";

export const MAX_INDEX_LAG_MS = 10 * 60_000;
export const TRENDING_RULES = { minVolume1hUsd: 500, minNewTokenVolume1hUsd: 1_000, minTrades1h: 10, minTraders1h: 3, minSurge: 1.5, baselineFloorUsd: 50, maxSurge: 10, maxAcceleration: 3 } as const;

export interface VolumeWindows {
  volume5mUsd: number;
  volume1hUsd: number;
  /** Average hourly USD volume over the 6 hours before the last hour; null when the token has no trades then. */
  baselineHourlyUsd: number | null;
  trades1h: number;
  traders1h: number;
}

export interface TrendingResult {
  surge: number | null;
  score: number | null;
}

export function trendingScore(w: VolumeWindows, rules = TRENDING_RULES): TrendingResult {
  const surge = w.baselineHourlyUsd === null ? null : w.volume1hUsd / Math.max(w.baselineHourlyUsd, rules.baselineFloorUsd);
  if (w.trades1h < rules.minTrades1h || w.traders1h < rules.minTraders1h) return { surge, score: null };
  if (surge === null) {
    if (w.volume1hUsd < rules.minNewTokenVolume1hUsd) return { surge, score: null };
  } else if (w.volume1hUsd < rules.minVolume1hUsd || surge < rules.minSurge) {
    return { surge, score: null };
  }
  const acceleration = w.volume1hUsd > 0 ? Math.min(Math.max((w.volume5mUsd * 12) / w.volume1hUsd, 1), rules.maxAcceleration) : 1;
  const score = w.volume1hUsd * Math.min(surge ?? rules.minSurge, rules.maxSurge) * acceleration;
  return { surge, score };
}

export interface TrendingStatus {
  available: boolean;
  basis: "TRADE_VOLUME";
  indexedUntil: string | null;
  lagSeconds: number | null;
  reason: string | null;
  computedAt: string;
}

/** Whether indexed trades reach close enough to now to rank the last hour. */
export async function trendingCoverage(db: PrismaClient, now: Date): Promise<TrendingStatus> {
  const finality = await loadFinality(db, "robinhood");
  const until = finality.tradeLastHeightTimestamp;
  const lag = until ? Math.max(0, now.getTime() - until.getTime()) : null;
  const available = until !== null && lag !== null && lag <= MAX_INDEX_LAG_MS && !finality.unresolvedReorg;
  let reason: string | null = null;
  if (finality.unresolvedReorg) reason = "Trade indexing is paused on an unresolved chain reorganisation.";
  else if (!until) reason = "Trade indexing has not reached recent blocks for every Pons trade stream yet.";
  else if (!available) reason = `Trades are indexed up to ${until.toISOString()}, ${formatLag(lag!)} behind the chain.`;
  return { available, basis: "TRADE_VOLUME", indexedUntil: until?.toISOString() ?? null, lagSeconds: lag === null ? null : Math.round(lag / 1000), reason, computedAt: now.toISOString() };
}

function formatLag(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 120) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 72 ? `${h} h` : `${Math.round(h / 24)} days`;
}

interface Agg {
  tokenAddress: string;
  quoteAddress: string;
  v5m: string;
  v1h: string;
  vPrev: string;
  prevTrades: bigint;
  trades1h: bigint;
  buys1h: bigint;
  sells1h: bigint;
  traders1h: bigint;
}

/** Recomputes volume windows and trending scores for every token traded in the last seven hours. */
export async function computeTrending(db: PrismaClient, usd: QuoteUsdRateProvider, now = new Date()): Promise<{ status: TrendingStatus; scored: number; trending: number }> {
  const status = await trendingCoverage(db, now);
  if (!status.available) {
    // Never leave an old ranking behind when coverage lapses.
    await db.tokenMarketSnapshot.updateMany({ where: { chain: "robinhood", trendingScore: { not: null } }, data: { trendingScore: null } });
    return { status, scored: 0, trending: 0 };
  }
  const t5 = new Date(now.getTime() - 5 * 60_000);
  const t1h = new Date(now.getTime() - 3_600_000);
  const t7h = new Date(now.getTime() - 7 * 3_600_000);
  const rows = await db.$queryRaw<Agg[]>`
    SELECT "tokenAddress", "quoteAddress",
      COALESCE(SUM("quoteAmount") FILTER (WHERE "sourceTimestamp" > ${t5}), 0)::text AS v5m,
      COALESCE(SUM("quoteAmount") FILTER (WHERE "sourceTimestamp" > ${t1h}), 0)::text AS v1h,
      COALESCE(SUM("quoteAmount") FILTER (WHERE "sourceTimestamp" <= ${t1h}), 0)::text AS "vPrev",
      COUNT(*) FILTER (WHERE "sourceTimestamp" <= ${t1h}) AS "prevTrades",
      COUNT(*) FILTER (WHERE "sourceTimestamp" > ${t1h}) AS "trades1h",
      COUNT(*) FILTER (WHERE "sourceTimestamp" > ${t1h} AND side = 'buy') AS "buys1h",
      COUNT(*) FILTER (WHERE "sourceTimestamp" > ${t1h} AND side = 'sell') AS "sells1h",
      COUNT(DISTINCT trader) FILTER (WHERE "sourceTimestamp" > ${t1h}) AS "traders1h"
    FROM "ChainTrade"
    WHERE chain = 'robinhood' AND "canonicalStatus" = 'CANONICAL' AND "sourceTimestamp" > ${t7h} AND "sourceTimestamp" <= ${now}
    GROUP BY "tokenAddress", "quoteAddress"`;

  const rates = new Map<string, number | null>();
  const scale = (raw: string, decimals: number) => Number(parseDecimal(raw.split(".")[0], 0)) / 10 ** decimals;
  let scored = 0;
  let trending = 0;
  const touched: string[] = [];
  for (const r of rows) {
    const asset = lookupQuoteAsset(r.quoteAddress);
    if (!asset) continue; // no verified decimals or rate: never valued
    if (!rates.has(r.quoteAddress)) {
      const rate = await usd.getHistoricalRate({ chain: "robinhood", quoteAddress: r.quoteAddress, at: now });
      rates.set(r.quoteAddress, rate.status === "AVAILABLE" ? Number(rate.rate.rateUsdPerQuote) : null);
    }
    const rate = rates.get(r.quoteAddress);
    if (rate === null || rate === undefined) continue;
    const windows: VolumeWindows = {
      volume5mUsd: scale(r.v5m, asset.decimals) * rate,
      volume1hUsd: scale(r.v1h, asset.decimals) * rate,
      baselineHourlyUsd: Number(r.prevTrades) > 0 ? (scale(r.vPrev, asset.decimals) * rate) / 6 : null,
      trades1h: Number(r.trades1h),
      traders1h: Number(r.traders1h),
    };
    const result = trendingScore(windows);
    const updated = await db.tokenMarketSnapshot.updateMany({
      where: { chain: "robinhood", tokenAddress: r.tokenAddress },
      data: {
        volume5mUsd: windows.volume5mUsd.toFixed(6),
        volume1hUsd: windows.volume1hUsd.toFixed(6),
        volumeBaselineHourlyUsd: windows.baselineHourlyUsd === null ? null : windows.baselineHourlyUsd.toFixed(6),
        volumeSurge: result.surge === null ? null : Math.min(result.surge, 1e12).toFixed(6),
        trades1h: windows.trades1h,
        buys1h: Number(r.buys1h),
        sells1h: Number(r.sells1h),
        traders1h: windows.traders1h,
        trendingScore: result.score === null ? null : result.score.toFixed(6),
        trendingComputedAt: now,
      },
    });
    if (updated.count > 0) {
      touched.push(r.tokenAddress);
      scored += 1;
      if (result.score !== null) trending += 1;
    }
  }
  // Tokens that stopped trading drop out of the ranking and their windows reset.
  await db.tokenMarketSnapshot.updateMany({
    where: { chain: "robinhood", trendingComputedAt: { not: null }, tokenAddress: { notIn: touched } },
    data: { trendingScore: null, volume5mUsd: "0", volume1hUsd: "0", volumeSurge: null, trades1h: 0, buys1h: 0, sells1h: 0, traders1h: 0, trendingComputedAt: now },
  });
  return { status, scored, trending };
}
