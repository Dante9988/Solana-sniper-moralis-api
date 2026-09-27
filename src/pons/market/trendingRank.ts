/**
 * Phase 7E.4 §3/§4/§5 — the Trending score.
 *
 * The old score was `volume1h × surge × acceleration`, which is dominated by whichever factor
 * happens to be largest in raw units. A token going $20/h → $500/h has a surge of 25 and beat
 * a token doing $200K/h → $350K/h, whose surge is 1.75 — even though the second is attracting
 * four hundred times the capital. That is the defect this file exists to remove.
 *
 * Two ideas fix it:
 *
 * 1. **Every component is a percentile within the current cohort**, not a raw number. A
 *    percentile is unitless and bounded to [0,1], so dollars cannot out-shout trader counts
 *    simply by being numerically bigger, and no component needs a hand-tuned scale factor.
 *    It is also self-calibrating: as the chain gets busier the bar moves with it.
 *
 * 2. **Acceleration is log-compressed and clamped.** A 25× surge from a $20 baseline scores
 *    better than 1.75×, but only slightly — and it is one weighted term among five rather
 *    than a multiplier over the whole score, so it can never dominate absolute activity.
 *
 * Finally the score decays with the age of the token's last trade (§4), so a historic spike
 * cannot pin anything near the top. Attention leaving is by itself enough to make a token
 * fall; there is no separate eviction rule to get out of step with the scoring.
 */

import type { TrendingConfig } from "./trendingConfig";

export interface TrendingMetrics {
  volume5mUsd: number;
  volume1hUsd: number;
  /** Average hourly USD volume over the baseline window; null for a token with no history. */
  baselineHourlyUsd: number | null;
  trades1h: number;
  traders1h: number;
  liquidityUsd: number;
  liquidityRatioBps: number | null;
  /** Fractional valuation change over the last hour, e.g. 0.12 for +12%. */
  valuationChange1h: number | null;
  lastTradeAgeMs: number | null;
  snapshotAgeMs: number | null;
}

/** §5 — every term, so a ranking anomaly can be explained rather than guessed at. */
export interface ScoreBreakdown {
  currentActivity: number;
  acceleration: number;
  traderBreadth: number;
  liquidityQuality: number;
  momentum: number;
  freshnessPenalty: number;
  /** Multiplier in (0,1] applied after the weighted sum. */
  decay: number;
  /** Before decay, so the two effects can be told apart. */
  rawScore: number;
  finalScore: number;
}

/**
 * Percentile rank of `value` within `sorted`, in [0,1].
 *
 * Ties share the rank of their first occurrence, so a cohort where half the tokens have zero
 * volume does not award those tokens a middling score for being unremarkable.
 */
export function percentileRank(sorted: readonly number[], value: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0] === value ? 1 : 0;
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sorted[mid] < value) low = mid + 1;
    else high = mid;
  }
  return low / (sorted.length - 1);
}

/** Sorted ascending copies of each metric across the cohort, built once per recompute. */
export interface CohortDistribution {
  volume5m: number[];
  volume1h: number[];
  trades1h: number[];
  traders1h: number[];
  liquidity: number[];
  liquidityRatio: number[];
}

export function buildCohort(all: readonly TrendingMetrics[]): CohortDistribution {
  const asc = (xs: number[]) => xs.sort((a, b) => a - b);
  return {
    volume5m: asc(all.map((m) => m.volume5mUsd)),
    volume1h: asc(all.map((m) => m.volume1hUsd)),
    trades1h: asc(all.map((m) => m.trades1h)),
    traders1h: asc(all.map((m) => m.traders1h)),
    liquidity: asc(all.map((m) => m.liquidityUsd)),
    liquidityRatio: asc(all.map((m) => m.liquidityRatioBps ?? 0)),
  };
}

/**
 * Acceleration, compressed so a tiny baseline cannot run away with the ranking.
 *
 * `log1p` of the multiple, divided by `log1p(maxAcceleration)`, then clamped to [0,1]. A
 * token at the cap scores 1; one that merely held its rate scores near 0. A token with no
 * baseline at all (a genuinely new launch) is given the midpoint rather than either extreme:
 * claiming it is decelerating would be false, and claiming a maximal surge from no history
 * is exactly the pathology being removed.
 */
