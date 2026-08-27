import { describe, expect, it, vi } from "vitest";
import { loadRiskViewForMint } from "../riskViewLoader";

const MINT = "So11111111111111111111111111111111111111112";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeDb(overrides: Record<string, unknown> = {}): any {
  return {
    tokenIntelligenceReport: { findFirst: vi.fn().mockResolvedValue(null) },
    solanaForensicsRun: { findFirst: vi.fn().mockResolvedValue(null), findUnique: vi.fn().mockResolvedValue(null) },
    ...overrides,
  };
}

function standaloneRunFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    mint: MINT,
    runStatus: "COMPLETE",
    policyVersion: "phase5b.2026-08-25",
    createdAt: new Date("2026-08-26T00:00:00Z"),
    completedAt: new Date("2026-08-26T00:05:00Z"),
    eligibility: {
      eligibility: "EXCLUDED",
      displaySeverity: "DANGEROUS_EXCLUDED",
      reasonCodes: ["INITIAL_BUNDLED_ACQUISITION_AT_OR_ABOVE_40_PCT"],
      requiredEvidenceComplete: true,
    },
    initialBundledAcquisitionPct: 62,
    currentBundleWalletHoldingsPct: 55,
    developerClusterPct: null,
    suspectedCoordinatedPct: null,
    insiderPct: null,
    currentSniperHoldingsPct: null,
    adjustedTop10Pct: null,
    evidence: [{ category: "LAUNCH_ACQUISITION", signature: "sig1", slot: 10, wallets: ["WalletA"] }],
    clusters: [],
    ...overrides,
  };
}

describe("loadRiskViewForMint", () => {
  it("returns null when nothing at all has been persisted for the mint", async () => {
    const db = fakeDb();
    const view = await loadRiskViewForMint(db, MINT);
    expect(view).toBeNull();
  });

  it("surfaces a standalone SolanaForensicsRun when no TokenIntelligenceReport exists — the manual-/scan main path", async () => {
    const db = fakeDb({
      solanaForensicsRun: {
        findFirst: vi.fn().mockResolvedValue(standaloneRunFixture()),
        findUnique: vi.fn().mockResolvedValue(null),
      },
    });
    const view = await loadRiskViewForMint(db, MINT);
    expect(view).not.toBeNull();
    expect(view!.verdict).toBe("EXCLUDED");
    expect(view!.reportStatus).toBe("PARTIAL");
    const bundled = view!.signals.find((s) => s.key === "BUNDLED_SUPPLY")!;
    expect(bundled.status).toBe("CONFIRMED");
    expect(bundled.evidence.length).toBeGreaterThan(0);
  });

  it("prefers the report's reconciled forensics fields when they point at the same run", async () => {
    const run = standaloneRunFixture();
    const db = fakeDb({
      tokenIntelligenceReport: {
        findFirst: vi.fn().mockResolvedValue({
          mint: MINT,
          status: "COMPLETE",
          updatedAt: new Date("2026-08-26T00:10:00Z"),
          safetyMintAuthority: null,
          safetyFreezeAuthority: null,
          safetyConfidence: 1,
          safetySolSniffer: null,
          aiNarrative: null,
          aiModel: null,
          aiValidationStatus: null,
          forensicsStatus: "COMPLETE",
          forensicsRunId: run.id,
          forensicsPolicyVersion: run.policyVersion,
          forensicsEligibility: "EXCLUDED",
          forensicsDisplaySeverity: "DANGEROUS_EXCLUDED",
          forensicsReasonCodes: ["INITIAL_BUNDLED_ACQUISITION_AT_OR_ABOVE_40_PCT"],
          forensicsRequiredEvidenceComplete: true,
          forensicsInitialBundledAcquisitionPct: 62,
          forensicsCurrentBundleWalletHoldingsPct: 55,
          forensicsDeveloperClusterHoldingsPct: null,
          forensicsSuspectedCoordinatedHoldingsPct: null,
          forensicsInsiderHoldingsPct: null,
          forensicsSniperHoldingsPct: null,
          forensicsAdjustedTop10HoldingsPct: null,
          forensicsCompletedAt: run.completedAt,
        }),
      },
      solanaForensicsRun: {
        findFirst: vi.fn().mockResolvedValue(run),
        findUnique: vi.fn().mockResolvedValue(run),
      },
    });
    const view = await loadRiskViewForMint(db, MINT);
    expect(view!.verdict).toBe("EXCLUDED");
    expect(view!.reportStatus).toBe("COMPLETE");
  });

  it("falls back to the standalone run when the report exists but was never reconciled with any run", async () => {
    const run = standaloneRunFixture();
    const db = fakeDb({
      tokenIntelligenceReport: {
        findFirst: vi.fn().mockResolvedValue({
          mint: MINT,
          status: "PARTIAL",
          updatedAt: new Date("2026-08-25T00:00:00Z"),
          safetyMintAuthority: null,
          safetyFreezeAuthority: null,
          safetyConfidence: 0,
          safetySolSniffer: null,
          aiNarrative: null,
          aiModel: null,
          aiValidationStatus: null,
          forensicsStatus: "NOT_REQUESTED",
          forensicsRunId: null,
          forensicsPolicyVersion: null,
          forensicsEligibility: null,
          forensicsDisplaySeverity: null,
          forensicsReasonCodes: [],
          forensicsRequiredEvidenceComplete: false,
          forensicsInitialBundledAcquisitionPct: null,
          forensicsCurrentBundleWalletHoldingsPct: null,
          forensicsDeveloperClusterHoldingsPct: null,
          forensicsSuspectedCoordinatedHoldingsPct: null,
          forensicsInsiderHoldingsPct: null,
          forensicsSniperHoldingsPct: null,
          forensicsAdjustedTop10HoldingsPct: null,
          forensicsCompletedAt: null,
        }),
      },
      solanaForensicsRun: {
        findFirst: vi.fn().mockResolvedValue(run),
        findUnique: vi.fn().mockResolvedValue(run),
      },
    });
    const view = await loadRiskViewForMint(db, MINT);
    // The report has real safety/metadata (reportStatus PARTIAL, not absent),
    // but the forensics slice must come from the standalone run, not the
    // report's stale NOT_REQUESTED forensics fields.
    expect(view!.verdict).toBe("EXCLUDED");
    expect(view!.reportStatus).toBe("PARTIAL");
  });
});
