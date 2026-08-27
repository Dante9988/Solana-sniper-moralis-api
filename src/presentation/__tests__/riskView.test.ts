import { describe, expect, it } from "vitest";
import { MANDATORY_BUNDLE_EXCLUSION_PCT as POLICY_EXCLUSION_PCT } from "../../forensics/thresholds";
import { buildRiskView, MANDATORY_BUNDLE_EXCLUSION_PCT, RiskViewInput } from "../riskView";

function baseInput(overrides: Partial<RiskViewInput> = {}): RiskViewInput {
  return {
    mint: "TokenMintAddress11111111111111111111111111",
    reportStatus: "COMPLETE",
    generatedAt: new Date("2026-08-26T00:00:00Z"),
    safety: { mintAuthority: null, freezeAuthority: null, confidence: 1, lpBurned: true },
    forensics: {
      status: "COMPLETE",
      policyVersion: "phase5b.2026-08-25",
      eligibility: "ELIGIBLE",
      displaySeverity: "NORMAL",
      reasonCodes: ["MANDATORY_BUNDLE_METRICS_BELOW_WARNING_THRESHOLD"],
      requiredEvidenceComplete: true,
      initialBundledAcquisitionPct: 2,
      currentBundleWalletHoldingsPct: 1,
      completedAt: new Date("2026-08-26T00:00:00Z"),
    },
    forensicsEvidence: [],
    forensicsClusters: [],
    ...overrides,
  };
}

describe("riskView: policy constant stays in sync with forensics/thresholds.ts", () => {
  it("mirrors MANDATORY_BUNDLE_EXCLUSION_PCT exactly", () => {
    expect(MANDATORY_BUNDLE_EXCLUSION_PCT).toBe(POLICY_EXCLUSION_PCT);
  });
});

describe("riskView: verdict derivation ordering (phase6.txt §2.1)", () => {
  it("1) mandatory bundle exclusion at >=40% wins over everything else -> EXCLUDED", () => {
    const view = buildRiskView(
      baseInput({
        forensics: {
          ...baseInput().forensics,
          eligibility: "EXCLUDED",
          displaySeverity: "DANGEROUS_EXCLUDED",
          reasonCodes: ["INITIAL_BUNDLED_ACQUISITION_AT_OR_ABOVE_40_PCT"],
          initialBundledAcquisitionPct: 62,
          currentBundleWalletHoldingsPct: 55,
        },
      })
    );
    expect(view.verdict).toBe("EXCLUDED");
    const bundled = view.signals.find((s) => s.key === "BUNDLED_SUPPLY")!;
    expect(bundled.status).toBe("CONFIRMED");
    expect(bundled.severity).toBe("CRITICAL");
  });

  it("EXCLUDED fires even when only currentBundleWalletHoldingsPct crosses 40%", () => {
    const view = buildRiskView(
      baseInput({
        forensics: {
          ...baseInput().forensics,
          currentBundleWalletHoldingsPct: 41,
          initialBundledAcquisitionPct: 5,
        },
      })
    );
    expect(view.verdict).toBe("EXCLUDED");
  });

  it("2) a CONFIRMED CRITICAL signal outside the bundle metric -> HIGH_RISK", () => {
    const view = buildRiskView(
      baseInput({
        forensics: {
          ...baseInput().forensics,
          reasonCodes: ["INSIDER_CLUSTER_HOLDINGS_WARNING_THRESHOLD"],
          insiderHoldingsPct: 25,
        },
      })
    );
    expect(view.verdict).toBe("HIGH_RISK");
  });

  it("3) mandatory signal UNVERIFIED -> UNVERIFIED even if other signals look clean", () => {
    const view = buildRiskView(
      baseInput({
        forensics: {
          ...baseInput().forensics,
          status: "PENDING",
          eligibility: undefined,
          requiredEvidenceComplete: false,
          initialBundledAcquisitionPct: undefined,
          currentBundleWalletHoldingsPct: undefined,
          reasonCodes: [],
        },
      })
    );
    expect(view.verdict).toBe("UNVERIFIED");
    const bundled = view.signals.find((s) => s.key === "BUNDLED_SUPPLY")!;
    expect(bundled.status).toBe("UNVERIFIED");
  });

  it("4) a CONFIRMED HIGH/MEDIUM signal (mandatory signal clean) -> ELEVATED", () => {
    const view = buildRiskView(
      baseInput({
        safety: { mintAuthority: "SomeAuthority111111111111111111111111111", freezeAuthority: null, confidence: 1 },
      })
    );
    expect(view.verdict).toBe("ELEVATED");
  });

  it("5) everything clean/clear -> UNVERIFIED, never CLEAR (no CLEAR verdict exists)", () => {
    const view = buildRiskView(baseInput());
    expect(view.verdict).toBe("UNVERIFIED");
    expect(view.verdict).not.toBe("CLEAR" as unknown as typeof view.verdict);
  });
});

