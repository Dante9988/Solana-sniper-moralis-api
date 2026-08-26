import { describe, expect, it } from "vitest";
import { evaluateTokenEligibility, TokenEligibilityInput } from "../tokenEligibilityPolicy";
import { FORENSICS_POLICY_VERSION } from "../thresholds";

const NOW = new Date("2026-08-25T00:00:00.000Z");

function baseInput(overrides: Partial<TokenEligibilityInput> = {}): TokenEligibilityInput {
  return {
    mint: "TestMint111111111111111111111111111111111",
    initialBundledAcquisitionPct: 2,
    initialBundleMetricStatus: "COMPLETE",
    currentBundleWalletHoldingsPct: 2,
    currentBundleMetricStatus: "COMPLETE",
    warningMetrics: {},
    evaluatedAt: NOW,
    ...overrides,
  };
}

describe("evaluateTokenEligibility — mandatory 40% exclusion", () => {
  it("does not exclude at exactly 39.99%", () => {
    const result = evaluateTokenEligibility(
      baseInput({ initialBundledAcquisitionPct: 39.99, currentBundleWalletHoldingsPct: 5 })
    );
    expect(result.eligibility).not.toBe("EXCLUDED");
  });

  it("excludes at exactly 40.00% (initial)", () => {
    const result = evaluateTokenEligibility(
      baseInput({ initialBundledAcquisitionPct: 40, currentBundleWalletHoldingsPct: 1 })
    );
    expect(result.eligibility).toBe("EXCLUDED");
    expect(result.displaySeverity).toBe("DANGEROUS_EXCLUDED");
    expect(result.reasonCodes).toContain("INITIAL_BUNDLED_ACQUISITION_AT_OR_ABOVE_40_PCT");
  });

  it("excludes at exactly 40.00% (current)", () => {
    const result = evaluateTokenEligibility(
      baseInput({ initialBundledAcquisitionPct: 1, currentBundleWalletHoldingsPct: 40 })
    );
    expect(result.eligibility).toBe("EXCLUDED");
    expect(result.reasonCodes).toContain("CURRENT_BUNDLE_WALLET_HOLDINGS_AT_OR_ABOVE_40_PCT");
  });

  it("excludes above 40%", () => {
    const result = evaluateTokenEligibility(
      baseInput({ initialBundledAcquisitionPct: 55.4, currentBundleWalletHoldingsPct: 3 })
    );
    expect(result.eligibility).toBe("EXCLUDED");
  });

  it("keeps an initial >=40% exclusion even after the bundle sells down below 40% current", () => {
    const result = evaluateTokenEligibility(
      baseInput({ initialBundledAcquisitionPct: 45, currentBundleWalletHoldingsPct: 8 })
    );
    expect(result.eligibility).toBe("EXCLUDED");
    expect(result.reasonCodes).toContain("INITIAL_BUNDLED_ACQUISITION_AT_OR_ABOVE_40_PCT");
  });

  it("excludes when the current linked cluster grows above 40% even if initial was below 40%", () => {
    const result = evaluateTokenEligibility(
      baseInput({ initialBundledAcquisitionPct: 6, currentBundleWalletHoldingsPct: 41 })
    );
    expect(result.eligibility).toBe("EXCLUDED");
    expect(result.reasonCodes).toContain("CURRENT_BUNDLE_WALLET_HOLDINGS_AT_OR_ABOVE_40_PCT");
  });

  it("AI cannot override an exclusion: unknown/extra input fields are ignored", () => {
    const withInjectedOverride = evaluateTokenEligibility({
      ...baseInput({ initialBundledAcquisitionPct: 60, currentBundleWalletHoldingsPct: 60 }),
      // @ts-expect-error intentionally simulating untyped AI-injected override attempts
      aiSuggestedEligibility: "ELIGIBLE",
      eligibility: "ELIGIBLE",
    });
    expect(withInjectedOverride.eligibility).toBe("EXCLUDED");
  });
});

describe("evaluateTokenEligibility — missing/estimated/incomplete evidence", () => {
  it("returns UNKNOWN when the initial metric is UNAVAILABLE (unavailable transaction history)", () => {
    const result = evaluateTokenEligibility(
      baseInput({
        initialBundledAcquisitionPct: undefined,
        initialBundleMetricStatus: "UNAVAILABLE",
      })
    );
    expect(result.eligibility).toBe("UNKNOWN");
    expect(result.displaySeverity).toBe("UNKNOWN");
    expect(result.reasonCodes).toContain("MANDATORY_BUNDLE_EVIDENCE_INCOMPLETE");
    expect(result.requiredEvidenceComplete).toBe(false);
  });

  it("returns UNKNOWN when the current metric is PARTIAL (incomplete holder pagination)", () => {
    const result = evaluateTokenEligibility(
      baseInput({
        currentBundleWalletHoldingsPct: undefined,
        currentBundleMetricStatus: "PARTIAL",
      })
    );
    expect(result.eligibility).toBe("UNKNOWN");
  });

  it("returns UNKNOWN when a metric is ESTIMATED_ONLY, never ELIGIBLE from an estimate", () => {
    const result = evaluateTokenEligibility(
      baseInput({
        initialBundledAcquisitionPct: undefined,
        initialBundleMetricStatus: "ESTIMATED_ONLY",
      })
    );
    expect(result.eligibility).toBe("UNKNOWN");
    expect(result.eligibility).not.toBe("ELIGIBLE");
  });

  it("never returns ELIGIBLE purely because percentages are absent (never treats missing as 0/safe)", () => {
    const result = evaluateTokenEligibility(
      baseInput({
        initialBundledAcquisitionPct: undefined,
        initialBundleMetricStatus: "UNAVAILABLE",
        currentBundleWalletHoldingsPct: undefined,
        currentBundleMetricStatus: "UNAVAILABLE",
      })
    );
    expect(result.eligibility).toBe("UNKNOWN");
  });
});

