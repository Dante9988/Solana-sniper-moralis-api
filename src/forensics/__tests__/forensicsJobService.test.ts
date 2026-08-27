import { beforeEach, describe, expect, it, vi } from "vitest";

// assetStore.ts (Phase 4) calls the shared `prisma` singleton directly for
// upsertAsset(), independent of the `db` parameter this module's functions
// take — mock that shared module so enqueue tests stay hermetic.
vi.mock("../../services/prismaClient", () => ({
  prisma: { asset: { upsert: vi.fn() } },
}));

import { prisma as sharedPrisma } from "../../services/prismaClient";
import {
  claimNextForensicsJob,
  completeForensicsJob,
  computeBackoffMs,
  computeJobKey,
  enqueueSolanaForensicsJob,
  extendForensicsJobLease,
  failForensicsJob,
  ForensicsJobValidationError,
  releaseForensicsJobLease,
  retryForensicsJob,
} from "../forensicsJobService";

const MINT = "So11111111111111111111111111111111111111112";

// Minimal fake shaped like the subset of PrismaClient this module touches.
// Cast to `any`/PrismaClient at call sites — this is the "mock Prisma for
// unit tests" pattern phase5d.txt §16 asks for; no real database involved.
function fakeDb(overrides: Record<string, unknown> = {}) {
  return {
    solanaForensicsJob: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(overrides.tx ?? {})),
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("computeJobKey — deterministic identity", () => {
  it("is stable for identical inputs", () => {
    const a = computeJobKey({ normalizedMint: MINT, discoverySignature: "sig1", analysisLevel: "FAST", policyVersion: "v1" });
    const b = computeJobKey({ normalizedMint: MINT, discoverySignature: "sig1", analysisLevel: "FAST", policyVersion: "v1" });
    expect(a).toBe(b);
  });

  it("differs by policy version (same mint otherwise)", () => {
    const a = computeJobKey({ normalizedMint: MINT, discoverySignature: "sig1", analysisLevel: "FAST", policyVersion: "v1" });
    const b = computeJobKey({ normalizedMint: MINT, discoverySignature: "sig1", analysisLevel: "FAST", policyVersion: "v2" });
    expect(a).not.toBe(b);
  });

  it("differs by analysis level: FAST vs DEEP produce distinct identities", () => {
    const fast = computeJobKey({ normalizedMint: MINT, discoverySignature: "sig1", analysisLevel: "FAST", policyVersion: "v1" });
    const deep = computeJobKey({ normalizedMint: MINT, discoverySignature: "sig1", analysisLevel: "DEEP", policyVersion: "v1" });
    expect(fast).not.toBe(deep);
  });

  it("falls back to eventId, then a fixed literal, when no discovery signature exists", () => {
    const withEvent = computeJobKey({ normalizedMint: MINT, eventId: "evt1", analysisLevel: "FAST", policyVersion: "v1" });
    const withNeither = computeJobKey({ normalizedMint: MINT, analysisLevel: "FAST", policyVersion: "v1" });
    expect(withEvent).not.toBe(withNeither);
    expect(withNeither).toContain("no-event-identity");
  });
});

describe("enqueueSolanaForensicsJob", () => {
  beforeEach(() => {
    vi.mocked(sharedPrisma.asset.upsert).mockReset().mockResolvedValue({ id: "asset-1" } as never);
  });

  it("rejects an invalid Solana mint before touching the database", async () => {
    const db = fakeDb();
    await expect(
      enqueueSolanaForensicsJob(db, { mint: "not-a-valid-address", discoverySource: "UNKNOWN", analysisLevel: "FAST", policyVersion: "v1" })
    ).rejects.toBeInstanceOf(ForensicsJobValidationError);
    expect(db.solanaForensicsJob.create).not.toHaveBeenCalled();
  });

  it("resolves the canonical Solana asset (solana-mainnet + normalized mint) and creates a new job", async () => {
    const db = fakeDb();
    db.solanaForensicsJob.create.mockResolvedValue({ id: "job-1", status: "PENDING" });
    const result = await enqueueSolanaForensicsJob(db, {
      mint: MINT,
      discoverySignature: "sig1",
      discoverySource: "PUMPFUN",
      analysisLevel: "FAST",
      policyVersion: "v1",
    });
    expect(result).toEqual({ jobId: "job-1", created: true, status: "PENDING" });
    expect(sharedPrisma.asset.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { chainId_normalizedAddress: { chainId: "solana-mainnet", normalizedAddress: MINT } } })
    );
    expect(db.solanaForensicsJob.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ assetId: "asset-1", mint: MINT, jobKey: expect.stringContaining("solana-mainnet") }) })
    );
  });

  it("returns created:false and the existing job on a duplicate-key race (idempotent enqueue)", async () => {
    const { Prisma } = await import("@prisma/client");
    const existing = { id: "existing-job-id", status: "PENDING" };
    const db = fakeDb();
    db.solanaForensicsJob.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "6.5.0" }));
    db.solanaForensicsJob.findUnique.mockResolvedValue(existing);

    const result = await enqueueSolanaForensicsJob(db, {
      mint: MINT,
      discoverySignature: "sig1",
      discoverySource: "PUMPFUN",
      analysisLevel: "FAST",
      policyVersion: "v1",
    });
    expect(result).toEqual({ jobId: "existing-job-id", created: false, status: "PENDING" });
  });

  it("a different policyVersion for the same mint produces a distinct jobKey (distinct job)", async () => {
    const db = fakeDb();
    db.solanaForensicsJob.create.mockImplementation(async ({ data }: { data: { jobKey: string } }) => ({
      id: `job-for-${data.jobKey}`,
      status: "PENDING",
    }));
    const v1 = await enqueueSolanaForensicsJob(db, { mint: MINT, discoverySignature: "sig1", discoverySource: "PUMPFUN", analysisLevel: "FAST", policyVersion: "v1" });
    const v2 = await enqueueSolanaForensicsJob(db, { mint: MINT, discoverySignature: "sig1", discoverySource: "PUMPFUN", analysisLevel: "FAST", policyVersion: "v2" });
    expect(v1.jobId).not.toBe(v2.jobId);
  });
});