describe("riskView: absence is never safety (phase6.txt §1.2)", () => {
  it("a missing forensics run renders UNVERIFIED, never a clean/zero result", () => {
    const view = buildRiskView(
      baseInput({
        forensics: {
          status: "NOT_REQUESTED",
          reasonCodes: [],
          requiredEvidenceComplete: false,
        },
      })
    );
    const bundled = view.signals.find((s) => s.key === "BUNDLED_SUPPLY")!;
    expect(bundled.status).toBe("UNVERIFIED");
    expect(bundled.evidence).toEqual([]);
    expect(view.verdict).toBe("UNVERIFIED");
    expect(view.forensicsStatus).toBe("ABSENT");
  });

  it("a worker that returned FAILED renders UNVERIFIED for that signal, not CLEAR", () => {
    const view = buildRiskView(
      baseInput({
        forensics: { status: "FAILED", reasonCodes: [], requiredEvidenceComplete: false },
      })
    );
    expect(view.signals.find((s) => s.key === "BUNDLED_SUPPLY")!.status).toBe("UNVERIFIED");
    expect(view.signals.find((s) => s.key === "WALLET_CLUSTERING")!.status).toBe("UNVERIFIED");
  });

  it("zero-valued percentages from absent data are never emitted as a headline number", () => {
    const view = buildRiskView(
      baseInput({
        forensics: { status: "PENDING", reasonCodes: [], requiredEvidenceComplete: false },
      })
    );
    const bundled = view.signals.find((s) => s.key === "BUNDLED_SUPPLY")!;
    expect(bundled.headline).not.toMatch(/0%/);
  });

  it("WASH_TRADE and DEV_HISTORY have no analyzer yet and are always UNVERIFIED", () => {
    const view = buildRiskView(baseInput());
    expect(view.signals.find((s) => s.key === "WASH_TRADE")!.status).toBe("UNVERIFIED");
    expect(view.signals.find((s) => s.key === "DEV_HISTORY")!.status).toBe("UNVERIFIED");
  });

  it("mint/freeze authority signal is UNVERIFIED when the safety worker never completed", () => {
    const view = buildRiskView(
      baseInput({ safety: { mintAuthority: null, freezeAuthority: null, confidence: 0 } })
    );
    expect(view.signals.find((s) => s.key === "MINT_AUTHORITY")!.status).toBe("UNVERIFIED");
  });

  it("LP status signal is UNVERIFIED when lpBurned was never observed", () => {
    const view = buildRiskView(
      baseInput({ safety: { mintAuthority: null, freezeAuthority: null, confidence: 1, lpBurned: undefined } })
    );
    expect(view.signals.find((s) => s.key === "LP_STATUS")!.status).toBe("UNVERIFIED");
  });
});

describe("riskView: recommendation and evidence-mandatory rules", () => {
  it("recommendation is always RESEARCH_ONLY", () => {
    expect(buildRiskView(baseInput()).recommendation).toBe("RESEARCH_ONLY");
  });

  it("every CONFIRMED signal carries at least one verifiable evidence reference when evidence rows exist", () => {
    const view = buildRiskView(
      baseInput({
        forensics: {
          ...baseInput().forensics,
          initialBundledAcquisitionPct: 62,
          currentBundleWalletHoldingsPct: 55,
          reasonCodes: ["INITIAL_BUNDLED_ACQUISITION_AT_OR_ABOVE_40_PCT"],
        },
        forensicsEvidence: [
          { category: "LAUNCH_ACQUISITION", signature: "5abc...sig", slot: 1234, wallets: ["Wallet1111111111111111111111111111111111"] },
        ],
      })
    );
    const bundled = view.signals.find((s) => s.key === "BUNDLED_SUPPLY")!;
    expect(bundled.status).toBe("CONFIRMED");
    expect(bundled.evidence.length).toBeGreaterThan(0);
    expect(bundled.evidence.some((e) => e.kind === "TRANSACTION")).toBe(true);
  });
});
