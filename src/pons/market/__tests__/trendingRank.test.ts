/**
 * Phase 7E.4 §3/§4 — the score, and the pathology it exists to remove.
 *
 * The headline test is `$20/h → $500/h must not outrank $200K/h → $350K/h`. That is the exact
 * comparison the brief calls out, and it is the reason the old `volume1h × surge × acceleration`
 * formula was replaced rather than tuned.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_TRENDING_CONFIG, loadTrendingConfig } from "../trendingConfig";
import { accelerationScore, buildCohort, decayFactor, percentileRank, scoreToken, type TrendingMetrics } from "../trendingRank";

const CONFIG = DEFAULT_TRENDING_CONFIG;
const MINUTE = 60_000;

function metrics(overrides: Partial<TrendingMetrics> = {}): TrendingMetrics {
  return {
    volume5mUsd: 100,
    volume1hUsd: 1_000,
    baselineHourlyUsd: 900,
    trades1h: 40,
    traders1h: 15,
    liquidityUsd: 20_000,
    liquidityRatioBps: 1_500,
    valuationChange1h: 0,
    lastTradeAgeMs: 0,
    snapshotAgeMs: 0,
    ...overrides,
  };
}

/** The two tokens from the brief, plus filler so percentiles have a cohort to rank within. */
const TINY_SURGE = metrics({ volume5mUsd: 60, volume1hUsd: 500, baselineHourlyUsd: 20, trades1h: 12, traders1h: 4, liquidityUsd: 3_000, liquidityRatioBps: 400 });
const BIG_STEADY = metrics({ volume5mUsd: 30_000, volume1hUsd: 350_000, baselineHourlyUsd: 200_000, trades1h: 900, traders1h: 120, liquidityUsd: 400_000, liquidityRatioBps: 2_000 });

describe("percentileRank", () => {
  it("bounds to [0,1] and orders correctly", () => {
    const sorted = [0, 1, 5, 10, 100];
    expect(percentileRank(sorted, 0)).toBe(0);
    expect(percentileRank(sorted, 100)).toBe(1);
    expect(percentileRank(sorted, 5)).toBeGreaterThan(0);
    expect(percentileRank(sorted, 5)).toBeLessThan(1);
  });

  it("does not reward a token for being unremarkable in a cohort full of zeroes", () => {
    // Half the chain trades nothing; those tokens must not land mid-table.
    const sorted = [0, 0, 0, 0, 0, 0, 10, 50, 100, 1000];
    expect(percentileRank(sorted, 0)).toBe(0);
  });

  it("handles degenerate cohorts", () => {
    expect(percentileRank([], 5)).toBe(0);
    expect(percentileRank([7], 7)).toBe(1);
  });
});

describe("acceleration is compressed, not explosive", () => {
  it("rewards a 25x surge only slightly more than a 1.75x one", () => {
    const tiny = accelerationScore(metrics({ volume1hUsd: 500, baselineHourlyUsd: 20, volume5mUsd: 40 }), CONFIG);
    const big = accelerationScore(metrics({ volume1hUsd: 350_000, baselineHourlyUsd: 200_000, volume5mUsd: 30_000 }), CONFIG);
    expect(tiny).toBeGreaterThan(big);
    // The whole point: the gap is a fraction, not a factor of fourteen.
    expect(tiny - big).toBeLessThan(0.5);
    expect(tiny).toBeLessThanOrEqual(1);
  });

  it("is bounded above by the configured cap however small the baseline", () => {
    const absurd = accelerationScore(metrics({ volume1hUsd: 1_000_000, baselineHourlyUsd: 0.000001, volume5mUsd: 900_000 }), CONFIG);
    expect(absurd).toBeLessThanOrEqual(1);
  });

  it("gives a token with no measurable rate at all the midpoint, not a maximal surge", () => {
    // A brand new launch has no baseline and nothing to compare its own hour against.
    // Claiming it exploded would be inventing evidence; claiming it is decelerating would
    // equally be. It gets the midpoint, and the eligibility gates decide whether it belongs.
    const fresh = accelerationScore(metrics({ baselineHourlyUsd: null, volume1hUsd: 0, volume5mUsd: 0 }), CONFIG);
    expect(fresh).toBe(0.5);
  });

  it("scores a perfectly flat rate as no acceleration, even with no baseline", () => {
    // volume5m * 12 === volume1h means the last five minutes matched the hour's own pace.
    const flat = accelerationScore(metrics({ baselineHourlyUsd: null, volume1hUsd: 1_200, volume5mUsd: 100 }), CONFIG);
    expect(flat).toBe(0);
  });
});

