import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createBundleSniperResearcher } from "../bundleSniperResearcher";
import { ForensicsIntelligenceService } from "../../../services/forensicsIntelligenceLookupService";
import { IntelligenceForensicsAssessment } from "../../types";
import { pumpfunEvent } from "../../__tests__/fixtures/syntheticEvents";

function fakeService(assessment: IntelligenceForensicsAssessment, delayMs = 0): ForensicsIntelligenceService {
  return {
    getOrEnqueueForensicsAssessment: async () => {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return assessment;
    },
  };
}

describe("bundleSniperResearcher — narrow injected service (phase5e.txt §6)", () => {
  it("DISABLED: returns the exact legacy UNAVAILABLE/INTERNAL_FORENSICS_PENDING shape and never enqueues", async () => {
    const researcher = createBundleSniperResearcher(fakeService({ status: "DISABLED", reasonCodes: [], requiredEvidenceComplete: false }));
    const result = await researcher(pumpfunEvent);
    expect(result.data.bundlesAndSnipers).toMatchObject({ status: "UNAVAILABLE", source: "INTERNAL_FORENSICS_PENDING", confidence: 0 });
    expect(result.data.forensics.status).toBe("DISABLED");
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("PENDING: returns PENDING with the job id and marks the result as a soft error (drives orchestrator PARTIAL)", async () => {
    const researcher = createBundleSniperResearcher(fakeService({ status: "PENDING", jobId: "job-1", reasonCodes: [], requiredEvidenceComplete: false }));
    const result = await researcher(pumpfunEvent);
    expect(result.data.forensics).toMatchObject({ status: "PENDING", jobId: "job-1" });
    expect(result.data.bundlesAndSnipers.status).toBe("UNAVAILABLE");
    expect(result.errors.some((e) => e.includes("job-1"))).toBe(true);
  });

  it("RUNNING: maps through as RUNNING", async () => {
    const researcher = createBundleSniperResearcher(fakeService({ status: "RUNNING", jobId: "job-1", reasonCodes: [], requiredEvidenceComplete: false }));
    const result = await researcher(pumpfunEvent);
    expect(result.data.forensics.status).toBe("RUNNING");
  });

  it("COMPLETE with EXCLUDED eligibility: report may be technically complete while eligibility is excluded (no errors)", async () => {
    const researcher = createBundleSniperResearcher(
      fakeService({
        status: "COMPLETE",
        jobId: "job-1",
        runId: "run-1",
        eligibility: "EXCLUDED",
        displaySeverity: "DANGEROUS_EXCLUDED",
        reasonCodes: ["INITIAL_BUNDLED_ACQUISITION_AT_OR_ABOVE_40_PCT"],
        requiredEvidenceComplete: true,
        currentBundleWalletHoldingsPct: 45,
      })
    );
    const result = await researcher(pumpfunEvent);
    expect(result.errors).toHaveLength(0); // COMPLETE is not an error, even though EXCLUDED
    expect(result.data.forensics.eligibility).toBe("EXCLUDED");
    expect(result.data.bundlesAndSnipers.status).toBe("AVAILABLE");
    expect(result.data.bundlesAndSnipers.bundledPct).toBe(45);
  });

  it("PARTIAL: maps through with a soft error, never treating missing evidence as safe/zero", async () => {
    const researcher = createBundleSniperResearcher(
      fakeService({ status: "PARTIAL", jobId: "job-1", runId: "run-1", reasonCodes: ["FORENSICS_RUN_MISSING"], requiredEvidenceComplete: false })
    );
    const result = await researcher(pumpfunEvent);
    expect(result.data.forensics.status).toBe("PARTIAL");
    expect(result.data.bundlesAndSnipers.bundledPct).toBeUndefined();
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("FAILED: maps through with the job's reason codes", async () => {
    const researcher = createBundleSniperResearcher(
      fakeService({ status: "FAILED", jobId: "job-1", reasonCodes: ["RETRIES_EXHAUSTED"], requiredEvidenceComplete: false })
    );
    const result = await researcher(pumpfunEvent);
    expect(result.data.forensics.status).toBe("FAILED");
    expect(result.data.bundlesAndSnipers.errors).toContain("RETRIES_EXHAUSTED");
  });

  it("no AI field can alter mapped eligibility — extra untyped fields on the assessment are ignored", async () => {
    const maliciousAssessment = {
      status: "COMPLETE" as const,
      eligibility: "EXCLUDED" as const,
      reasonCodes: [],
      requiredEvidenceComplete: true,
      aiSuggestedEligibility: "ELIGIBLE",
    };
    const researcher = createBundleSniperResearcher(fakeService(maliciousAssessment as IntelligenceForensicsAssessment));
    const result = await researcher(pumpfunEvent);
    expect(result.data.forensics.eligibility).toBe("EXCLUDED");
  });
});

describe("bundleSniperResearcher — non-blocking (phase5e.txt §12)", () => {
  it("resolves quickly, bounded by the injected service's own latency, never adding its own wait for forensic completion", async () => {
    const researcher = createBundleSniperResearcher(fakeService({ status: "PENDING", jobId: "job-1", reasonCodes: [], requiredEvidenceComplete: false }, 5));
    const startedAt = Date.now();
    await researcher(pumpfunEvent);
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeLessThan(200); // generous bound; proves no internal polling/blocking wait was added
  });

  it("never imports the expensive analyzer or a live Helius/RPC client", () => {
    const source = readFileSync("src/intelligence/workers/bundleSniperResearcher.ts", "utf8");
    expect(source).not.toMatch(/bundleForensicsService|runBundleForensics/);
    expect(source).not.toMatch(/solanaForensicsClient|SolanaForensicsClient/);
    expect(source).not.toMatch(/new Connection\(/);
  });
});
