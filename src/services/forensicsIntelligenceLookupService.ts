/**
 * Phase 5E — narrow injected service between `bundleSniperResearcher` and
 * the durable Phase 5D forensics job system (phase5e.txt §6).
 *
 * This is the ONLY thing the researcher touches: fast Prisma reads plus, at
 * most, one idempotent job-enqueue write. It NEVER calls
 * `bundleForensicsService`/`runBundleForensics` and NEVER constructs a
 * `SolanaForensicsClient` — the expensive analyzer only ever runs inside the
 * standalone `forensics:worker` process. A database failure here is caught
 * and mapped to a safe `FAILED` assessment; it never throws into the
 * orchestrator.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "./prismaClient";
import { computeJobKey, enqueueSolanaForensicsJob } from "../forensics/forensicsJobService";
import { isForensicsEnqueueEnabled } from "../forensics/forensicsIntegrationConfig";
import { FORENSICS_POLICY_VERSION } from "../forensics/thresholds";
import { IntelligenceForensicsAssessment } from "../intelligence/types";

export interface ForensicsLookupInput {
  mint: string;
  eventId: string;
  discoverySignature?: string;
  discoverySource: "PUMPFUN" | "PUMPSWAP" | "MIGRATION" | "UNKNOWN";
}

export interface ForensicsIntelligenceService {
  getOrEnqueueForensicsAssessment(input: ForensicsLookupInput): Promise<IntelligenceForensicsAssessment>;
}

function disabled(): IntelligenceForensicsAssessment {
  return { status: "DISABLED", reasonCodes: [], requiredEvidenceComplete: false };
}

function pending(jobId: string): IntelligenceForensicsAssessment {
  return { status: "PENDING", jobId, reasonCodes: [], requiredEvidenceComplete: false };
}

function running(jobId: string): IntelligenceForensicsAssessment {
  return { status: "RUNNING", jobId, reasonCodes: [], requiredEvidenceComplete: false };
}

function failed(jobId: string | undefined, reasonCode: string): IntelligenceForensicsAssessment {
  return { status: "FAILED", jobId, reasonCodes: [reasonCode], requiredEvidenceComplete: false };
}

function toNumber(value: Prisma.Decimal | null | undefined): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}

/** Real, DB-backed implementation. Never imported/invoked by anything outside this file and its default export usage. */
async function getOrEnqueueForensicsAssessmentImpl(input: ForensicsLookupInput): Promise<IntelligenceForensicsAssessment> {
  if (!isForensicsEnqueueEnabled()) return disabled();

  try {
    const jobKey = computeJobKey({
      normalizedMint: input.mint,
      discoverySignature: input.discoverySignature,
      eventId: input.eventId,
      analysisLevel: "FAST",
      policyVersion: FORENSICS_POLICY_VERSION,
    });

    let job = await prisma.solanaForensicsJob.findUnique({ where: { jobKey } });

    if (!job) {
      const enqueueResult = await enqueueSolanaForensicsJob(prisma, {
        mint: input.mint,
        eventId: input.eventId,
        discoverySignature: input.discoverySignature,
        discoverySource: input.discoverySource,
        analysisLevel: "FAST",
        policyVersion: FORENSICS_POLICY_VERSION,
      });
      job = await prisma.solanaForensicsJob.findUnique({ where: { id: enqueueResult.jobId } });
      if (!job) return failed(enqueueResult.jobId, "FORENSICS_JOB_LOOKUP_FAILED_AFTER_ENQUEUE");
    }

    if (job.status === "PENDING") return pending(job.id);
    if (job.status === "RUNNING") return running(job.id);
    if (job.status === "FAILED") return failed(job.id, job.lastErrorCode ?? "FORENSICS_JOB_FAILED");

    // COMPLETE or PARTIAL: load the latest run + its deterministic eligibility.
    const run = await prisma.solanaForensicsRun.findFirst({
      where: { jobId: job.id },
      orderBy: { createdAt: "desc" },
      include: { eligibility: true },
    });
    if (!run) {
      return { status: job.status as "COMPLETE" | "PARTIAL", jobId: job.id, reasonCodes: ["FORENSICS_RUN_MISSING"], requiredEvidenceComplete: false };
    }

    return {
      status: job.status as "COMPLETE" | "PARTIAL",
      jobId: job.id,
      runId: run.id,
      analysisLevel: run.analysisLevel as "FAST" | "DEEP",
      policyVersion: run.policyVersion,
      eligibility: run.eligibility?.eligibility as IntelligenceForensicsAssessment["eligibility"],
      displaySeverity: run.eligibility?.displaySeverity as IntelligenceForensicsAssessment["displaySeverity"],
      reasonCodes: (run.eligibility?.reasonCodes as string[] | undefined) ?? [],
      requiredEvidenceComplete: run.eligibility?.requiredEvidenceComplete ?? false,
      initialBundledAcquisitionPct: toNumber(run.initialBundledAcquisitionPct),
      currentBundleWalletHoldingsPct: toNumber(run.currentBundleWalletHoldingsPct),
      developerClusterHoldingsPct: toNumber(run.developerClusterPct),
      suspectedCoordinatedHoldingsPct: toNumber(run.suspectedCoordinatedPct),
      insiderHoldingsPct: toNumber(run.insiderPct),
      sniperHoldingsPct: toNumber(run.currentSniperHoldingsPct),
      adjustedTop10HoldingsPct: toNumber(run.adjustedTop10Pct),
      completedAt: run.completedAt ?? undefined,
    };
  } catch (err) {
    console.error("forensicsIntelligenceLookupService: database error:", err instanceof Error ? err.message : String(err));
    return failed(undefined, "FORENSICS_LOOKUP_DB_ERROR");
  }
}

export const defaultForensicsIntelligenceService: ForensicsIntelligenceService = {
  getOrEnqueueForensicsAssessment: getOrEnqueueForensicsAssessmentImpl,
};
