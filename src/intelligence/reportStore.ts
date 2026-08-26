import { prisma } from "../services/prismaClient";
import { TokenIntelligenceReport } from "./types";

/**
 * Best-effort persistence: a DB outage must never crash report generation,
 * so all failures are caught here rather than thrown to the orchestrator.
 * Upserts on eventId for idempotency (re-processing the same
 * TokenDiscoveryEvent updates rather than duplicates).
 */
export async function saveReport(report: TokenIntelligenceReport): Promise<void> {
  const errorRows = report.processing.errors.map((message) => ({
    worker: "unknown",
    message,
    fatal: false,
  }));

  const data = {
    mint: report.mint,

    tokenName: report.token.name,
    tokenSymbol: report.token.symbol,
    tokenImageUrl: report.token.imageUrl,
    tokenMetadataUri: report.token.metadataUri,
    tokenCreator: report.token.creator,
    tokenCreationTime: report.token.creationTime,

    socialWebsite: report.socials.website,
    socialTwitter: report.socials.twitter,
    socialTelegram: report.socials.telegram,
    socialDiscord: report.socials.discord,
    socialFindings: report.socials.findings,

    marketPrice: report.market.price,
    marketCap: report.market.marketCap,
    marketFdv: report.market.fdv,
    marketLiquidity: report.market.liquidity,
    marketVolume24h: report.market.volume24h,
    marketHolders: report.market.holders,
    marketPools: report.market.pools as object[],
    marketSources: report.market.sources as object[],

    safetyMintAuthority: report.safety.mintAuthority,
    safetyFreezeAuthority: report.safety.freezeAuthority,
    safetyCreatorHoldingsPct: report.safety.creatorHoldingsPct,
    safetyTopHolderConcentrationPct: report.safety.topHolderConcentrationPct,
    safetyRugCheck: report.safety.rugCheck as object | undefined,
    safetySolSniffer: report.safety.solSniffer as object | undefined,
    safetyRiskFactors: report.safety.riskFactors,
    safetyConfidence: report.safety.confidence,

    bundleSniperPct: report.bundlesAndSnipers.sniperPct,
    bundleBundledPct: report.bundlesAndSnipers.bundledPct,
    bundleFindings: report.bundlesAndSnipers.findings,
    bundleConfidence: report.bundlesAndSnipers.confidence,

    // forensics (Phase 5E) — deterministic, denormalized from the latest
    // reconciled SolanaForensicsRun. Never touched by aiAssessment.
    forensicsStatus: report.forensics.status,
    forensicsJobId: report.forensics.jobId,
    forensicsRunId: report.forensics.runId,
    forensicsAnalysisLevel: report.forensics.analysisLevel,
    forensicsPolicyVersion: report.forensics.policyVersion,
    forensicsEligibility: report.forensics.eligibility,
    forensicsDisplaySeverity: report.forensics.displaySeverity,
    forensicsReasonCodes: report.forensics.reasonCodes,
    forensicsRequiredEvidenceComplete: report.forensics.requiredEvidenceComplete,
    forensicsInitialBundledAcquisitionPct: report.forensics.initialBundledAcquisitionPct,
    forensicsCurrentBundleWalletHoldingsPct: report.forensics.currentBundleWalletHoldingsPct,
    forensicsDeveloperClusterHoldingsPct: report.forensics.developerClusterHoldingsPct,
    forensicsSuspectedCoordinatedHoldingsPct: report.forensics.suspectedCoordinatedHoldingsPct,
    forensicsInsiderHoldingsPct: report.forensics.insiderHoldingsPct,
    forensicsSniperHoldingsPct: report.forensics.sniperHoldingsPct,
    forensicsAdjustedTop10HoldingsPct: report.forensics.adjustedTop10HoldingsPct,
    forensicsCompletedAt: report.forensics.completedAt,

    aiNarrative: report.aiAssessment.narrative,
    aiCategory: report.aiAssessment.category,
    aiRiskLevel: report.aiAssessment.riskLevel,
    aiConfidence: report.aiAssessment.confidence,
    aiPositiveSignals: report.aiAssessment.positiveSignals,
    aiRiskFactors: report.aiAssessment.riskFactors,
    aiReasons: report.aiAssessment.reasons,
    aiMissingInfo: report.aiAssessment.missingInformation,
    aiDataQualityWarnings: report.aiAssessment.dataQualityWarnings,
    aiRecommendation: report.aiAssessment.recommendation,

    // AI provider telemetry (Phase 3) — absent when aiAssessment.meta wasn't set.
    aiProvider: report.aiAssessment.meta?.provider,
    aiModel: report.aiAssessment.meta?.model,
    aiPromptVersion: report.aiAssessment.meta?.promptVersion,
    aiSchemaVersion: report.aiAssessment.meta?.schemaVersion,
    aiLatencyMs: report.aiAssessment.meta?.latencyMs,
    aiInputTokens: report.aiAssessment.meta?.inputTokens,
    aiOutputTokens: report.aiAssessment.meta?.outputTokens,
    aiCompletedAt: report.aiAssessment.meta?.completedAt,
    aiValidationStatus: report.aiAssessment.meta?.validationStatus,
    aiFailureReason: report.aiAssessment.meta?.failureReason,

    status: report.processing.status,
    startedAt: report.processing.startedAt,
    completedAt: report.processing.completedAt,
  };

  await prisma.tokenIntelligenceReport.upsert({
    where: { eventId: report.eventId },
    create: {
      eventId: report.eventId,
      ...data,
      evidence: {
        create: [
          ...(report.bundlesAndSnipers.evidence as object[]).map((payload) => ({
            category: "bundlesAndSnipers",
            payload: payload as object,
          })),
        ],
      },
      errors: { create: errorRows },
    },
    update: {
      ...data,
    },
  });
}
