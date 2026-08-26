import { describe, expect, it, vi } from "vitest";
import { persistForensicsRun } from "../forensicsRunPersistence";
import { SolanaTokenForensicsReport, TokenEligibilityAssessment, WalletCluster } from "../types";

const MINT = "So11111111111111111111111111111111111111112";

function makeReport(overrides: Partial<SolanaTokenForensicsReport> = {}): SolanaTokenForensicsReport {
  return {
    mint: MINT,
    analysisLevel: "FAST",
    policyVersion: "v1",
    launch: { source: "PUMPFUN", creatorEvidence: [] },
    coverage: {
      status: "COMPLETE",
      analysisLevel: "FAST",
      holderPagesFetched: 1,
      holderAccountsAnalyzed: 1,
      transactionsAnalyzed: 1,
      walletsAnalyzed: 1,
      reachedConfiguredLimit: false,
      estimatedCreditsUsed: 12,
      requestCountsByMethod: { getTokenSupply: 1, getTokenAccounts: 1 },
      warnings: [],
    },
    holderConcentration: { excludedAccounts: [] },
    bundles: { initialBundleMetricStatus: "COMPLETE", currentBundleMetricStatus: "COMPLETE", clusters: [] },
    developer: { linkedWallets: [], creatorEvidence: [] },
    snipers: { wallets: [] },
    insiders: { clusters: [], suspectedCoordinatedClusters: [] },
    freshWallets: { wallets: [], definition: "NO_ACTIVITY_OBSERVED_IN_BOUNDED_30_DAY_LOOKBACK" },
    authorities: { warnings: [] },
    evidence: [
      { id: "ev-1", category: "LAUNCH_ACQUISITION", description: "d", reasonCode: "R", source: "SOLANA_STANDARD_RPC", wallets: ["A"], retrievedAt: new Date() },
    ],
    errors: [],
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    completedAt: new Date("2026-01-01T00:00:05.000Z"),
    ...overrides,
  };
}

function makeEligibility(overrides: Partial<TokenEligibilityAssessment> = {}): TokenEligibilityAssessment {
  return {
    eligibility: "ELIGIBLE",
    displaySeverity: "NORMAL",
    reasonCodes: ["MANDATORY_BUNDLE_METRICS_BELOW_WARNING_THRESHOLD"],
    evaluatedMetrics: { initialBundledAcquisitionPct: 1 },
    requiredEvidenceComplete: true,
    policyVersion: "v1",
    evaluatedAt: new Date("2026-01-01T00:00:05.000Z"),
    ...overrides,
  };
}

function makeCluster(overrides: Partial<WalletCluster> = {}): WalletCluster {
  return { id: "cluster-1", classification: "CONFIRMED_BUNDLE", confidence: 0.9, memberWallets: ["A", "B"], relationships: [], reasonCodes: [], evidence: [], ...overrides };
}

function fakeTx() {
  return {
    solanaForensicsRun: { create: vi.fn().mockResolvedValue({ id: "run-1" }) },
    solanaForensicsEvidence: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    solanaWalletCluster: { create: vi.fn().mockResolvedValue({ id: "cluster-row-1" }) },
    solanaWalletClusterMember: { createMany: vi.fn().mockResolvedValue({ count: 2 }) },
    solanaForensicsError: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    solanaTokenEligibilityAssessment: { create: vi.fn().mockResolvedValue({ id: "elig-1" }) },
  };
}

