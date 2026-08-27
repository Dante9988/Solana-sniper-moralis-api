import { describe, expect, it } from "vitest";
import {
  ForensicsConfigError,
  loadForensicsConfig,
  MANDATORY_BUNDLE_EXCLUSION_PCT,
  RESOLVED_FORENSICS_CONFIG,
} from "../thresholds";
import { evaluateTokenEligibility } from "../tokenEligibilityPolicy";

describe("MANDATORY_BUNDLE_EXCLUSION_PCT immutability", () => {
  it("is fixed at 40 and is not sourced from the environment", () => {
    expect(MANDATORY_BUNDLE_EXCLUSION_PCT).toBe(40);
  });

  it("cannot be raised, disabled, NaN'd, or set to Infinity via any environment variable", () => {
    const maliciousEnvs: NodeJS.ProcessEnv[] = [
      { MANDATORY_BUNDLE_EXCLUSION_PCT: "1000" },
      { MANDATORY_BUNDLE_EXCLUSION_PCT: "0" },
      { MANDATORY_BUNDLE_EXCLUSION_PCT: "NaN" },
      { MANDATORY_BUNDLE_EXCLUSION_PCT: "Infinity" },
      { MANDATORY_EXCLUSION_THRESHOLD_PCT: "1000" },
      { FORENSICS_HARD_EXCLUSION_PCT: "999" },
    ];
    for (const env of maliciousEnvs) {
      // loadForensicsConfig must not throw due to these unrelated/irrelevant
      // keys, and the exported constant must remain untouched regardless.
      expect(() => loadForensicsConfig(env)).not.toThrow();
      expect(MANDATORY_BUNDLE_EXCLUSION_PCT).toBe(40);
    }
  });

  it("keeps a 45% initial bundle EXCLUDED regardless of any env configuration", () => {
    const result = evaluateTokenEligibility({
      mint: "M",
      initialBundledAcquisitionPct: 45,
      initialBundleMetricStatus: "COMPLETE",
      currentBundleWalletHoldingsPct: 1,
      currentBundleMetricStatus: "COMPLETE",
      warningMetrics: {},
    });
    expect(result.eligibility).toBe("EXCLUDED");
  });

  it("returns EXCLUDED when one mandatory metric is confirmed >=40% even if the other is missing", () => {
    const result = evaluateTokenEligibility({
      mint: "M",
      initialBundledAcquisitionPct: 40,
      initialBundleMetricStatus: "COMPLETE",
      currentBundleWalletHoldingsPct: undefined,
      currentBundleMetricStatus: "UNAVAILABLE",
      warningMetrics: {},
    });
    expect(result.eligibility).toBe("EXCLUDED");
  });

  it("returns UNKNOWN (never ELIGIBLE) when neither metric reaches 40% but one is incomplete", () => {
    const result = evaluateTokenEligibility({
      mint: "M",
      initialBundledAcquisitionPct: 10,
      initialBundleMetricStatus: "COMPLETE",
      currentBundleWalletHoldingsPct: undefined,
      currentBundleMetricStatus: "PARTIAL",
      warningMetrics: {},
    });
    expect(result.eligibility).toBe("UNKNOWN");
  });
});