describe("claimNextForensicsJob — atomic claim", () => {
  it("returns null when no job is available", async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue([]), solanaForensicsJob: { update: vi.fn() } };
    const db = fakeDb({ tx });
    const result = await claimNextForensicsJob(db, "worker-1", 60_000);
    expect(result).toBeNull();
    expect(tx.solanaForensicsJob.update).not.toHaveBeenCalled();
  });

  it("claims the row returned by the locked SELECT and stamps lease/status/attemptCount atomically", async () => {
    const updated = {
      id: "job-1",
      jobKey: "key",
      assetId: "asset-1",
      mint: MINT,
      eventId: null,
      discoverySignature: "sig1",
      discoverySource: "PUMPFUN",
      analysisLevel: "FAST",
      policyVersion: "v1",
      attemptCount: 1,
      maxAttempts: 5,
    };
    const tx = { $queryRaw: vi.fn().mockResolvedValue([{ id: "job-1" }]), solanaForensicsJob: { update: vi.fn().mockResolvedValue(updated) } };
    const db = fakeDb({ tx });
    const result = await claimNextForensicsJob(db, "worker-1", 60_000);
    expect(result?.id).toBe("job-1");
    expect(tx.solanaForensicsJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "job-1" },
        data: expect.objectContaining({ status: "RUNNING", leaseOwner: "worker-1", attemptCount: { increment: 1 } }),
      })
    );
  });
});

describe("lease management — owner-scoped mutations", () => {
  it("extendForensicsJobLease succeeds only when the caller is the current lease owner", async () => {
    const db = fakeDb();
    db.solanaForensicsJob.updateMany.mockResolvedValue({ count: 1 });
    const ok = await extendForensicsJobLease(db, "job-1", "worker-1", 60_000);
    expect(ok).toBe(true);
    expect(db.solanaForensicsJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "job-1", leaseOwner: "worker-1", status: "RUNNING" } })
    );
  });

  it("extendForensicsJobLease reports failure (count 0) on a lease-owner mismatch", async () => {
    const db = fakeDb();
    db.solanaForensicsJob.updateMany.mockResolvedValue({ count: 0 });
    const ok = await extendForensicsJobLease(db, "job-1", "worker-2-not-the-owner", 60_000);
    expect(ok).toBe(false);
  });

  it("releaseForensicsJobLease is a no-op if this worker no longer holds the lease", async () => {
    const db = fakeDb();
    db.solanaForensicsJob.updateMany.mockResolvedValue({ count: 0 });
    await releaseForensicsJobLease(db, "job-1", "stale-worker");
    expect(db.solanaForensicsJob.updateMany).toHaveBeenCalled();
  });

  it("completeForensicsJob only affects the row when this worker owns the lease", async () => {
    const db = fakeDb();
    db.solanaForensicsJob.updateMany.mockResolvedValue({ count: 1 });
    const ok = await completeForensicsJob(db, "job-1", "worker-1", "COMPLETE");
    expect(ok).toBe(true);
  });
});

describe("retryable vs permanent failure handling", () => {
  it("retryForensicsJob sets status back to PENDING with a future availableAt and sanitized message", async () => {
    const db = fakeDb();
    db.solanaForensicsJob.updateMany.mockResolvedValue({ count: 1 });
    await retryForensicsJob(db, "job-1", "worker-1", "NETWORK_ERROR", "boom https://mainnet.helius-rpc.com/?api-key=SECRET", 5_000);
    const call = db.solanaForensicsJob.updateMany.mock.calls[0][0];
    expect(call.data.status).toBe("PENDING");
    expect(call.data.lastErrorMessage).not.toContain("SECRET");
  });

  it("failForensicsJob sets status to FAILED with completedAt stamped", async () => {
    const db = fakeDb();
    db.solanaForensicsJob.updateMany.mockResolvedValue({ count: 1 });
    await failForensicsJob(db, "job-1", "worker-1", "VALIDATION_ERROR", "bad input");
    const call = db.solanaForensicsJob.updateMany.mock.calls[0][0];
    expect(call.data.status).toBe("FAILED");
    expect(call.data.completedAt).toBeInstanceOf(Date);
  });
});

describe("computeBackoffMs — bounded exponential backoff", () => {
  it("grows exponentially and is capped", () => {
    expect(computeBackoffMs(1, 1000)).toBe(1000);
    expect(computeBackoffMs(2, 1000)).toBe(2000);
    expect(computeBackoffMs(3, 1000)).toBe(4000);
    expect(computeBackoffMs(20, 1000, 60_000)).toBe(60_000);
  });
});
