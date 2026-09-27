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
import { quoteRawToUsdNumber } from "../../discovery/quoteUsd";
import type { QuoteUsdRateProvider } from "../../candles/usdPricing";
import { lookupQuoteAsset } from "../usd/chainlinkQuoteUsdRateProvider";
import { assessTrendingHealth, type TrendingHealth } from "./trendingCoverage";
import { loadTrendingConfig, type TrendingConfig } from "./trendingConfig";
import { classifyEligibility, liquidityRatioBps, type RiskClassification } from "./trendingEligibility";
import { buildCohort, scoreToken, type TrendingMetrics } from "./trendingRank";

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
  lastTrade: Date | null;
}

/**
 * Recompute volume windows, eligibility and trending rank for every recently traded token.
 *
 * Phase 7E.4 made this two passes rather than one. Scores are percentiles within the current
 * cohort, so no token can be scored until every token's metrics are known — which is exactly
 * what stops a tiny-baseline surge dominating on raw units.
 *
 *   pass 1  read the windows, value them in USD, classify eligibility
 *   pass 2  build the cohort distribution, score, persist
 *
 * Only ELIGIBLE tokens receive a score. Everything else keeps its classification and reasons
 * so the API can explain an exclusion, but carries no `trendingScore` and therefore cannot
 * appear in default Trending however busy it looks.
 */