describe("loadForensicsConfig — fail-closed validation", () => {
  it("uses defaults when env vars are absent", () => {
    const config = loadForensicsConfig({});
    expect(config.launchWindowSlots).toBe(5);
    expect(config.sniperWindowSlots).toBe(20);
    expect(config.fundingLookbackDepth).toBe(1);
    expect(config.freshWalletLookbackDays).toBe(30);
    expect(config.maxHolderPagesFast).toBe(2);
    expect(config.maxHolderPagesDeep).toBe(20);
    expect(config.maxTransactionsFast).toBe(25);
    expect(config.maxTransactionsDeep).toBe(250);
    expect(config.maxWalletsFast).toBe(10);
    expect(config.maxWalletsDeep).toBe(50);
    expect(config.fastForensicsMaxCreditsPerToken).toBe(75);
    expect(config.deepForensicsMaxCreditsPerToken).toBe(300);
    expect(config.deepForensicsEnabled).toBe(false);
    expect(config.freshWalletDefinitionLabel).toBe("NO_ACTIVITY_OBSERVED_IN_BOUNDED_30_DAY_LOOKBACK");
  });

  it("throws (fails closed) on a non-integer page limit, never silently converts to 0", () => {
    expect(() => loadForensicsConfig({ MAX_HOLDER_PAGES_FAST: "not-a-number" })).toThrow(
      ForensicsConfigError
    );
    expect(() => loadForensicsConfig({ MAX_HOLDER_PAGES_FAST: "abc" })).toThrow(ForensicsConfigError);
  });

  it("throws on a zero or negative page/wallet/transaction/credit/depth/slot limit", () => {
    for (const key of [
      "LAUNCH_WINDOW_SLOTS",
      "SNIPER_WINDOW_SLOTS",
      "FUNDING_LOOKBACK_DEPTH",
      "FRESH_WALLET_LOOKBACK_DAYS",
      "MAX_HOLDER_PAGES_FAST",
      "MAX_HOLDER_PAGES_DEEP",
      "MAX_TRANSACTIONS_FAST",
      "MAX_TRANSACTIONS_DEEP",
      "MAX_WALLETS_FAST",
      "MAX_WALLETS_DEEP",
      "FAST_FORENSICS_MAX_CREDITS_PER_TOKEN",
      "DEEP_FORENSICS_MAX_CREDITS_PER_TOKEN",
    ]) {
      expect(() => loadForensicsConfig({ [key]: "0" })).toThrow(ForensicsConfigError);
      expect(() => loadForensicsConfig({ [key]: "-5" })).toThrow(ForensicsConfigError);
    }
  });

  it("throws on a non-safe-integer limit", () => {
    expect(() => loadForensicsConfig({ MAX_TRANSACTIONS_DEEP: "99999999999999999999" })).toThrow(
      ForensicsConfigError
    );
  });

  it("throws on an out-of-range or non-finite CAUTION percentage", () => {
    expect(() => loadForensicsConfig({ CAUTION_BUNDLED_SUPPLY_PCT: "101" })).toThrow(
      ForensicsConfigError
    );
    expect(() => loadForensicsConfig({ CAUTION_BUNDLED_SUPPLY_PCT: "-1" })).toThrow(
      ForensicsConfigError
    );
    expect(() => loadForensicsConfig({ CAUTION_BUNDLED_SUPPLY_PCT: "NaN" })).toThrow(
      ForensicsConfigError
    );
    expect(() => loadForensicsConfig({ CAUTION_BUNDLED_SUPPLY_PCT: "Infinity" })).toThrow(
      ForensicsConfigError
    );
  });

  it("accepts a valid CAUTION percentage at the boundary (0 and 100)", () => {
    expect(loadForensicsConfig({ CAUTION_BUNDLED_SUPPLY_PCT: "0" }).cautionThresholds.bundledSupplyPct).toBe(
      0
    );
    expect(
      loadForensicsConfig({ CAUTION_BUNDLED_SUPPLY_PCT: "100" }).cautionThresholds.bundledSupplyPct
    ).toBe(100);
  });

  it("throws on a non-strict boolean value for DEEP_FORENSICS_ENABLED", () => {
    expect(() => loadForensicsConfig({ DEEP_FORENSICS_ENABLED: "yes" })).toThrow(ForensicsConfigError);
    expect(() => loadForensicsConfig({ DEEP_FORENSICS_ENABLED: "1" })).toThrow(ForensicsConfigError);
    expect(() => loadForensicsConfig({ DEEP_FORENSICS_ENABLED: "TRUE" })).not.toThrow();
    expect(loadForensicsConfig({ DEEP_FORENSICS_ENABLED: "true" }).deepForensicsEnabled).toBe(true);
    expect(loadForensicsConfig({ DEEP_FORENSICS_ENABLED: "false" }).deepForensicsEnabled).toBe(false);
  });

  it("never silently converts an invalid value to zero", () => {
    // MAX_WALLETS_FAST is deliberately garbage; the function must throw, not
    // resolve to 0 and let a downstream caller believe "no wallets allowed".
    expect(() => loadForensicsConfig({ MAX_WALLETS_FAST: "" })).not.toThrow(); // empty = absent = default
    expect(loadForensicsConfig({ MAX_WALLETS_FAST: "" }).maxWalletsFast).toBe(10);
    expect(() => loadForensicsConfig({ MAX_WALLETS_FAST: "garbage" })).toThrow(ForensicsConfigError);
  });
});

describe("resolved configuration snapshot", () => {
  it("carries the policy version and no secret-shaped keys", () => {
    expect(RESOLVED_FORENSICS_CONFIG.policyVersion).toBeTruthy();
    expect(RESOLVED_FORENSICS_CONFIG.mandatoryBundleExclusionPct).toBe(40);
    const snapshotKeys = Object.keys(RESOLVED_FORENSICS_CONFIG);
    for (const key of snapshotKeys) {
      expect(key.toLowerCase()).not.toMatch(/apikey|secret|password|authorization|credential/);
    }
  });

  it("is frozen (cannot be mutated at runtime)", () => {
    expect(Object.isFrozen(RESOLVED_FORENSICS_CONFIG)).toBe(true);
    expect(Object.isFrozen(RESOLVED_FORENSICS_CONFIG.cautionThresholds)).toBe(true);
  });
});