export function accelerationScore(metrics: TrendingMetrics, config: TrendingConfig): number {
  const cap = Math.max(config.maxAcceleration, 1.0001);
  const denom = Math.log1p(cap - 1);

  const hourly = metrics.baselineHourlyUsd === null || metrics.baselineHourlyUsd <= 0
    ? null
    : metrics.volume1hUsd / metrics.baselineHourlyUsd;

  // The last five minutes against the hour's own average five-minute rate. This is what
  // catches capital arriving *now*, and it needs no historical baseline at all.
  const fiveMinuteRate = metrics.volume1hUsd > 0 ? (metrics.volume5mUsd * 12) / metrics.volume1hUsd : null;

  const parts: number[] = [];
  for (const multiple of [hourly, fiveMinuteRate]) {
    if (multiple === null) continue;
    const excess = Math.max(0, Math.min(multiple, cap) - 1);
    parts.push(denom > 0 ? Math.log1p(excess) / denom : 0);
  }
  if (parts.length === 0) return 0.5;
  return parts.reduce((a, b) => a + b, 0) / parts.length;
}

/**
 * Exponential decay on the age of the last trade (§4).
 *
 * At one half-life the score halves, at two it quarters. A token that stops trading therefore
 * slides out on its own, and one that starts again climbs back without special-casing.
 */
export function decayFactor(lastTradeAgeMs: number | null, config: TrendingConfig): number {
  if (lastTradeAgeMs === null) return 0;
  if (lastTradeAgeMs <= 0) return 1;
  return Math.pow(0.5, lastTradeAgeMs / config.decayHalfLifeMs);
}

/** Bounded price movement: direction matters, magnitude is capped so one outlier cannot rank on it alone. */
function momentumScore(change: number | null): number {
  if (change === null || !Number.isFinite(change)) return 0.5;
  // ±50% maps to the full range; beyond that adds nothing.
  return Math.max(0, Math.min(1, 0.5 + change / 1));
}

export function scoreToken(metrics: TrendingMetrics, cohort: CohortDistribution, config: TrendingConfig): ScoreBreakdown {
  const w = config.weights;

  const currentActivity =
    (percentileRank(cohort.volume1h, metrics.volume1hUsd) +
      percentileRank(cohort.volume5m, metrics.volume5mUsd) +
      percentileRank(cohort.trades1h, metrics.trades1h)) /
    3;

  const acceleration = accelerationScore(metrics, config);
  const traderBreadth = percentileRank(cohort.traders1h, metrics.traders1h);
  const liquidityQuality =
    (percentileRank(cohort.liquidity, metrics.liquidityUsd) +
      percentileRank(cohort.liquidityRatio, metrics.liquidityRatioBps ?? 0)) /
    2;
  const momentum = momentumScore(metrics.valuationChange1h);

  // A stale snapshot means the liquidity and valuation terms describe the past. Penalise in
  // proportion rather than excluding — exclusion is the eligibility gate's job, not the
  // score's.
  const staleness = metrics.snapshotAgeMs === null
    ? 1
    : Math.max(0, Math.min(1, metrics.snapshotAgeMs / Math.max(config.thresholds.maxSnapshotAgeMs, 1) - 1));
  const freshnessPenalty = staleness;

  const rawScore =
    w.currentActivity * currentActivity +
    w.acceleration * acceleration +
    w.traderBreadth * traderBreadth +
    w.liquidityQuality * liquidityQuality +
    w.momentum * momentum -
    w.freshnessPenalty * freshnessPenalty;

  const decay = decayFactor(metrics.lastTradeAgeMs, config);
  const finalScore = Math.max(0, rawScore) * decay;

  return {
    currentActivity: round(currentActivity),
    acceleration: round(acceleration),
    traderBreadth: round(traderBreadth),
    liquidityQuality: round(liquidityQuality),
    momentum: round(momentum),
    freshnessPenalty: round(-freshnessPenalty * w.freshnessPenalty),
    decay: round(decay),
    rawScore: round(rawScore),
    finalScore: round(finalScore),
  };
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