describe("evaluateTokenEligibility — CAUTION warning thresholds", () => {
  it("flags CAUTION when the max mandatory pct is at/above the 20% bundledSupplyPct warning", () => {
    const result = evaluateTokenEligibility(
      baseInput({ initialBundledAcquisitionPct: 25, currentBundleWalletHoldingsPct: 3 })
    );
    expect(result.eligibility).toBe("CAUTION");
    expect(result.displaySeverity).toBe("WARNING");
    expect(result.reasonCodes).toContain("BUNDLED_SUPPLY_WARNING_THRESHOLD");
  });

  it("flags CAUTION for developerClusterHoldingsPct >= 5", () => {
    const result = evaluateTokenEligibility(
      baseInput({ warningMetrics: { developerClusterHoldingsPct: 5 } })
    );
    expect(result.eligibility).toBe("CAUTION");
    expect(result.reasonCodes).toContain("DEVELOPER_CLUSTER_HOLDINGS_WARNING_THRESHOLD");
  });

  it("flags CAUTION for adjustedTop10HoldingsPct >= 30", () => {
    const result = evaluateTokenEligibility(
      baseInput({ warningMetrics: { adjustedTop10HoldingsPct: 30 } })
    );
    expect(result.eligibility).toBe("CAUTION");
    expect(result.reasonCodes).toContain("ADJUSTED_TOP10_HOLDINGS_WARNING_THRESHOLD");
  });

  it("flags CAUTION for insiderClusterHoldingsPct >= 15", () => {
    const result = evaluateTokenEligibility(
      baseInput({ warningMetrics: { insiderClusterHoldingsPct: 15 } })
    );
    expect(result.eligibility).toBe("CAUTION");
    expect(result.reasonCodes).toContain("INSIDER_CLUSTER_HOLDINGS_WARNING_THRESHOLD");
  });

  it("flags CAUTION for sniperHoldingsPct >= 20", () => {
    const result = evaluateTokenEligibility(baseInput({ warningMetrics: { sniperHoldingsPct: 20 } }));
    expect(result.eligibility).toBe("CAUTION");
    expect(result.reasonCodes).toContain("SNIPER_HOLDINGS_WARNING_THRESHOLD");
  });

  it("flags CAUTION for boundedFreshWalletHoldingsPct >= 25", () => {
    const result = evaluateTokenEligibility(
      baseInput({ warningMetrics: { boundedFreshWalletHoldingsPct: 25 } })
    );
    expect(result.eligibility).toBe("CAUTION");
    expect(result.reasonCodes).toContain("BOUNDED_FRESH_WALLET_HOLDINGS_WARNING_THRESHOLD");
  });

  it("does not warn just below a threshold", () => {
    const result = evaluateTokenEligibility(
      baseInput({ warningMetrics: { developerClusterHoldingsPct: 4.99 } })
    );
    expect(result.eligibility).toBe("ELIGIBLE");
  });
});

describe("evaluateTokenEligibility — legitimate distributed launch", () => {
  it("returns ELIGIBLE when both mandatory metrics are complete, low, and no warnings trigger", () => {
    const result = evaluateTokenEligibility(
      baseInput({ initialBundledAcquisitionPct: 1.2, currentBundleWalletHoldingsPct: 0.8 })
    );
    expect(result.eligibility).toBe("ELIGIBLE");
    expect(result.displaySeverity).toBe("NORMAL");
    expect(result.requiredEvidenceComplete).toBe(true);
  });
});

describe("evaluateTokenEligibility — assessment shape", () => {
  it("always stamps the current policy version and evaluatedAt", () => {
    const result = evaluateTokenEligibility(baseInput());
    expect(result.policyVersion).toBe(FORENSICS_POLICY_VERSION);
    expect(result.evaluatedAt).toBe(NOW);
  });

  it("evaluatedMetrics reflects null (not 0) for absent percentages", () => {
    const result = evaluateTokenEligibility(
      baseInput({
        initialBundledAcquisitionPct: undefined,
        initialBundleMetricStatus: "UNAVAILABLE",
      })
    );
    expect(result.evaluatedMetrics.initialBundledAcquisitionPct).toBeNull();
  });

  it("is a pure function: identical input always yields an identical result", () => {
    const input = baseInput({ initialBundledAcquisitionPct: 25 });
    const first = evaluateTokenEligibility(input);
    const second = evaluateTokenEligibility(input);
    expect(second).toEqual(first);
  });
});
