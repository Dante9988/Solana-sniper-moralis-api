import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../prismaClient", () => ({
  prisma: {
    solanaForensicsJob: { findUnique: vi.fn(), create: vi.fn() },
    solanaForensicsRun: { findFirst: vi.fn() },
  },
}));

vi.mock("../../forensics/forensicsJobService", async () => {
  const actual = await vi.importActual<typeof import("../../forensics/forensicsJobService")>("../../forensics/forensicsJobService");
  return { ...actual, enqueueSolanaForensicsJob: vi.fn() };
});

import { prisma as mockedPrisma } from "../prismaClient";
import { enqueueSolanaForensicsJob as mockedEnqueue } from "../../forensics/forensicsJobService";
import { defaultForensicsIntelligenceService } from "../forensicsIntelligenceLookupService";

const MINT = "So11111111111111111111111111111111111111112";
const baseInput = { mint: MINT, eventId: "evt-1", discoverySignature: "sig1", discoverySource: "PUMPFUN" as const };

describe("forensicsIntelligenceLookupService", () => {
  beforeEach(() => {
    process.env.FORENSICS_ENQUEUE_ENABLED = "true";
    vi.mocked(mockedPrisma.solanaForensicsJob.findUnique).mockReset();
    vi.mocked(mockedPrisma.solanaForensicsRun.findFirst).mockReset();
    vi.mocked(mockedEnqueue).mockReset();
  });
  afterEach(() => {
    delete process.env.FORENSICS_ENQUEUE_ENABLED;
  });

  it("returns DISABLED and performs no enqueue when the feature flag is off", async () => {
    process.env.FORENSICS_ENQUEUE_ENABLED = "false";
    const result = await defaultForensicsIntelligenceService.getOrEnqueueForensicsAssessment(baseInput);
    expect(result).toEqual({ status: "DISABLED", reasonCodes: [], requiredEvidenceComplete: false });
    expect(mockedEnqueue).not.toHaveBeenCalled();
    expect(mockedPrisma.solanaForensicsJob.findUnique).not.toHaveBeenCalled();
  });

  it("enqueues exactly once when no job exists yet", async () => {
    vi.mocked(mockedPrisma.solanaForensicsJob.findUnique)
      .mockResolvedValueOnce(null) // initial lookup: no job
      .mockResolvedValueOnce({ id: "job-1", status: "PENDING" } as never); // post-enqueue lookup
    vi.mocked(mockedEnqueue).mockResolvedValue({ jobId: "job-1", created: true, status: "PENDING" });

    const result = await defaultForensicsIntelligenceService.getOrEnqueueForensicsAssessment(baseInput);
    expect(mockedEnqueue).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("PENDING");
    expect(result.jobId).toBe("job-1");
  });

  it("a duplicate/reconnect event reuses the existing job without enqueuing again", async () => {
    vi.mocked(mockedPrisma.solanaForensicsJob.findUnique).mockResolvedValue({ id: "job-1", status: "PENDING" } as never);
    const result = await defaultForensicsIntelligenceService.getOrEnqueueForensicsAssessment(baseInput);
    expect(mockedEnqueue).not.toHaveBeenCalled();
    expect(result.status).toBe("PENDING");
    expect(result.jobId).toBe("job-1");
  });

  it("maps a RUNNING job", async () => {
    vi.mocked(mockedPrisma.solanaForensicsJob.findUnique).mockResolvedValue({ id: "job-1", status: "RUNNING" } as never);
    const result = await defaultForensicsIntelligenceService.getOrEnqueueForensicsAssessment(baseInput);
    expect(result.status).toBe("RUNNING");
  });

  it("maps a FAILED job with its last error code as a reason code", async () => {
    vi.mocked(mockedPrisma.solanaForensicsJob.findUnique).mockResolvedValue({ id: "job-1", status: "FAILED", lastErrorCode: "RETRIES_EXHAUSTED" } as never);
    const result = await defaultForensicsIntelligenceService.getOrEnqueueForensicsAssessment(baseInput);
    expect(result.status).toBe("FAILED");
    expect(result.reasonCodes).toContain("RETRIES_EXHAUSTED");
  });

  it("maps a COMPLETE job with its latest run and eligibility, never coercing missing percentages to zero", async () => {
    vi.mocked(mockedPrisma.solanaForensicsJob.findUnique).mockResolvedValue({ id: "job-1", status: "COMPLETE" } as never);
    vi.mocked(mockedPrisma.solanaForensicsRun.findFirst).mockResolvedValue({
      id: "run-1",
      analysisLevel: "FAST",
      policyVersion: "v1",
      initialBundledAcquisitionPct: null,
      currentBundleWalletHoldingsPct: { toString: () => "12.5" } as never,
      developerClusterPct: null,
      suspectedCoordinatedPct: null,
      insiderPct: null,
      currentSniperHoldingsPct: null,
      adjustedTop10Pct: null,
      completedAt: new Date("2026-01-01T00:00:00.000Z"),
      eligibility: { eligibility: "CAUTION", displaySeverity: "WARNING", reasonCodes: ["X"], requiredEvidenceComplete: true },
    } as never);

    const result = await defaultForensicsIntelligenceService.getOrEnqueueForensicsAssessment(baseInput);
    expect(result.status).toBe("COMPLETE");
    expect(result.eligibility).toBe("CAUTION");
    expect(result.initialBundledAcquisitionPct).toBeUndefined();
    expect(result.currentBundleWalletHoldingsPct).toBeCloseTo(12.5);
  });

  it("maps a PARTIAL job with no run row found as PARTIAL with a reason code, never fabricating data", async () => {
    vi.mocked(mockedPrisma.solanaForensicsJob.findUnique).mockResolvedValue({ id: "job-1", status: "PARTIAL" } as never);
    vi.mocked(mockedPrisma.solanaForensicsRun.findFirst).mockResolvedValue(null);
    const result = await defaultForensicsIntelligenceService.getOrEnqueueForensicsAssessment(baseInput);
    expect(result.status).toBe("PARTIAL");
    expect(result.reasonCodes).toContain("FORENSICS_RUN_MISSING");
    expect(result.eligibility).toBeUndefined();
  });

  it("a database failure never crashes the caller — returns a safe FAILED assessment", async () => {
    vi.mocked(mockedPrisma.solanaForensicsJob.findUnique).mockRejectedValue(new Error("connection refused"));
    const result = await defaultForensicsIntelligenceService.getOrEnqueueForensicsAssessment(baseInput);
    expect(result.status).toBe("FAILED");
    expect(result.reasonCodes).toContain("FORENSICS_LOOKUP_DB_ERROR");
  });
});