describe("the brief's pathology", () => {
  it("does NOT let $20/h -> $500/h outrank $200K/h -> $350K/h", () => {
    const cohort = buildCohort([TINY_SURGE, BIG_STEADY, metrics(), metrics({ volume1hUsd: 50, trades1h: 2, traders1h: 1, liquidityUsd: 10 })]);
    const tiny = scoreToken(TINY_SURGE, cohort, CONFIG);
    const big = scoreToken(BIG_STEADY, cohort, CONFIG);

    expect(big.finalScore).toBeGreaterThan(tiny.finalScore);
    // Acceleration still favours the small one — it just cannot carry the whole ranking.
    expect(tiny.acceleration).toBeGreaterThan(big.acceleration);
    expect(big.currentActivity).toBeGreaterThan(tiny.currentActivity);
    expect(big.traderBreadth).toBeGreaterThan(tiny.traderBreadth);
  });

  it("keeps every component bounded so none can dominate by unit scale", () => {
    const cohort = buildCohort([TINY_SURGE, BIG_STEADY, metrics()]);
    for (const m of [TINY_SURGE, BIG_STEADY, metrics()]) {
      const s = scoreToken(m, cohort, CONFIG);
      for (const key of ["currentActivity", "acceleration", "traderBreadth", "liquidityQuality", "momentum"] as const) {
        expect(s[key], `${key}`).toBeGreaterThanOrEqual(0);
        expect(s[key], `${key}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it("reports every component so a ranking can be explained", () => {
    const cohort = buildCohort([BIG_STEADY, TINY_SURGE]);
    const s = scoreToken(BIG_STEADY, cohort, CONFIG);
    expect(Object.keys(s).sort()).toEqual(
      ["acceleration", "currentActivity", "decay", "finalScore", "freshnessPenalty", "liquidityQuality", "momentum", "rawScore", "traderBreadth"].sort()
    );
  });
});

describe("decay", () => {
  it("halves the score every half-life", () => {
    expect(decayFactor(0, CONFIG)).toBe(1);
    expect(decayFactor(CONFIG.decayHalfLifeMs, CONFIG)).toBeCloseTo(0.5, 6);
    expect(decayFactor(CONFIG.decayHalfLifeMs * 2, CONFIG)).toBeCloseTo(0.25, 6);
  });

  it("gives a token that has never traded no score at all", () => {
    expect(decayFactor(null, CONFIG)).toBe(0);
  });

  it("makes a historic spike fall below a currently-active token", () => {
    const cohort = buildCohort([BIG_STEADY, TINY_SURGE, metrics()]);
    const hotThenQuiet = { ...BIG_STEADY, lastTradeAgeMs: 90 * MINUTE };
    const steadilyActive = { ...metrics(), lastTradeAgeMs: 0 };

    const stale = scoreToken(hotThenQuiet, cohort, CONFIG);
    const live = scoreToken(steadilyActive, cohort, CONFIG);

    // Its raw activity is still the best on the chain; it falls purely because attention left.
    expect(stale.rawScore).toBeGreaterThan(live.rawScore);
    expect(stale.finalScore).toBeLessThan(live.finalScore);
  });

  it("never returns a negative score", () => {
    const cohort = buildCohort([metrics()]);
    const awful = scoreToken(metrics({ volume1hUsd: 0, volume5mUsd: 0, trades1h: 0, traders1h: 0, liquidityUsd: 0, liquidityRatioBps: 0, snapshotAgeMs: 60 * MINUTE }), cohort, CONFIG);
    expect(awful.finalScore).toBeGreaterThanOrEqual(0);
  });
});

describe("configuration", () => {
  it("reads defaults derived from the live distribution", () => {
    const config = loadTrendingConfig({} as NodeJS.ProcessEnv);
    // Clears the ~$4.5K shell cluster whose p75 is $5.7K.
    expect(config.thresholds.minValuationUsd).toBe(15_000);
    expect(config.thresholds.minLiquidityUsd).toBe(2_000);
    expect(config.thresholds.minLiquidityRatioBps).toBe(200);
  });

  it("lets every threshold be overridden without a code change", () => {
    const config = loadTrendingConfig({ TRENDING_MIN_VALUATION_USD: "50000", TRENDING_DECAY_HALF_LIFE_MS: "60000" } as NodeJS.ProcessEnv);
    expect(config.thresholds.minValuationUsd).toBe(50_000);
    expect(config.decayHalfLifeMs).toBe(60_000);
  });

  it("refuses a malformed override rather than silently using the default", () => {
    expect(() => loadTrendingConfig({ TRENDING_MIN_LIQUIDITY_USD: "lots" } as NodeJS.ProcessEnv)).toThrow(/non-negative number/);
    expect(() => loadTrendingConfig({ TRENDING_MIN_TRADES_1H: "-3" } as NodeJS.ProcessEnv)).toThrow();
  });
});
