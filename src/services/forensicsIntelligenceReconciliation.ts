/**
 * Phase 5E — reconciles a completed/partial SolanaForensicsRun into its
 * TokenIntelligenceReport (phase5e.txt §8).
 *
 * Stable identity: reconciliation state lives on the run row itself
 * (`SolanaForensicsRun.reconciliationStatus`), keyed by `runId` — one run
 * reconciles into at most one report, ever. Running this twice for the same
 * run is a no-op the second time (idempotency check below). A reconciliation
 * failure never rolls back or deletes the forensic run — it's a separate,
 * later write, never wrapped in the same transaction as the original run
 * persistence.
 */

import { Prisma, PrismaClient } from "@prisma/client";
import { isForensicsAiResynthesisEnabled } from "../forensics/forensicsIntegrationConfig";

export type ReconciliationOutcome =
  | "SUCCESS"
  | "ALREADY_RECONCILED"
  | "SKIPPED_NOT_NEWER"
  | "SKIPPED_EXCLUDED_LOCKED"
  | "REPORT_NOT_FOUND"
  | "ABANDONED"
  | "FAILED_RETRYABLE";

export interface ReconcileRunResult {
  runId: string;
  outcome: ReconciliationOutcome;
  reportId?: string;
}

function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/https?:\/\/[^\s"']+/gi, "[redacted-url]")
    .replace(/api[-_]?key["'=:\s]+[^\s"'&]+/gi, "api-key=[redacted]")
    .slice(0, 500);
}

function toNumber(value: Prisma.Decimal | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/** Reconciles ONE run. Never throws — every failure path is recorded on the run row instead. */
export async function reconcileForensicsRun(
  db: PrismaClient,
  runId: string,
  opts: { maxAttempts?: number } = {}
): Promise<ReconcileRunResult> {
  const maxAttempts = opts.maxAttempts ?? 10;

  const run = await db.solanaForensicsRun.findUnique({
    where: { id: runId },
    include: { eligibility: true, job: true },
  });
  if (!run) return { runId, outcome: "REPORT_NOT_FOUND" };

  if (run.runStatus !== "COMPLETE" && run.runStatus !== "PARTIAL") {
    return { runId, outcome: "REPORT_NOT_FOUND" };
  }

  try {
    const eventId = run.job.eventId;
    const report = eventId ? await db.tokenIntelligenceReport.findUnique({ where: { eventId } }) : null;

    if (!report) {
      const attempts = run.reconciliationAttempts + 1;
      const abandoned = attempts >= maxAttempts;
      await db.solanaForensicsRun.update({
        where: { id: run.id },
        data: {
          reconciliationAttempts: attempts,
          reconciliationStatus: abandoned ? "ABANDONED" : "REPORT_NOT_FOUND",
          reconciliationError: eventId ? "intelligence report not yet persisted" : "job has no eventId to look up",
        },
      });
      return { runId, outcome: abandoned ? "ABANDONED" : "REPORT_NOT_FOUND" };
    }

    // Idempotent: already reconciled exactly this run.
    if (report.forensicsRunId === run.id) {
      if (run.reconciliationStatus !== "SUCCESS") {
        await db.solanaForensicsRun.update({ where: { id: run.id }, data: { reconciliationStatus: "SUCCESS", reconciledAt: new Date() } });
      }
      return { runId, outcome: "ALREADY_RECONCILED", reportId: report.id };
    }

    // Never downgrade EXCLUDED to another eligibility.
    if (report.forensicsEligibility === "EXCLUDED" && run.eligibility?.eligibility !== "EXCLUDED") {
      await db.solanaForensicsRun.update({ where: { id: run.id }, data: { reconciliationStatus: "SUCCESS", reconciledAt: new Date() } });
      return { runId, outcome: "SKIPPED_EXCLUDED_LOCKED", reportId: report.id };
    }

    // A newer policy-version/newer run must not silently overwrite history:
    // only reconcile forward (this run must be at least as new as whatever's
    // currently mapped).
    if (report.forensicsRunId) {
      const currentlyMapped = await db.solanaForensicsRun.findUnique({
        where: { id: report.forensicsRunId },
        select: { createdAt: true },
      });
      if (currentlyMapped && currentlyMapped.createdAt >= run.createdAt) {
        await db.solanaForensicsRun.update({ where: { id: run.id }, data: { reconciliationStatus: "SUCCESS", reconciledAt: new Date() } });
        return { runId, outcome: "SKIPPED_NOT_NEWER", reportId: report.id };
      }
    }

    const now = new Date();
    await db.tokenIntelligenceReport.update({
      where: { id: report.id },
      data: {
        forensicsStatus: run.runStatus,
        forensicsJobId: run.jobId,
        forensicsRunId: run.id,
        forensicsAnalysisLevel: run.analysisLevel,
        forensicsPolicyVersion: run.policyVersion,
        forensicsEligibility: run.eligibility?.eligibility ?? null,
        forensicsDisplaySeverity: run.eligibility?.displaySeverity ?? null,
        forensicsReasonCodes: (run.eligibility?.reasonCodes as Prisma.InputJsonValue | undefined) ?? [],
        forensicsRequiredEvidenceComplete: run.eligibility?.requiredEvidenceComplete ?? false,
        forensicsInitialBundledAcquisitionPct: toNumber(run.initialBundledAcquisitionPct),
        forensicsCurrentBundleWalletHoldingsPct: toNumber(run.currentBundleWalletHoldingsPct),
        forensicsDeveloperClusterHoldingsPct: toNumber(run.developerClusterPct),
        forensicsSuspectedCoordinatedHoldingsPct: toNumber(run.suspectedCoordinatedPct),
        forensicsInsiderHoldingsPct: toNumber(run.insiderPct),
        forensicsSniperHoldingsPct: toNumber(run.currentSniperHoldingsPct),
        forensicsAdjustedTop10HoldingsPct: toNumber(run.adjustedTop10Pct),
        forensicsCompletedAt: run.completedAt,
        forensicsReconciledAt: now,
      },
    });

    // Mark success only AFTER the report update above has committed.
    await db.solanaForensicsRun.update({
      where: { id: run.id },
      data: { reconciliationStatus: "SUCCESS", reconciledAt: now, reconciliationError: null },
    });

    if (isForensicsAiResynthesisEnabled()) {
      const { maybeResynthesizeForensicsExplanation } = await import("./forensicsAiResynthesis");
      await maybeResynthesizeForensicsExplanation(db, report.id, run.id).catch((err) => {
        // AI re-synthesis is best-effort and explanatory-only — its failure
        // must never affect the (already-committed) deterministic reconciliation.
        console.error("forensicsIntelligenceReconciliation: AI re-synthesis failed:", err instanceof Error ? err.message : String(err));
      });
    }

    return { runId, outcome: "SUCCESS", reportId: report.id };
  } catch (err) {
    const attempts = run.reconciliationAttempts + 1;
    await db.solanaForensicsRun
      .update({
        where: { id: run.id },
        data: {
          reconciliationAttempts: attempts,
          reconciliationStatus: "FAILED_RETRYABLE",
          reconciliationError: sanitizeErrorMessage(err instanceof Error ? err.message : String(err)),
        },
      })
      .catch(() => {});
    return { runId, outcome: "FAILED_RETRYABLE" };
  }
}

/** Periodic sweep for the worker to call — bounded batch, bounded retries per run. */
export async function reconcilePendingForensicsRuns(
  db: PrismaClient,
  opts: { maxRuns?: number; maxAttempts?: number } = {}
): Promise<ReconcileRunResult[]> {
  const maxRuns = opts.maxRuns ?? 20;
  const maxAttempts = opts.maxAttempts ?? 10;

  const runs = await db.solanaForensicsRun.findMany({
    where: {
      runStatus: { in: ["COMPLETE", "PARTIAL"] },
      reconciliationStatus: { in: ["PENDING", "REPORT_NOT_FOUND", "FAILED_RETRYABLE"] },
      reconciliationAttempts: { lt: maxAttempts },
    },
    orderBy: { createdAt: "asc" },
    take: maxRuns,
    select: { id: true },
  });

  const results: ReconcileRunResult[] = [];
  for (const { id } of runs) {
    results.push(await reconcileForensicsRun(db, id, { maxAttempts }));
  }
  return results;
}
