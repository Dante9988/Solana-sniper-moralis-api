/**
 * Phase 5D — real-database integration checks (phase5d.txt §16: atomic
 * claim, two-worker claim race, canonical asset relationship, transactional
 * rollback against real Postgres).
 *
 * Opt-in only: skipped unless `FORENSICS_RUN_DB_TESTS=true`, so the default
 * `npx vitest run` stays fully hermetic (no network/DB), matching every
 * other test in this project. Run explicitly against the confirmed local
 * Docker Postgres with:
 *
 *   FORENSICS_RUN_DB_TESTS=true npx vitest run src/forensics/__tests__/forensicsJobService.dbIntegration.test.ts
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const RUN_DB_TESTS = process.env.FORENSICS_RUN_DB_TESTS === "true";

describe.skipIf(!RUN_DB_TESTS)("forensicsJobService — real Postgres integration", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let enqueueSolanaForensicsJob: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let claimNextForensicsJob: any;
  const mint = require("@solana/web3.js").PublicKey.findProgramAddressSync(
    [Buffer.from("db-test"), Buffer.from(randomUUID().replace(/-/g, "").slice(0, 16))],
    new (require("@solana/web3.js").PublicKey)("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
  )[0].toBase58();

  beforeAll(async () => {
    const { prisma: p } = await import("../../services/prismaClient");
    const jobService = await import("../forensicsJobService");
    prisma = p;
    enqueueSolanaForensicsJob = jobService.enqueueSolanaForensicsJob;
    claimNextForensicsJob = jobService.claimNextForensicsJob;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it("resolves the canonical Asset relationship on enqueue", async () => {
    const result = await enqueueSolanaForensicsJob(prisma, {
      mint,
      discoverySignature: `sig-${randomUUID()}`,
      discoverySource: "PUMPFUN",
      analysisLevel: "FAST",
      policyVersion: "db-integration-v1",
    });
    const job = await prisma.solanaForensicsJob.findUnique({ where: { id: result.jobId }, include: { asset: true } });
    expect(job?.asset?.chainId).toBe("solana-mainnet");
    expect(job?.asset?.normalizedAddress).toBe(mint);
  });

  it("two concurrent claimers never receive the same job (real FOR UPDATE SKIP LOCKED)", async () => {
    const sig = `sig-race-${randomUUID()}`;
    await enqueueSolanaForensicsJob(prisma, {
      mint,
      discoverySignature: sig,
      discoverySource: "PUMPFUN",
      analysisLevel: "FAST",
      policyVersion: `race-${randomUUID()}`,
    });

    const [a, b] = await Promise.all([
      claimNextForensicsJob(prisma, "race-worker-a", 60_000),
      claimNextForensicsJob(prisma, "race-worker-b", 60_000),
    ]);

    const claimedIds = [a, b].filter(Boolean).map((c) => c!.id);
    expect(new Set(claimedIds).size).toBe(claimedIds.length); // no duplicate claim
    expect(claimedIds.length).toBeGreaterThanOrEqual(1); // at least one worker got it (only one job existed)
  });

  it("a mid-transaction persistence failure rolls back the entire run (real transaction)", async () => {
    const { persistForensicsRun } = await import("../forensicsRunPersistence");
    const enqueue = await enqueueSolanaForensicsJob(prisma, {
      mint,
      discoverySignature: `sig-rollback-${randomUUID()}`,
      discoverySource: "PUMPFUN",
      analysisLevel: "FAST",
      policyVersion: `rollback-${randomUUID()}`,
    });
    const job = await prisma.solanaForensicsJob.findUnique({ where: { id: enqueue.jobId } });

    const badReport = {
      mint,
      analysisLevel: "FAST",
      policyVersion: "v1",
      launch: { source: "UNKNOWN", creatorEvidence: [] },
      coverage: {
        status: "COMPLETE",
        analysisLevel: "FAST",
        holderPagesFetched: 0,
        holderAccountsAnalyzed: 0,
        transactionsAnalyzed: 0,
        walletsAnalyzed: 0,
        reachedConfiguredLimit: false,
        estimatedCreditsUsed: 0,
        requestCountsByMethod: {},
        warnings: [],
      },
      holderConcentration: { excludedAccounts: [] },
      bundles: { initialBundleMetricStatus: "COMPLETE", currentBundleMetricStatus: "COMPLETE", clusters: [] },
      developer: { linkedWallets: [], creatorEvidence: [] },
      snipers: { wallets: [] },
      insiders: { clusters: [], suspectedCoordinatedClusters: [] },
      freshWallets: { wallets: [], definition: "x" },
      authorities: { warnings: [] },
      evidence: [],
      errors: [],
      startedAt: new Date(),
      completedAt: new Date(),
    };
    const badEligibility = {
      eligibility: "ELIGIBLE",
      displaySeverity: "NORMAL",
      reasonCodes: [],
      evaluatedMetrics: {},
      requiredEvidenceComplete: true,
      policyVersion: "v1",
      evaluatedAt: new Date(),
    };
    // A cluster whose confidence is out of the Decimal(4,3) column's range
    // forces the transaction to fail partway through.
    const invalidCluster = { id: "c1", classification: "CONFIRMED_BUNDLE", confidence: 999, memberWallets: ["a"], relationships: [], reasonCodes: [], evidence: [] };

    await expect(
      persistForensicsRun(prisma, {
        jobId: job.id,
        assetId: job.assetId,
        mint,
        attemptNumber: 1,
        analysisLevel: "FAST",
        runStatus: "COMPLETE",
        report: badReport as never,
        eligibility: badEligibility as never,
        clusters: [invalidCluster as never],
      })
    ).rejects.toThrow();

    const runCount = await prisma.solanaForensicsRun.count({ where: { jobId: job.id } });
    expect(runCount).toBe(0); // the run row itself was rolled back too
  });
});