function fakeDb(tx: ReturnType<typeof fakeTx>) {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(tx)),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("persistForensicsRun — transactional success", () => {
  it("writes run, evidence, clusters, members, and eligibility inside one transaction", async () => {
    const tx = fakeTx();
    const db = fakeDb(tx);
    const report = makeReport();
    const eligibility = makeEligibility();
    const clusters = [makeCluster()];

    const result = await persistForensicsRun(db, {
      jobId: "job-1",
      assetId: "asset-1",
      mint: MINT,
      attemptNumber: 1,
      analysisLevel: "FAST",
      runStatus: "COMPLETE",
      report,
      eligibility,
      clusters,
    });

    expect(result.runId).toBe("run-1");
    expect(tx.solanaForensicsRun.create).toHaveBeenCalledTimes(1);
    expect(tx.solanaForensicsEvidence.createMany).toHaveBeenCalledTimes(1);
    expect(tx.solanaWalletCluster.create).toHaveBeenCalledTimes(1);
    expect(tx.solanaWalletClusterMember.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: [{ clusterId: "cluster-row-1", wallet: "A" }, { clusterId: "cluster-row-1", wallet: "B" }] })
    );
    // Eligibility is its own table write, separate from any AI-assessment concept.
    expect(tx.solanaTokenEligibilityAssessment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ runId: "run-1", eligibility: "ELIGIBLE" }) })
    );
  });

  it("evidence createMany uses skipDuplicates for idempotent re-persistence", async () => {
    const tx = fakeTx();
    const db = fakeDb(tx);
    await persistForensicsRun(db, {
      jobId: "job-1",
      assetId: "asset-1",
      mint: MINT,
      attemptNumber: 1,
      analysisLevel: "FAST",
      runStatus: "COMPLETE",
      report: makeReport(),
      eligibility: makeEligibility(),
      clusters: [],
    });
    expect(tx.solanaForensicsEvidence.createMany.mock.calls[0][0]).toMatchObject({ skipDuplicates: true });
  });

  it("cluster members createMany uses skipDuplicates (wallet unique within a cluster)", async () => {
    const tx = fakeTx();
    const db = fakeDb(tx);
    await persistForensicsRun(db, {
      jobId: "job-1",
      assetId: "asset-1",
      mint: MINT,
      attemptNumber: 1,
      analysisLevel: "FAST",
      runStatus: "COMPLETE",
      report: makeReport(),
      eligibility: makeEligibility(),
      clusters: [makeCluster()],
    });
    expect(tx.solanaWalletClusterMember.createMany.mock.calls[0][0]).toMatchObject({ skipDuplicates: true });
  });

  it("ignores untyped extra fields on the report/eligibility objects — eligibility persisted is exactly the deterministic value passed in", async () => {
    const tx = fakeTx();
    const db = fakeDb(tx);
    const eligibility = { ...makeEligibility(), aiSuggestedEligibility: "ELIGIBLE" } as TokenEligibilityAssessment;
    await persistForensicsRun(db, {
      jobId: "job-1",
      assetId: "asset-1",
      mint: MINT,
      attemptNumber: 1,
      analysisLevel: "FAST",
      runStatus: "COMPLETE",
      report: makeReport(),
      eligibility: { ...eligibility, eligibility: "EXCLUDED" },
      clusters: [],
    });
    expect(tx.solanaTokenEligibilityAssessment.create.mock.calls[0][0].data.eligibility).toBe("EXCLUDED");
  });
});

describe("persistForensicsRun — rollback on partial failure", () => {
  it("propagates a mid-transaction failure and never returns a runId", async () => {
    const tx = fakeTx();
    tx.solanaWalletCluster.create.mockRejectedValue(new Error("db write failed"));
    const db = fakeDb(tx);

    await expect(
      persistForensicsRun(db, {
        jobId: "job-1",
        assetId: "asset-1",
        mint: MINT,
        attemptNumber: 1,
        analysisLevel: "FAST",
        runStatus: "COMPLETE",
        report: makeReport(),
        eligibility: makeEligibility(),
        clusters: [makeCluster()],
      })
    ).rejects.toThrow("db write failed");

    // Eligibility must never be written if an earlier step in the same
    // transaction failed — the real Postgres transaction wrapping this
    // callback (verified via the local-DB integration check) ensures the
    // whole run rolls back; here we assert the write ordering never reaches it.
    expect(tx.solanaTokenEligibilityAssessment.create).not.toHaveBeenCalled();
  });
});

describe("persistForensicsRun — bounded compact JSON", () => {
  it("never stores unlimited raw transaction payloads in reportJson", async () => {
    const tx = fakeTx();
    const db = fakeDb(tx);
    await persistForensicsRun(db, {
      jobId: "job-1",
      assetId: "asset-1",
      mint: MINT,
      attemptNumber: 1,
      analysisLevel: "FAST",
      runStatus: "COMPLETE",
      report: makeReport(),
      eligibility: makeEligibility(),
      clusters: [],
    });
    const reportJson = tx.solanaForensicsRun.create.mock.calls[0][0].data.reportJson;
    const serialized = JSON.stringify(reportJson);
    expect(serialized.length).toBeLessThan(5000);
    expect(reportJson).not.toHaveProperty("transaction");
    expect(reportJson).not.toHaveProperty("rawPayload");
  });
});
