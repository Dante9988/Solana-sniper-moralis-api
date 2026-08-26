/**
 * Phase 5D — transactional forensic-run persistence (phase5d.txt §13).
 *
 * Persists run summary + evidence + clusters + members + errors +
 * deterministic eligibility in ONE database transaction: a partial failure
 * rolls back the whole run, and the caller must never mark the job complete
 * before this transaction succeeds. Every run is a new row — prior runs for
 * the same job are preserved for audit/version comparison, never overwritten.
 * Eligibility is stored in its own table, outside any AI-assessment column,
 * and nothing here ever reads or accepts AI-influenced input.
 */

import { Prisma, PrismaClient } from "@prisma/client";
import { AnalysisLevel, SolanaTokenForensicsReport, TokenEligibilityAssessment, WalletCluster } from "./types";

export interface PersistForensicsRunInput {
  jobId: string;
  assetId: string;
  mint: string;
  attemptNumber: number;
  analysisLevel: AnalysisLevel;
  runStatus: "COMPLETE" | "PARTIAL" | "FAILED";
  report: SolanaTokenForensicsReport;
  eligibility: TokenEligibilityAssessment;
  /** Every cluster produced this run — see `BundleForensicsOutput.clusters`. */
  clusters: WalletCluster[];
  holderSnapshotSlot?: number;
}

export interface PersistForensicsRunResult {
  runId: string;
}

function toDecimalOrNull(pct: number | undefined): Prisma.Decimal | null {
  return pct === undefined ? null : new Prisma.Decimal(pct);
}

/**
 * Bounded, compact report snapshot: metric values and evidence/cluster ID
 * references only — never unlimited raw transaction histories (the raw
 * signatures/slots live on the bounded `SolanaForensicsEvidence` rows).
 */
function compactReportJson(report: SolanaTokenForensicsReport): Prisma.InputJsonObject {
  return {
    mint: report.mint,
    analysisLevel: report.analysisLevel,
    policyVersion: report.policyVersion,
    launch: {
      signature: report.launch.signature ?? null,
      slot: report.launch.slot ?? null,
      source: report.launch.source,
      creatorWallet: report.launch.creatorWallet ?? null,
    },
    coverage: JSON.parse(JSON.stringify(report.coverage)),
    holderConcentration: JSON.parse(JSON.stringify(report.holderConcentration)),
    bundles: {
      initialBundledAcquisitionPct: report.bundles.initialBundledAcquisitionPct ?? null,
      initialBundleMetricStatus: report.bundles.initialBundleMetricStatus,
      initialBundleEstimate: report.bundles.initialBundleEstimate
        ? JSON.parse(JSON.stringify(report.bundles.initialBundleEstimate))
        : null,
      currentBundleWalletHoldingsPct: report.bundles.currentBundleWalletHoldingsPct ?? null,
      currentBundleMetricStatus: report.bundles.currentBundleMetricStatus,
      clusterIds: report.bundles.clusters.map((c) => c.id),
    },
    developer: JSON.parse(JSON.stringify(report.developer)),
    snipers: JSON.parse(JSON.stringify(report.snipers)),
    insiders: {
      holdingsPct: report.insiders.holdingsPct ?? null,
      clusterIds: report.insiders.clusters.map((c) => c.id),
      suspectedCoordinatedHoldingsPct: report.insiders.suspectedCoordinatedHoldingsPct ?? null,
      suspectedCoordinatedClusterIds: report.insiders.suspectedCoordinatedClusters.map((c) => c.id),
    },
    freshWallets: JSON.parse(JSON.stringify(report.freshWallets)),
    authorities: JSON.parse(JSON.stringify(report.authorities)),
    evidenceCount: report.evidence.length,
    errorCount: report.errors.length,
    startedAt: report.startedAt.toISOString(),
    completedAt: report.completedAt ? report.completedAt.toISOString() : null,
  };
}

