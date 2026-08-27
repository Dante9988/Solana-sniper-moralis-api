/**
 * Phase 6 — Prisma-reading glue for `src/researchApi/` (phase6.txt §4.2: "It does not
 * reimplement projection logic"). Loads plain rows and calls the pure
 * `src/presentation/riskView.ts` projection; the projection logic itself
 * lives only there.
 */

import { Prisma, PrismaClient } from "@prisma/client";
import {
  ForensicsPipelineStatus,
  RiskView,
  RiskViewClusterRow,
  RiskViewEvidenceRow,
  RiskViewInput,
  buildRiskView,
} from "../presentation/riskView";

function toNumber(value: Prisma.Decimal | number | null | undefined): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}

interface AuditRisk {
  lpBurned?: boolean;
}

function extractLpBurned(safetySolSniffer: Prisma.JsonValue | null): boolean | undefined {
  if (!safetySolSniffer || typeof safetySolSniffer !== "object") return undefined;
  const auditRisk = (safetySolSniffer as { auditRisk?: AuditRisk }).auditRisk;
  return auditRisk?.lpBurned;
}

type ForensicsRunWithDetail = Prisma.SolanaForensicsRunGetPayload<{
  include: { eligibility: true; evidence: true; clusters: { include: { members: true } } };
}>;

async function loadEvidenceAndClusters(
  db: PrismaClient,
  forensicsRunId: string | null
): Promise<{ evidence: RiskViewEvidenceRow[]; clusters: RiskViewClusterRow[] }> {
  if (!forensicsRunId) return { evidence: [], clusters: [] };
  const run = await db.solanaForensicsRun.findUnique({
    where: { id: forensicsRunId },
    include: { evidence: true, clusters: { include: { members: true } }, eligibility: true },
  });
  if (!run) return { evidence: [], clusters: [] };
  return mapRunEvidenceAndClusters(run);
}

function mapRunEvidenceAndClusters(run: ForensicsRunWithDetail): {
  evidence: RiskViewEvidenceRow[];
  clusters: RiskViewClusterRow[];
} {
  return {
    evidence: run.evidence.map((e) => ({
      category: e.category,
      signature: e.signature,
      slot: e.slot,
      wallets: (e.wallets as string[]) ?? [],
    })),
    clusters: run.clusters.map((c) => ({
      classification: c.classification,
      members: c.members.map((m) => m.wallet),
    })),
  };
}

