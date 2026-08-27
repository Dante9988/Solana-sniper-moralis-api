import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileForensicsRun, reconcilePendingForensicsRuns } from "../forensicsIntelligenceReconciliation";

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    jobId: "job-1",
    mint: "MintA",
    runStatus: "COMPLETE",
    analysisLevel: "FAST",
    policyVersion: "v1",
    createdAt: new Date("2026-01-01T00:10:00.000Z"),
    completedAt: new Date("2026-01-01T00:10:05.000Z"),
    reconciliationAttempts: 0,
    reconciliationStatus: "PENDING",
    initialBundledAcquisitionPct: null,
    currentBundleWalletHoldingsPct: null,
    developerClusterPct: null,
    suspectedCoordinatedPct: null,
    insiderPct: null,
    currentSniperHoldingsPct: null,
    adjustedTop10Pct: null,
    reportJson: {},
    job: { eventId: "evt-1" },
    eligibility: { eligibility: "ELIGIBLE", displaySeverity: "NORMAL", reasonCodes: [], requiredEvidenceComplete: true },
    ...overrides,
  };
}

function makeReport(overrides: Record<string, unknown> = {}) {
  return {
    id: "report-1",
    eventId: "evt-1",
    forensicsRunId: null,
    forensicsEligibility: null,
    aiSchemaVersion: null,
    tokenName: "Synth",
    tokenSymbol: "SYN",
    marketPrice: null,
    marketCap: null,
    safetyMintAuthority: null,
    safetyFreezeAuthority: null,
    ...overrides,
  };
}