export async function persistForensicsRun(
  db: PrismaClient,
  input: PersistForensicsRunInput
): Promise<PersistForensicsRunResult> {
  const { report, eligibility, clusters } = input;

  return db.$transaction(async (tx) => {
    const run = await tx.solanaForensicsRun.create({
      data: {
        jobId: input.jobId,
        assetId: input.assetId,
        mint: input.mint,
        attemptNumber: input.attemptNumber,
        analysisLevel: input.analysisLevel,
        policyVersion: report.policyVersion,
        runStatus: input.runStatus,
        coverageStatus: report.coverage.status,
        launchSlot: report.launch.slot ?? null,
        snapshotSlot: input.holderSnapshotSlot ?? null,
        initialBundleMetricStatus: report.bundles.initialBundleMetricStatus,
        currentBundleMetricStatus: report.bundles.currentBundleMetricStatus,
        initialBundledAcquisitionPct: toDecimalOrNull(report.bundles.initialBundledAcquisitionPct),
        currentBundleWalletHoldingsPct: toDecimalOrNull(report.bundles.currentBundleWalletHoldingsPct),
        directDeveloperPct: toDecimalOrNull(report.developer.directHoldingsPct),
        developerClusterPct: toDecimalOrNull(report.developer.clusterHoldingsPct),
        suspectedCoordinatedPct: toDecimalOrNull(report.insiders.suspectedCoordinatedHoldingsPct),
        insiderPct: toDecimalOrNull(report.insiders.holdingsPct),
        initialSniperAcquisitionPct: toDecimalOrNull(report.snipers.initialSniperAcquisitionPct),
        currentSniperHoldingsPct: toDecimalOrNull(report.snipers.currentSniperHoldingsPct),
        boundedFreshWalletHoldingsPct: toDecimalOrNull(report.freshWallets.holdingsPct),
        rawTop10Pct: toDecimalOrNull(report.holderConcentration.rawTop10Pct),
        adjustedTop10Pct: toDecimalOrNull(report.holderConcentration.adjustedTop10Pct),
        largestNonSystemHolderPct: toDecimalOrNull(report.holderConcentration.largestNonSystemHolderPct),
        holderCount: report.holderConcentration.holderCount ?? null,
        holderAccountsAnalyzed: report.coverage.holderAccountsAnalyzed,
        transactionsAnalyzed: report.coverage.transactionsAnalyzed,
        walletsAnalyzed: report.coverage.walletsAnalyzed,
        estimatedCreditsUsed: report.coverage.estimatedCreditsUsed,
        requestCount: Object.values(report.coverage.requestCountsByMethod).reduce((a, b) => a + b, 0),
        reachedConfiguredLimit: report.coverage.reachedConfiguredLimit,
        budgetExhausted: report.coverage.warnings.some((w) => w.includes("BUDGET_EXHAUSTED")),
        deadlineExceeded: report.coverage.warnings.some((w) => w.includes("TIMEOUT") || w.includes("deadline")),
        reportJson: compactReportJson(report),
        startedAt: report.startedAt,
        completedAt: report.completedAt ?? null,
      },
    });

    if (report.evidence.length > 0) {
      await tx.solanaForensicsEvidence.createMany({
        data: report.evidence.map((e) => ({
          runId: run.id,
          evidenceKey: e.id,
          category: e.category,
          reasonCode: e.reasonCode,
          source: e.source,
          signature: e.signature ?? null,
          slot: e.slot ?? null,
          wallets: e.wallets ?? [],
          amounts: e.amounts ?? Prisma.JsonNull,
          retrievedAt: e.retrievedAt,
        })),
        skipDuplicates: true,
      });
    }

    for (const cluster of clusters) {
      const clusterRow = await tx.solanaWalletCluster.create({
        data: {
          runId: run.id,
          clusterKey: cluster.id,
          classification: cluster.classification,
          confidence: new Prisma.Decimal(cluster.confidence),
          reasonCodes: cluster.reasonCodes,
        },
      });
      if (cluster.memberWallets.length > 0) {
        await tx.solanaWalletClusterMember.createMany({
          data: cluster.memberWallets.map((wallet) => ({ clusterId: clusterRow.id, wallet })),
          skipDuplicates: true,
        });
      }
    }

    if (report.errors.length > 0) {
      await tx.solanaForensicsError.createMany({
        data: report.errors.map((e) => ({
          runId: run.id,
          stage: e.stage,
          message: e.message.slice(0, 1000),
          retryable: e.retryable,
          occurredAt: e.occurredAt,
        })),
      });
    }

    // Eligibility is its own table, outside any AI-assessment column, and is
    // written only from the deterministic `eligibility` value computed by
    // tokenEligibilityPolicy.ts — nothing here reads AI output.
    await tx.solanaTokenEligibilityAssessment.create({
      data: {
        runId: run.id,
        mint: input.mint,
        eligibility: eligibility.eligibility,
        displaySeverity: eligibility.displaySeverity,
        reasonCodes: eligibility.reasonCodes,
        evaluatedMetrics: eligibility.evaluatedMetrics as Prisma.InputJsonValue,
        requiredEvidenceComplete: eligibility.requiredEvidenceComplete,
        policyVersion: eligibility.policyVersion,
        evaluatedAt: eligibility.evaluatedAt,
      },
    });

    return { runId: run.id };
  });
}
