/**
 * Phase 7E.4 §1 — every threshold and weight Trending uses, in one place.
 *
 * None of these are magic constants picked to feel right. They were derived from the last
 * fully-indexed hour on Robinhood Chain (594 tokens traded, 538 with an OK snapshot), whose
 * distribution is recorded beside each floor below. The chain is dominated by factory-default
 * shells: the MEDIAN traded token has a ~$4,500 valuation and **$2.28** of liquidity, and
 * half of everything that trades has liquidity worth 0.05% of its valuation — i.e. you can
 * buy it and cannot sell it.
 *
 * Every value is overridable by environment variable so a threshold can be tuned without a
 * deploy of new logic, and so tests can pin their own.
 */

export interface TrendingThresholds {
  /** Valuation floor. p75 of traded tokens is $5.7K, so this clears the shell cluster whole. */
  minValuationUsd: number;
  /** Liquidity floor. p50 is $2.28; this excludes roughly the bottom 70%. */
  minLiquidityUsd: number;
  /** Liquidity as a fraction of valuation, in bps. p50 is 5 bps; the healthy cohort is 800–8000. */
  minLiquidityRatioBps: number;
  minTrades1h: number;
  minTraders1h: number;
  /** A snapshot older than this cannot support a ranking claim. */
  maxSnapshotAgeMs: number;
  /** A token with no trade this recent is decayed out rather than ranked on a stale hour. */
  maxLastTradeAgeMs: number;
  /** Below this, a token is CAUTION rather than HIGH_RISK — thin, not broken. */
  cautionLiquidityRatioBps: number;
  cautionMinLiquidityUsd: number;
}

export interface TrendingWeights {
  currentActivity: number;
  acceleration: number;
  traderBreadth: number;
  liquidityQuality: number;
  momentum: number;
  /** Subtracted, not added. */
  freshnessPenalty: number;
}

export interface TrendingCoverageConfig {
  /**
   * How far behind the chain the LIVE head may be and still rank the current windows.
   *
   * §6: this is deliberately not the same thing as historical backfill lag. A backfill
   * repairing a gap from six hours ago says nothing about whether the last five minutes
   * are complete, and must not disable Trending.
   */
  maxLiveHeadLagMs: number;
  /** The windows the score actually reads. Coverage is proven for these, not for all history. */
  rollingWindowMs: number;
  baselineWindowMs: number;
}

export interface TrendingConfig {
  thresholds: TrendingThresholds;
  weights: TrendingWeights;
  coverage: TrendingCoverageConfig;
  /**
   * Half-life of the recency decay applied to the final score.
   *
   * §4: a historic spike must not pin a token near the top. A token whose last trade is one
   * half-life old keeps half its score, two half-lives a quarter, and so on — so attention
   * leaving is enough to make it fall, with no separate eviction rule.
   */
  decayHalfLifeMs: number;
  /** Acceleration is log-compressed and then clamped here, so a tiny baseline cannot dominate. */
  maxAcceleration: number;
}

const MINUTE = 60_000;

export const DEFAULT_TRENDING_CONFIG: TrendingConfig = Object.freeze({
  thresholds: Object.freeze({
    minValuationUsd: 15_000,
    minLiquidityUsd: 2_000,
    minLiquidityRatioBps: 200,
    minTrades1h: 10,
    minTraders1h: 3,
    maxSnapshotAgeMs: 5 * MINUTE,
    maxLastTradeAgeMs: 30 * MINUTE,
    cautionLiquidityRatioBps: 50,
    cautionMinLiquidityUsd: 500,
  }),
  weights: Object.freeze({
    currentActivity: 0.35,
    acceleration: 0.2,
    traderBreadth: 0.2,
    liquidityQuality: 0.2,
    momentum: 0.05,
    freshnessPenalty: 0.25,
  }),
  coverage: Object.freeze({
    maxLiveHeadLagMs: 10 * MINUTE,
    rollingWindowMs: 60 * MINUTE,
    baselineWindowMs: 6 * 60 * MINUTE,
  }),
  decayHalfLifeMs: 20 * MINUTE,
  maxAcceleration: 4,
}) as TrendingConfig;

function num(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${key} must be a non-negative number, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/**
 * Read the config, letting the environment override any single value.
 *
 * Weights are NOT normalised to sum to 1 here. They are relative contributions to a score
 * whose only meaning is the ordering it produces, and forcing them to a simplex would make
 * "raise one weight" silently lower every other.
 */
export function loadTrendingConfig(env: NodeJS.ProcessEnv = process.env): TrendingConfig {
  const d = DEFAULT_TRENDING_CONFIG;
  return Object.freeze({
    thresholds: Object.freeze({
      minValuationUsd: num(env, "TRENDING_MIN_VALUATION_USD", d.thresholds.minValuationUsd),
      minLiquidityUsd: num(env, "TRENDING_MIN_LIQUIDITY_USD", d.thresholds.minLiquidityUsd),
      minLiquidityRatioBps: num(env, "TRENDING_MIN_LIQUIDITY_RATIO_BPS", d.thresholds.minLiquidityRatioBps),
      minTrades1h: num(env, "TRENDING_MIN_TRADES_1H", d.thresholds.minTrades1h),
      minTraders1h: num(env, "TRENDING_MIN_TRADERS_1H", d.thresholds.minTraders1h),
      maxSnapshotAgeMs: num(env, "TRENDING_MAX_SNAPSHOT_AGE_MS", d.thresholds.maxSnapshotAgeMs),
      maxLastTradeAgeMs: num(env, "TRENDING_MAX_LAST_TRADE_AGE_MS", d.thresholds.maxLastTradeAgeMs),
      cautionLiquidityRatioBps: num(env, "TRENDING_CAUTION_LIQUIDITY_RATIO_BPS", d.thresholds.cautionLiquidityRatioBps),
      cautionMinLiquidityUsd: num(env, "TRENDING_CAUTION_MIN_LIQUIDITY_USD", d.thresholds.cautionMinLiquidityUsd),
    }),
    weights: Object.freeze({
      currentActivity: num(env, "TRENDING_WEIGHT_ACTIVITY", d.weights.currentActivity),
      acceleration: num(env, "TRENDING_WEIGHT_ACCELERATION", d.weights.acceleration),
      traderBreadth: num(env, "TRENDING_WEIGHT_TRADERS", d.weights.traderBreadth),
      liquidityQuality: num(env, "TRENDING_WEIGHT_LIQUIDITY", d.weights.liquidityQuality),
      momentum: num(env, "TRENDING_WEIGHT_MOMENTUM", d.weights.momentum),
      freshnessPenalty: num(env, "TRENDING_WEIGHT_FRESHNESS_PENALTY", d.weights.freshnessPenalty),
    }),
    coverage: Object.freeze({
      maxLiveHeadLagMs: num(env, "TRENDING_MAX_LIVE_HEAD_LAG_MS", d.coverage.maxLiveHeadLagMs),
      rollingWindowMs: num(env, "TRENDING_ROLLING_WINDOW_MS", d.coverage.rollingWindowMs),
      baselineWindowMs: num(env, "TRENDING_BASELINE_WINDOW_MS", d.coverage.baselineWindowMs),
    }),
    decayHalfLifeMs: num(env, "TRENDING_DECAY_HALF_LIFE_MS", d.decayHalfLifeMs),
    maxAcceleration: num(env, "TRENDING_MAX_ACCELERATION", d.maxAcceleration),
  }) as TrendingConfig;
}