export async function computeTrending(
  db: PrismaClient,
  usd: QuoteUsdRateProvider,
  now = new Date(),
  config: TrendingConfig = loadTrendingConfig()
): Promise<{ status: TrendingStatus; health: TrendingHealth; scored: number; trending: number; classifications: Record<RiskClassification, number> }> {
  const health = await assessTrendingHealth(db, config, now);
  const status = await trendingCoverage(db, now);
  const classifications: Record<RiskClassification, number> = { ELIGIBLE: 0, CAUTION: 0, HIGH_RISK: 0, UNVERIFIED: 0 };

  if (!health.trendingAvailable) {
    // Never leave an old ranking behind when the scoring windows lapse.
    await db.tokenMarketSnapshot.updateMany({ where: { chain: "robinhood", trendingScore: { not: null } }, data: { trendingScore: null } });
    return { status, health, scored: 0, trending: 0, classifications };
  }

  const t5 = new Date(now.getTime() - 5 * 60_000);
  const t1h = new Date(now.getTime() - config.coverage.rollingWindowMs);
  const tBaseline = new Date(now.getTime() - config.coverage.rollingWindowMs - config.coverage.baselineWindowMs);
  const baselineHours = config.coverage.baselineWindowMs / 3_600_000;

  const rows = await db.$queryRaw<Agg[]>`
    SELECT "tokenAddress", "quoteAddress",
      COALESCE(SUM("quoteAmount") FILTER (WHERE "sourceTimestamp" > ${t5}), 0)::text AS v5m,
      COALESCE(SUM("quoteAmount") FILTER (WHERE "sourceTimestamp" > ${t1h}), 0)::text AS v1h,
      COALESCE(SUM("quoteAmount") FILTER (WHERE "sourceTimestamp" <= ${t1h}), 0)::text AS "vPrev",
      COUNT(*) FILTER (WHERE "sourceTimestamp" <= ${t1h}) AS "prevTrades",
      COUNT(*) FILTER (WHERE "sourceTimestamp" > ${t1h}) AS "trades1h",
      COUNT(*) FILTER (WHERE "sourceTimestamp" > ${t1h} AND side = 'buy') AS "buys1h",
      COUNT(*) FILTER (WHERE "sourceTimestamp" > ${t1h} AND side = 'sell') AS "sells1h",
      COUNT(DISTINCT trader) FILTER (WHERE "sourceTimestamp" > ${t1h}) AS "traders1h",
      MAX("sourceTimestamp") AS "lastTrade"
    FROM "ChainTrade"
    WHERE chain = 'robinhood' AND "canonicalStatus" = 'CANONICAL' AND "sourceTimestamp" > ${tBaseline} AND "sourceTimestamp" <= ${now}
    GROUP BY "tokenAddress", "quoteAddress"`;

  const snapshots = new Map(
    (
      await db.tokenMarketSnapshot.findMany({
        where: { chain: "robinhood", tokenAddress: { in: rows.map((r) => r.tokenAddress) } },
        select: { tokenAddress: true, marketCapUsd: true, liquidityUsd: true, updatedAt: true, status: true, marketCapChange1hPct: true },
      })
    ).map((s) => [s.tokenAddress, s])
  );

  const rates = new Map<string, number | null>();
  /**
   * Phase 7E.4.3 §10 — all three windows convert through one function, so "5m, 1h and baseline
   * use the same conversion logic" is structural rather than a coincidence of three call sites.
   * It also removes this path's old float division: the raw sum of an hour of lamport amounts can
   * exceed Number.MAX_SAFE_INTEGER, and dividing it as a double rounded before the rate applied.
   */
  const usdOf = (raw: string, decimals: number, rate: number): number =>
    quoteRawToUsdNumber(raw.split(".")[0], decimals, rate) ?? 0;

  interface Candidate {
    row: Agg;
    metrics: TrendingMetrics;
    classification: RiskClassification;
    reasons: string[];
    ratio: number | null;
  }
  const candidates: Candidate[] = [];

  // --- pass 1: value the windows and classify -----------------------------------------
  for (const r of rows) {
    const asset = lookupQuoteAsset(r.quoteAddress);
    if (!asset) continue; // no verified decimals: never valued, never ranked
    if (!rates.has(r.quoteAddress)) {
      const rate = await usd.getHistoricalRate({ chain: "robinhood", quoteAddress: r.quoteAddress, at: now });
      rates.set(r.quoteAddress, rate.status === "AVAILABLE" ? Number(rate.rate.rateUsdPerQuote) : null);
    }
    const rate = rates.get(r.quoteAddress);
    if (rate === null || rate === undefined) continue;

    const snapshot = snapshots.get(r.tokenAddress) ?? null;
    const valuationUsd = snapshot?.marketCapUsd ? Number(snapshot.marketCapUsd) : null;
    const liquidityUsd = snapshot?.liquidityUsd ? Number(snapshot.liquidityUsd) : null;
    const snapshotAgeMs = snapshot?.updatedAt ? Math.max(0, now.getTime() - snapshot.updatedAt.getTime()) : null;
    const lastTradeAgeMs = r.lastTrade ? Math.max(0, now.getTime() - new Date(r.lastTrade).getTime()) : null;
    const ratio = liquidityRatioBps(liquidityUsd, valuationUsd);

    const eligibility = classifyEligibility(
      {
        valuationUsd,
        // Only total supply is known on this chain, so this is FDV and says so (§O).
        valuationBasis: "FDV",
        liquidityUsd,
        trades1h: Number(r.trades1h),
        traders1h: Number(r.traders1h),
        snapshotAgeMs,
        lastTradeAgeMs,
        routeVerified: snapshot?.status === "OK",
        tradingUnavailable: false,
      },
      config
    );
    classifications[eligibility.classification] += 1;

    candidates.push({
      row: r,
      classification: eligibility.classification,
      reasons: eligibility.reasons,
      ratio,
      metrics: {
        volume5mUsd: usdOf(r.v5m, asset.decimals, rate),
        volume1hUsd: usdOf(r.v1h, asset.decimals, rate),
        baselineHourlyUsd: Number(r.prevTrades) > 0 ? usdOf(r.vPrev, asset.decimals, rate) / baselineHours : null,
        trades1h: Number(r.trades1h),
        traders1h: Number(r.traders1h),
        liquidityUsd: liquidityUsd ?? 0,
        liquidityRatioBps: ratio,
        valuationChange1h: snapshot?.marketCapChange1hPct ? Number(snapshot.marketCapChange1hPct) / 100 : null,
        lastTradeAgeMs,
        snapshotAgeMs,
      },
    });
  }

  // --- pass 2: rank within the eligible cohort ----------------------------------------
  // Percentiles are taken over ELIGIBLE tokens only. Including the shells would compress
  // every real token into the top of a distribution made mostly of noise.
  const eligible = candidates.filter((c) => c.classification === "ELIGIBLE");
  const cohort = buildCohort(eligible.map((c) => c.metrics));

  let scored = 0;
  let trending = 0;
  const touched: string[] = [];

  for (const candidate of candidates) {
    const isEligible = candidate.classification === "ELIGIBLE";
    const breakdown = isEligible ? scoreToken(candidate.metrics, cohort, config) : null;
    const surge =
      candidate.metrics.baselineHourlyUsd && candidate.metrics.baselineHourlyUsd > 0
        ? candidate.metrics.volume1hUsd / candidate.metrics.baselineHourlyUsd
        : null;

    const updated = await db.tokenMarketSnapshot.updateMany({
      where: { chain: "robinhood", tokenAddress: candidate.row.tokenAddress },
      data: {
        volume5mUsd: candidate.metrics.volume5mUsd.toFixed(6),
        volume1hUsd: candidate.metrics.volume1hUsd.toFixed(6),
        volumeBaselineHourlyUsd: candidate.metrics.baselineHourlyUsd === null ? null : candidate.metrics.baselineHourlyUsd.toFixed(6),
        volumeSurge: surge === null ? null : Math.min(surge, 1e12).toFixed(6),
        trades1h: candidate.metrics.trades1h,
        buys1h: Number(candidate.row.buys1h),
        sells1h: Number(candidate.row.sells1h),
        traders1h: candidate.metrics.traders1h,
        // Only an ELIGIBLE token carries a score, so nothing else can reach default Trending.
        trendingScore: breakdown === null ? null : breakdown.finalScore.toFixed(6),
        scoreComponents: breakdown === null ? undefined : (breakdown as unknown as object),
        riskClassification: candidate.classification,
        riskReasons: candidate.reasons,
        liquidityRatioBps: candidate.ratio,
        valuationBasis: "FDV",
        trendingComputedAt: now,
      },
    });
    if (updated.count > 0) {
      touched.push(candidate.row.tokenAddress);
      scored += 1;
      if (breakdown !== null && breakdown.finalScore > 0) trending += 1;
    }
  }

  // Tokens that stopped trading drop out of the ranking and their windows reset.
  await db.tokenMarketSnapshot.updateMany({
    where: { chain: "robinhood", trendingComputedAt: { not: null }, tokenAddress: { notIn: touched } },
    data: {
      trendingScore: null,
      scoreComponents: undefined,
      riskClassification: "CAUTION",
      riskReasons: ["STALE_LAST_TRADE"],
      volume5mUsd: "0",
      volume1hUsd: "0",
      volumeSurge: null,
      trades1h: 0,
      buys1h: 0,
      sells1h: 0,
      traders1h: 0,
      trendingComputedAt: now,
    },
  });

  return { status, health, scored, trending, classifications };
}