function fakeDb(opts: { run?: Record<string, unknown>; report?: Record<string, unknown> | null; priorRunCreatedAt?: Date }) {
  const run = opts.run ?? makeRun();
  const report = opts.report === undefined ? makeReport() : opts.report;

  return {
    solanaForensicsRun: {
      findUnique: vi.fn(async ({ where, select }: { where: { id: string }; select?: { createdAt?: boolean } }) => {
        if (select?.createdAt && opts.priorRunCreatedAt) return { createdAt: opts.priorRunCreatedAt };
        if (where.id === run.id) return run;
        return null;
      }),
      update: vi.fn(async () => ({})),
      findMany: vi.fn(async () => []),
    },
    tokenIntelligenceReport: {
      findUnique: vi.fn(async () => report),
      update: vi.fn(async () => ({})),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("reconcileForensicsRun", () => {
  beforeEach(() => {
    delete process.env.FORENSICS_AI_RESYNTHESIS_ENABLED;
  });
  afterEach(() => {
    delete process.env.FORENSICS_AI_RESYNTHESIS_ENABLED;
  });

  it("reconciles a fresh run into its report and marks SUCCESS", async () => {
    const db = fakeDb({});
    const result = await reconcileForensicsRun(db, "run-1");
    expect(result.outcome).toBe("SUCCESS");
    expect(db.tokenIntelligenceReport.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ forensicsRunId: "run-1", forensicsEligibility: "ELIGIBLE" }) })
    );
    const lastRunUpdate = db.solanaForensicsRun.update.mock.calls.at(-1)[0];
    expect(lastRunUpdate.data.reconciliationStatus).toBe("SUCCESS");
  });

  it("running twice is idempotent: no duplicate report update on the second call", async () => {
    const db = fakeDb({ report: makeReport({ forensicsRunId: "run-1" }) });
    const result = await reconcileForensicsRun(db, "run-1");
    expect(result.outcome).toBe("ALREADY_RECONCILED");
    expect(db.tokenIntelligenceReport.update).not.toHaveBeenCalled();
  });

  it("retains the run as unreconciled and retryable when the report does not exist yet", async () => {
    const db = fakeDb({ report: null });
    const result = await reconcileForensicsRun(db, "run-1");
    expect(result.outcome).toBe("REPORT_NOT_FOUND");
    const update = db.solanaForensicsRun.update.mock.calls.at(-1)[0];
    expect(update.data.reconciliationStatus).toBe("REPORT_NOT_FOUND");
    expect(update.data.reconciliationAttempts).toBe(1);
  });

  it("abandons (bounded retries) once maxAttempts is reached", async () => {
    const db = fakeDb({ report: null, run: makeRun({ reconciliationAttempts: 9 }) });
    const result = await reconcileForensicsRun(db, "run-1", { maxAttempts: 10 });
    expect(result.outcome).toBe("ABANDONED");
    const update = db.solanaForensicsRun.update.mock.calls.at(-1)[0];
    expect(update.data.reconciliationStatus).toBe("ABANDONED");
  });

  it("a report-update failure is recorded as FAILED_RETRYABLE and never touches the forensic run's content", async () => {
    const db = fakeDb({});
    db.tokenIntelligenceReport.update.mockRejectedValue(new Error("db write failed"));
    const result = await reconcileForensicsRun(db, "run-1");
    expect(result.outcome).toBe("FAILED_RETRYABLE");
    const update = db.solanaForensicsRun.update.mock.calls.at(-1)[0];
    expect(update.data.reconciliationStatus).toBe("FAILED_RETRYABLE");
    // The run's own deterministic content fields are never part of this update.
    expect(update.data).not.toHaveProperty("initialBundledAcquisitionPct");
    expect(update.data).not.toHaveProperty("runStatus");
  });

  it("never downgrades an already-EXCLUDED report to another eligibility", async () => {
    const db = fakeDb({
      report: makeReport({ forensicsRunId: "old-run", forensicsEligibility: "EXCLUDED" }),
      run: makeRun({ eligibility: { eligibility: "ELIGIBLE", displaySeverity: "NORMAL", reasonCodes: [], requiredEvidenceComplete: true } }),
    });
    const result = await reconcileForensicsRun(db, "run-1");
    expect(result.outcome).toBe("SKIPPED_EXCLUDED_LOCKED");
    expect(db.tokenIntelligenceReport.update).not.toHaveBeenCalled();
  });

  it("exact 40% exclusion is preserved across reconciliation (EXCLUDED stays EXCLUDED even with a newer non-excluded run)", async () => {
    const db = fakeDb({
      report: makeReport({ forensicsRunId: "old-run", forensicsEligibility: "EXCLUDED" }),
      run: makeRun({ eligibility: { eligibility: "CAUTION", displaySeverity: "WARNING", reasonCodes: [], requiredEvidenceComplete: true } }),
    });
    const result = await reconcileForensicsRun(db, "run-1");
    expect(result.outcome).toBe("SKIPPED_EXCLUDED_LOCKED");
    expect(db.tokenIntelligenceReport.update).not.toHaveBeenCalled();
  });

  it("does not silently overwrite history with an older/not-newer run (newer policy-version/run selection)", async () => {
    const db = fakeDb({
      report: makeReport({ forensicsRunId: "newer-run" }),
      priorRunCreatedAt: new Date("2026-01-02T00:00:00.000Z"), // newer than run-1's createdAt
    });
    const result = await reconcileForensicsRun(db, "run-1");
    expect(result.outcome).toBe("SKIPPED_NOT_NEWER");
    expect(db.tokenIntelligenceReport.update).not.toHaveBeenCalled();
  });

  it("reconciles forward when this run is newer than the currently-mapped run", async () => {
    const db = fakeDb({
      report: makeReport({ forensicsRunId: "older-run" }),
      priorRunCreatedAt: new Date("2025-01-01T00:00:00.000Z"), // older than run-1's createdAt
    });
    const result = await reconcileForensicsRun(db, "run-1");
    expect(result.outcome).toBe("SUCCESS");
    expect(db.tokenIntelligenceReport.update).toHaveBeenCalled();
  });

  it("AI-like override fields on the run/report input can never alter the persisted eligibility", async () => {
    const db = fakeDb({
      run: makeRun({
        eligibility: {
          eligibility: "EXCLUDED",
          displaySeverity: "DANGEROUS_EXCLUDED",
          reasonCodes: ["INITIAL_BUNDLED_ACQUISITION_AT_OR_ABOVE_40_PCT"],
          requiredEvidenceComplete: true,
          // Simulates an untyped AI-injected override attempt on the eligibility object.
          aiSuggestedEligibility: "ELIGIBLE",
        },
      }),
    });
    await reconcileForensicsRun(db, "run-1");
    const update = db.tokenIntelligenceReport.update.mock.calls[0][0];
    expect(update.data.forensicsEligibility).toBe("EXCLUDED");
  });

  it("does not invoke AI re-synthesis when the flag is disabled (default)", async () => {
    const db = fakeDb({});
    const result = await reconcileForensicsRun(db, "run-1");
    expect(result.outcome).toBe("SUCCESS");
    // No aiNarrative/ai* fields are part of the forensics reconciliation update.
    const update = db.tokenIntelligenceReport.update.mock.calls[0][0];
    expect(update.data).not.toHaveProperty("aiNarrative");
  });
});

describe("reconcilePendingForensicsRuns", () => {
  it("processes a bounded batch of eligible runs", async () => {
    const db = fakeDb({});
    db.solanaForensicsRun.findMany.mockResolvedValue([{ id: "run-1" }]);
    const results = await reconcilePendingForensicsRuns(db, { maxRuns: 5 });
    expect(results).toHaveLength(1);
    expect(db.solanaForensicsRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 5, where: expect.objectContaining({ runStatus: { in: ["COMPLETE", "PARTIAL"] } }) })
    );
  });
});