function forensicsInputFromRun(run: ForensicsRunWithDetail): RiskViewInput["forensics"] {
  return {
    status: run.runStatus as ForensicsPipelineStatus,
    policyVersion: run.policyVersion,
    eligibility: run.eligibility?.eligibility as RiskViewInput["forensics"]["eligibility"],
    displaySeverity: run.eligibility?.displaySeverity as RiskViewInput["forensics"]["displaySeverity"],
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
}

function forensicsInputFromReport(report: {
  forensicsStatus: string;
  forensicsPolicyVersion: string | null;
  forensicsEligibility: string | null;
  forensicsDisplaySeverity: string | null;
  forensicsReasonCodes: Prisma.JsonValue;
  forensicsRequiredEvidenceComplete: boolean;
  forensicsInitialBundledAcquisitionPct: Prisma.Decimal | null;
  forensicsCurrentBundleWalletHoldingsPct: Prisma.Decimal | null;
  forensicsDeveloperClusterHoldingsPct: Prisma.Decimal | null;
  forensicsSuspectedCoordinatedHoldingsPct: Prisma.Decimal | null;
  forensicsInsiderHoldingsPct: Prisma.Decimal | null;
  forensicsSniperHoldingsPct: Prisma.Decimal | null;
  forensicsAdjustedTop10HoldingsPct: Prisma.Decimal | null;
  forensicsCompletedAt: Date | null;
}): RiskViewInput["forensics"] {
  return {
    status: report.forensicsStatus as ForensicsPipelineStatus,
    policyVersion: report.forensicsPolicyVersion ?? undefined,
    eligibility: (report.forensicsEligibility ?? undefined) as RiskViewInput["forensics"]["eligibility"],
    displaySeverity: (report.forensicsDisplaySeverity ?? undefined) as RiskViewInput["forensics"]["displaySeverity"],
    reasonCodes: (report.forensicsReasonCodes as string[] | null) ?? [],
    requiredEvidenceComplete: report.forensicsRequiredEvidenceComplete,
    initialBundledAcquisitionPct: toNumber(report.forensicsInitialBundledAcquisitionPct),
    currentBundleWalletHoldingsPct: toNumber(report.forensicsCurrentBundleWalletHoldingsPct),
    developerClusterHoldingsPct: toNumber(report.forensicsDeveloperClusterHoldingsPct),
    suspectedCoordinatedHoldingsPct: toNumber(report.forensicsSuspectedCoordinatedHoldingsPct),
    insiderHoldingsPct: toNumber(report.forensicsInsiderHoldingsPct),
    sniperHoldingsPct: toNumber(report.forensicsSniperHoldingsPct),
    adjustedTop10HoldingsPct: toNumber(report.forensicsAdjustedTop10HoldingsPct),
    completedAt: report.forensicsCompletedAt ?? undefined,
  };
}

/**
 * Loads whatever Phase 1-5 evidence exists for `mint` (already a canonically
 * normalized Solana address) and projects it into a `RiskView`. Returns
 * `null` only when nothing at all has ever been persisted for this mint —
 * a genuinely different case from "analysed but forensics absent", which
 * `buildRiskView` already renders as `UNVERIFIED`/`ABSENT`.
 *
 * Two independent sources are consulted and reconciled here, not just the
 * `TokenIntelligenceReport`: a mint scanned only through Phase 6's own
 * `/scan` (the common case — "a user pastes a contract address before they
 * buy", phase6.txt §0) gets a `SolanaForensicsJob`/`SolanaForensicsRun` but
 * was never discovered by the live listener, so it has no
 * `TokenIntelligenceReport` row at all — reconciliation
 * (`forensicsIntelligenceReconciliation.ts`) only links a run into a report
 * that already exists under the *same* `eventId`, which a manual scan's
 * synthetic `eventId` never matches. Falling back to the standalone run
 * directly is what makes that path actually surface a result.
 */
export async function loadRiskViewForMint(db: PrismaClient, mint: string): Promise<RiskView | null> {
  const [report, standaloneRun] = await Promise.all([
    db.tokenIntelligenceReport.findFirst({ where: { mint }, orderBy: { createdAt: "desc" } }),
    db.solanaForensicsRun.findFirst({
      where: { mint },
      orderBy: { createdAt: "desc" },
      include: { eligibility: true, evidence: true, clusters: { include: { members: true } } },
    }),
  ]);

  if (!report && !standaloneRun) return null;

  // Prefer the report's own reconciled forensics fields when they're at
  // least as fresh as the standalone run; otherwise (no report, or the
  // report predates/never received this run) read the run directly.
  const reportForensicsIsCurrent =
    report?.forensicsRunId !== null &&
    report?.forensicsRunId !== undefined &&
    (!standaloneRun || report.forensicsRunId === standaloneRun.id || (report.forensicsCompletedAt ?? new Date(0)) >= (standaloneRun.completedAt ?? standaloneRun.createdAt));

  const useStandaloneRun = !!standaloneRun && !(report && reportForensicsIsCurrent);

  const { evidence, clusters } = useStandaloneRun && standaloneRun
    ? mapRunEvidenceAndClusters(standaloneRun)
    : report
      ? await loadEvidenceAndClusters(db, report.forensicsRunId)
      : { evidence: [], clusters: [] };

  const forensics: RiskViewInput["forensics"] =
    useStandaloneRun && standaloneRun
      ? forensicsInputFromRun(standaloneRun)
      : report
        ? forensicsInputFromReport(report)
        : { status: "NOT_REQUESTED", reasonCodes: [], requiredEvidenceComplete: false };

  const input: RiskViewInput = {
    mint,
    // No TokenIntelligenceReport means only the forensics slice of research
    // exists (no metadata/market/safety/AI) — PARTIAL is the honest status,
    // never COMPLETE.
    reportStatus: report ? (report.status as RiskViewInput["reportStatus"]) : "PARTIAL",
    generatedAt: report?.updatedAt ?? standaloneRun?.completedAt ?? standaloneRun?.createdAt ?? new Date(),
    safety: report
      ? {
          mintAuthority: report.safetyMintAuthority,
          freezeAuthority: report.safetyFreezeAuthority,
          confidence: report.safetyConfidence,
          lpBurned: extractLpBurned(report.safetySolSniffer),
        }
      : { mintAuthority: null, freezeAuthority: null, confidence: 0 },
    ai:
      report?.aiNarrative
        ? { narrative: report.aiNarrative, model: report.aiModel ?? undefined, validationStatus: report.aiValidationStatus ?? undefined }
        : undefined,
    forensics,
    forensicsEvidence: evidence,
    forensicsClusters: clusters,
  };

  return buildRiskView(input);
}

export interface JobStatusSummary {
  jobKey: string;
  status: string;
  attemptCount: number;
  maxAttempts: number;
  lastErrorCode: string | null;
}

export async function loadJobStatus(db: PrismaClient, jobKey: string): Promise<JobStatusSummary | null> {
  const job = await db.solanaForensicsJob.findUnique({ where: { jobKey } });
  if (!job) return null;
  return {
    jobKey: job.jobKey,
    status: job.status,
    attemptCount: job.attemptCount,
    maxAttempts: job.maxAttempts,
    lastErrorCode: job.lastErrorCode,
  };
}
