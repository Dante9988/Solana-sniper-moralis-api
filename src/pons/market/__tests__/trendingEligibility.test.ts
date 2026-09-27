/**
 * Phase 7E.4 §2/§8 — classification, and the A/B/C/D acceptance dataset.
 *
 * A, B, C and D are the tokens the brief specifies. They are the contract for what Trending
 * must and must not promote, so they are asserted end to end: classification first, then the
 * ranking among the ones that survive, then the B→C rotation.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_TRENDING_CONFIG } from "../trendingConfig";
import { classifyEligibility, liquidityRatioBps, type EligibilityInput } from "../trendingEligibility";
import { buildCohort, scoreToken, type TrendingMetrics } from "../trendingRank";

const CONFIG = DEFAULT_TRENDING_CONFIG;
const MINUTE = 60_000;

function input(overrides: Partial<EligibilityInput> = {}): EligibilityInput {
  return {
    valuationUsd: 450_000,
    valuationBasis: "FDV",
    liquidityUsd: 75_000,
    trades1h: 220,
    traders1h: 90,
    snapshotAgeMs: 30_000,
    lastTradeAgeMs: 60_000,
    routeVerified: true,
    tradingUnavailable: false,
    ...overrides,
  };
}

describe("classification never claims safety", () => {
  it("returns a classification and evidence, not a boolean", () => {
    const result = classifyEligibility(input(), CONFIG);
    expect(result.classification).toBe("ELIGIBLE");
    expect(Array.isArray(result.reasons)).toBe(true);
    expect(result).not.toHaveProperty("safe");
  });
});

describe("UNVERIFIED means we could not tell, not that something is wrong", () => {
  it.each([
    ["valuation missing", { valuationUsd: null }, "VALUATION_UNKNOWN"],
    ["liquidity missing", { liquidityUsd: null }, "LIQUIDITY_UNKNOWN"],
    ["no snapshot", { snapshotAgeMs: null }, "SNAPSHOT_UNAVAILABLE"],
    ["route not provable", { routeVerified: false }, "UNVERIFIED_ROUTE"],
  ])("%s", (_label, overrides, reason) => {
    const result = classifyEligibility(input(overrides as Partial<EligibilityInput>), CONFIG);
    expect(result.classification).toBe("UNVERIFIED");
    expect(result.reasons).toContain(reason);
  });

  it("is preferred over HIGH_RISK when evidence is simply absent", () => {
    // Missing liquidity data is not the same statement as measured-zero liquidity.
    expect(classifyEligibility(input({ liquidityUsd: null }), CONFIG).classification).toBe("UNVERIFIED");
    expect(classifyEligibility(input({ liquidityUsd: 0 }), CONFIG).classification).toBe("HIGH_RISK");
  });
});

describe("HIGH_RISK is a measured severe problem", () => {
  it("flags a token with no liquidity at all", () => {
    const result = classifyEligibility(input({ liquidityUsd: 0 }), CONFIG);
    expect(result.classification).toBe("HIGH_RISK");
    expect(result.reasons).toContain("NO_LIQUIDITY");
  });

  it("flags the chain's median shell: a valuation with a rounding error of liquidity behind it", () => {
    // The real NAKED: $4,528 valuation, $7 liquidity — 15 bps. You can buy and not sell.
    const result = classifyEligibility(input({ valuationUsd: 4_528, liquidityUsd: 7 }), CONFIG);
    expect(result.classification).toBe("HIGH_RISK");
    expect(result.reasons).toContain("LIQUIDITY_RATIO_SEVERE");
  });

  it("flags a venue that says the token cannot be traded", () => {
    expect(classifyEligibility(input({ tradingUnavailable: true }), CONFIG).classification).toBe("HIGH_RISK");
  });
});

describe("CAUTION is tradable but below a promotion bar", () => {
  it.each([
    ["valuation", { valuationUsd: 9_000 }, "VALUATION_BELOW_FLOOR"],
    ["liquidity", { valuationUsd: 60_000, liquidityUsd: 1_500 }, "LIQUIDITY_BELOW_FLOOR"],
    ["trade count", { trades1h: 4 }, "LOW_TRADE_COUNT"],
    ["trader count", { traders1h: 2 }, "LOW_UNIQUE_TRADER_COUNT"],
    ["stale snapshot", { snapshotAgeMs: 20 * MINUTE }, "STALE_MARKET_SNAPSHOT"],
    ["stale last trade", { lastTradeAgeMs: 120 * MINUTE }, "STALE_LAST_TRADE"],
  ])("%s below its floor", (_label, overrides, reason) => {
    const result = classifyEligibility(input(overrides as Partial<EligibilityInput>), CONFIG);
    expect(result.classification).toBe("CAUTION");
    expect(result.reasons).toContain(reason);
  });

  it("reports every failing bar, not just the first", () => {
    const result = classifyEligibility(input({ valuationUsd: 9_000, trades1h: 2, traders1h: 1 }), CONFIG);
    expect(result.reasons).toEqual(expect.arrayContaining(["VALUATION_BELOW_FLOOR", "LOW_TRADE_COUNT", "LOW_UNIQUE_TRADER_COUNT"]));
  });

  it("is still excluded from default Trending", () => {
    expect(classifyEligibility(input({ traders1h: 2 }), CONFIG).classification).not.toBe("ELIGIBLE");
  });
});

describe("liquidityRatioBps", () => {
  it("is null when either side is unknown, never zero", () => {
    expect(liquidityRatioBps(null, 1_000)).toBeNull();
    expect(liquidityRatioBps(100, null)).toBeNull();
    expect(liquidityRatioBps(100, 0)).toBeNull();
  });

  it("matches the real cohort", () => {
    expect(liquidityRatioBps(7, 4_528)).toBe(15); // NAKED
    expect(liquidityRatioBps(11_563, 14_513)).toBe(7_967); // KEE, 79.67%
  });
});

// --- §8: the acceptance dataset --------------------------------------------------------

const A: EligibilityInput = input({ valuationUsd: 3_000, liquidityUsd: 10, trades1h: 3, traders1h: 1, lastTradeAgeMs: 90 * MINUTE });
const B: EligibilityInput = input({ valuationUsd: 450_000, liquidityUsd: 75_000, trades1h: 220, traders1h: 90 });
const C: EligibilityInput = input({ valuationUsd: 2_000_000, liquidityUsd: 400_000, trades1h: 600, traders1h: 150 });
const D: EligibilityInput = input({ valuationUsd: 20_000, liquidityUsd: 5_000, trades1h: 1, traders1h: 1, lastTradeAgeMs: 2 * MINUTE });

function m(overrides: Partial<TrendingMetrics>): TrendingMetrics {
  return {
    volume5mUsd: 0, volume1hUsd: 0, baselineHourlyUsd: null, trades1h: 0, traders1h: 0,
    liquidityUsd: 0, liquidityRatioBps: 0, valuationChange1h: 0, lastTradeAgeMs: 0, snapshotAgeMs: 0,
    ...overrides,
  };
}

describe("§8 acceptance — A/B/C/D", () => {
  it("A (a $3K shell with a huge surge from nearly zero) is never ELIGIBLE", () => {
    const result = classifyEligibility(A, CONFIG);
    expect(result.classification).toBe("HIGH_RISK"); // $10 against $3,000 is 33 bps
    expect(result.classification).not.toBe("ELIGIBLE");
  });

  it("B and C are both ELIGIBLE", () => {
    expect(classifyEligibility(B, CONFIG).classification).toBe("ELIGIBLE");
    expect(classifyEligibility(C, CONFIG).classification).toBe("ELIGIBLE");
  });

  it("D (new but barely traded) is not ELIGIBLE merely for being new", () => {
    const result = classifyEligibility(D, CONFIG);
    expect(result.classification).toBe("CAUTION");
    expect(result.reasons).toEqual(expect.arrayContaining(["LOW_TRADE_COUNT", "LOW_UNIQUE_TRADER_COUNT"]));
  });

  it("C is not buried by B just because B's relative surge is larger", () => {
    const bMetrics = m({ volume5mUsd: 12_000, volume1hUsd: 90_000, baselineHourlyUsd: 30_000, trades1h: 220, traders1h: 90, liquidityUsd: 75_000, liquidityRatioBps: 1_666 });
    const cMetrics = m({ volume5mUsd: 42_000, volume1hUsd: 500_000, baselineHourlyUsd: 450_000, trades1h: 600, traders1h: 150, liquidityUsd: 400_000, liquidityRatioBps: 2_000 });
    const cohort = buildCohort([bMetrics, cMetrics]);

    const b = scoreToken(bMetrics, cohort, CONFIG);
    const c = scoreToken(cMetrics, cohort, CONFIG);

    // B accelerates harder; C does far more actual business. C must stay competitive.
    expect(b.acceleration).toBeGreaterThan(c.acceleration);
    expect(c.finalScore).toBeGreaterThan(b.finalScore);
  });

  it("rotation: when activity moves from B to C, C rises and B decays", () => {
    // T0 — B is hot, C is merely large and steady.
    const b0 = m({ volume5mUsd: 20_000, volume1hUsd: 120_000, baselineHourlyUsd: 20_000, trades1h: 400, traders1h: 140, liquidityUsd: 75_000, liquidityRatioBps: 1_666, lastTradeAgeMs: 0 });
    const c0 = m({ volume5mUsd: 8_000, volume1hUsd: 100_000, baselineHourlyUsd: 100_000, trades1h: 200, traders1h: 60, liquidityUsd: 400_000, liquidityRatioBps: 2_000, lastTradeAgeMs: 0 });
    const t0 = buildCohort([b0, c0]);
    expect(scoreToken(b0, t0, CONFIG).finalScore).toBeGreaterThan(scoreToken(c0, t0, CONFIG).finalScore);

    // T1 — capital rotates. B cools and stops trading; C accelerates.
    const b1 = { ...b0, volume5mUsd: 200, volume1hUsd: 30_000, trades1h: 40, traders1h: 12, lastTradeAgeMs: 40 * MINUTE };
    const c1 = { ...c0, volume5mUsd: 45_000, volume1hUsd: 300_000, baselineHourlyUsd: 100_000, trades1h: 700, traders1h: 180, lastTradeAgeMs: 0 };
    const t1 = buildCohort([b1, c1]);

    const bAfter = scoreToken(b1, t1, CONFIG);
    const cAfter = scoreToken(c1, t1, CONFIG);
    expect(cAfter.finalScore).toBeGreaterThan(bAfter.finalScore);
    // And B genuinely fell rather than merely being overtaken.
    expect(bAfter.finalScore).toBeLessThan(scoreToken(b0, t0, CONFIG).finalScore);
  });
});
