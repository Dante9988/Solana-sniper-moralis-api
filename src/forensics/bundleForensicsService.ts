/**
 * Phase 5C — forensics orchestrator (phase5c.txt §14, hardened by phase5d.txt §§1-4).
 *
 * Coordinates every analyzer against ONE injected client (which already
 * carries one shared request budget/deadline/abort signal from Phase 5B),
 * assembles `SolanaTokenForensicsReport`, and runs `evaluateTokenEligibility`
 * against the produced deterministic metrics only.
 *
 * Does NOT call Anthropic, persist anything, enqueue a job, touch the
 * existing intelligence report, or connect to the active bundle worker —
 * all of that is explicitly out of scope until a later, separately-approved
 * phase.
 */

import {
  AnalysisLevel,
  AuthorityState,
  BundleMetrics,
  CoverageStatus,
  DeveloperMetrics,
  ForensicError,
  ForensicEvidence,
  FreshWalletMetrics,
  InsiderMetrics,
  LaunchInfo,
  MandatoryMetricStatus,
  SniperMetrics,
  SolanaTokenForensicsReport,
  TokenEligibilityAssessment,
  WalletCluster,
} from "./types";
import { ForensicsRpcClient } from "./solanaForensicsClient";
import { analyzeLaunchTransaction, LaunchAcquirer, NON_BUYER_ACQUISITION_CLASSIFICATIONS } from "./launchTransactionAnalyzer";
import { identifyDeveloper } from "./developerIdentificationService";
import { analyzeFreshWalletStatus, analyzeWalletFunding, WalletFundingEvidence } from "./walletFundingAnalyzer";
import { buildWalletClusters, deriveClusterRole } from "./walletClusterService";
import { buildHolderSnapshot, currentHoldingsOf } from "./holderSnapshotService";
import { analyzeMintAuthority } from "./mintAuthorityAnalyzer";
import { AmountEntry, calculateBundledAcquisitionPct, calculateCurrentHoldingsPct } from "./percentageCalculations";
import { evaluateTokenEligibility } from "./tokenEligibilityPolicy";
import {
  FRESH_WALLET_DEFINITION_LABEL,
  MAX_HOLDER_PAGES_DEEP,
  MAX_HOLDER_PAGES_FAST,
  MAX_TRANSACTIONS_DEEP,
  MAX_TRANSACTIONS_FAST,
  MAX_WALLETS_DEEP,
  MAX_WALLETS_FAST,
} from "./thresholds";

export interface BundleForensicsInput {
  mint: string;
  discoverySignature?: string;
  discoverySource: LaunchInfo["source"];
  discoveredAt?: Date;
  receivedAt?: Date;
  analysisLevel: AnalysisLevel;
  /** Already-normalized candidates from the existing intelligence layer (phase5c.txt §9) — never fetched here. */
  pumpFunCreator?: string;
  rugCheckCreator?: string;
  metadataCreatorOrUpdateAuthority?: string;
}

export interface BundleForensicsDependencies {
  client: ForensicsRpcClient;
  now?: () => Date;
}

export interface BundleForensicsOutput {
  report: SolanaTokenForensicsReport;
  eligibility: TokenEligibilityAssessment;
  /** Every cluster produced this run (bundle/dev-linked/coordinated/insider/sniper/unknown) — for persistence/audit, not just the subsets re-exposed in specific report metrics. */
  clusters: WalletCluster[];
  /** The holder snapshot's context/indexed slot, when available — for persistence's "snapshot slot" field. */
  holderSnapshotSlot?: number;
}

function worseOf(a: CoverageStatus, b: CoverageStatus): CoverageStatus {
  const rank: Record<CoverageStatus, number> = { COMPLETE: 0, PARTIAL: 1, UNAVAILABLE: 2 };
  return rank[a] >= rank[b] ? a : b;
}

/** Aggregates eligible (non pool/vault/mint-destination) acquirer amounts by owner. Bigint-safe. */
function aggregateEligibleAcquirersByOwner(acquirers: LaunchAcquirer[], wallets: readonly string[]): AmountEntry[] {
  const walletSet = new Set(wallets);
  const totals = new Map<string, bigint>();
  for (const a of acquirers) {
    if (!a.owner || !walletSet.has(a.owner)) continue;
    if (NON_BUYER_ACQUISITION_CLASSIFICATIONS.has(a.classification)) continue;
    totals.set(a.owner, (totals.get(a.owner) ?? 0n) + BigInt(a.acquiredAmountRaw));
  }
  return Array.from(totals.entries()).map(([wallet, amount]) => ({ wallet, amount }));
}

export async function runBundleForensics(
  deps: BundleForensicsDependencies,
  input: BundleForensicsInput
): Promise<BundleForensicsOutput> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  let evidenceCounter = 0;
  const evidenceId = () => `ev-${input.mint}-${++evidenceCounter}`;
  const errors: ForensicError[] = [];
  const allEvidence: ForensicEvidence[] = [];
  const warnings: string[] = [];

  const limits =
    input.analysisLevel === "DEEP"
      ? { maxHolderPages: MAX_HOLDER_PAGES_DEEP, maxWallets: MAX_WALLETS_DEEP, maxTransactions: MAX_TRANSACTIONS_DEEP }
      : { maxHolderPages: MAX_HOLDER_PAGES_FAST, maxWallets: MAX_WALLETS_FAST, maxTransactions: MAX_TRANSACTIONS_FAST };

  // 1. Authorities (independent of everything else below).
  const authorityAnalysis = await analyzeMintAuthority(deps.client, input.mint);
  const authorities: AuthorityState = {
    tokenProgram: authorityAnalysis.tokenProgram,
    mintAuthority: authorityAnalysis.mintAuthority,
    freezeAuthority: authorityAnalysis.freezeAuthority,
    warnings: authorityAnalysis.warnings,
  };
  if (authorityAnalysis.warnings.length > 0) {
    errors.push({ stage: "mintAuthorityAnalyzer", message: authorityAnalysis.warnings.join("; "), retryable: false, occurredAt: now() });
  }

  // 2. Current supply.
  const supplyResult = await deps.client.getTokenSupply(input.mint);
  const currentSupply = supplyResult.status !== "UNAVAILABLE" ? BigInt(supplyResult.data.value.amount) : undefined;
  if (supplyResult.status === "UNAVAILABLE") {
    errors.push({ stage: "getTokenSupply", message: `${supplyResult.code}: ${supplyResult.reason}`, retryable: false, occurredAt: now() });
  }

  // 3. Launch transaction.
  const launch = await analyzeLaunchTransaction(
    deps.client,
    {
      mint: input.mint,
      discoverySignature: input.discoverySignature,
      discoverySource: input.discoverySource,
      discoveredAt: input.discoveredAt,
      receivedAt: input.receivedAt,
    },
    { evidenceId, now }
  );
  allEvidence.push(...launch.evidence);
  warnings.push(...launch.warnings);
  if (launch.coverage !== "COMPLETE") {
    errors.push({ stage: "launchTransactionAnalyzer", message: launch.warnings.join("; ") || "launch transaction unavailable", retryable: false, occurredAt: now() });
  }

  // 4. Developer identification (structured inputs only).
  const devId = identifyDeveloper(
    {
      pumpFunCreator: input.pumpFunCreator,
      rugCheckCreator: input.rugCheckCreator,
      metadataCreatorOrUpdateAuthority: input.metadataCreatorOrUpdateAuthority,
      launchTxCandidates: launch.creatorCandidates,
    },
    { evidenceId, now }
  );
  allEvidence.push(...devId.evidence);
  const developerWallet = devId.status === "IDENTIFIED" ? devId.developerWallet : undefined;

  // 5. One-hop bounded funding search + fresh-wallet check for a capped set of eligible-buyer wallets.
  const eligibleAcquirerWallets = Array.from(
    new Set(launch.acquirers.filter((a) => a.owner && !NON_BUYER_ACQUISITION_CLASSIFICATIONS.has(a.classification)).map((a) => a.owner as string))
  ).sort();
  const boundedBuyerWallets = eligibleAcquirerWallets.slice(0, limits.maxWallets);
  const reachedWalletLimit = eligibleAcquirerWallets.length > limits.maxWallets;
  const funding = new Map<string, WalletFundingEvidence>();
  const freshWalletResults = new Map<string, Awaited<ReturnType<typeof analyzeFreshWalletStatus>>>();
  for (const wallet of boundedBuyerWallets) {
    const f = await analyzeWalletFunding(deps.client, wallet, { maxTransactions: limits.maxTransactions, evidenceId, now });
    funding.set(wallet, f);
    allEvidence.push(...f.evidence);

    const fresh = await analyzeFreshWalletStatus(deps.client, wallet, {
      launchSlot: launch.slot,
      launchSignature: launch.signature,
      maxPages: limits.maxHolderPages,
      limitPerPage: limits.maxTransactions,
      definitionLabel: FRESH_WALLET_DEFINITION_LABEL,
      evidenceId,
      now,
    });
    freshWalletResults.set(wallet, fresh);
    allEvidence.push(...fresh.evidence);
  }
  if (reachedWalletLimit) warnings.push(`wallet expansion capped at ${limits.maxWallets} of ${eligibleAcquirerWallets.length} eligible acquirers`);

  // 6. Wallet clustering.
  const clusters = buildWalletClusters({
    launchSignature: launch.signature,
    acquirers: launch.acquirers,
    funding,
    developerWallet,
    evidenceId,
    now,
  });
  allEvidence.push(...clusters.flatMap((c) => c.evidence));

  // 7. Holder snapshot.
  const snapshot = await buildHolderSnapshot(deps.client, input.mint, {
    maxPages: limits.maxHolderPages,
    currentSupply,
    evidenceId,
    now,
  });
  allEvidence.push(...snapshot.evidence);
  warnings.push(...snapshot.warnings);
  if (snapshot.coverage !== "COMPLETE") {
    errors.push({ stage: "holderSnapshotService", message: snapshot.warnings.join("; ") || "holder snapshot incomplete", retryable: false, occurredAt: now() });
  }

  // 8. Bundle metrics. Pool/vault funding and mint destinations never count as bundled buyer acquisition (phase5d.txt §1).
  const bundleWallets = Array.from(new Set(clusters.filter((c) => c.classification === "CONFIRMED_BUNDLE").flatMap((c) => c.memberWallets)));
  const bundleInitialAmounts = aggregateEligibleAcquirersByOwner(launch.acquirers, bundleWallets);

  let initialBundledAcquisitionPct: number | undefined;
  let initialBundleMetricStatus: MandatoryMetricStatus;
  let initialBundleEstimate: BundleMetrics["initialBundleEstimate"];

  if (launch.coverage === "COMPLETE" && launch.launchSupply.status === "COMPLETE") {
    initialBundledAcquisitionPct = calculateBundledAcquisitionPct(bundleInitialAmounts, launch.launchSupply.rawSupply);
    initialBundleMetricStatus = initialBundledAcquisitionPct !== undefined ? "COMPLETE" : "UNAVAILABLE";
  } else if (launch.coverage === "COMPLETE" && currentSupply !== undefined) {
    const estimatePct = calculateBundledAcquisitionPct(bundleInitialAmounts, currentSupply);
    initialBundleMetricStatus = "ESTIMATED_ONLY";
    if (estimatePct !== undefined) {
      initialBundleEstimate = {
        pct: estimatePct,
        denominatorSource: "CURRENT_SUPPLY_APPROXIMATION",
        limitation: launch.launchSupply.limitation ?? "launch-slot supply could not be reconstructed from transaction evidence; this estimate uses current supply and is not authoritative",
      };
    }
  } else {
    initialBundleMetricStatus = "UNAVAILABLE";
  }

  const currentBundleAmounts = currentHoldingsOf(snapshot, bundleWallets);
  let currentBundleWalletHoldingsPct: number | undefined;
  let currentBundleMetricStatus: MandatoryMetricStatus;
  if (currentBundleAmounts) {
    currentBundleWalletHoldingsPct = calculateCurrentHoldingsPct(currentBundleAmounts, currentSupply);
    currentBundleMetricStatus = currentBundleWalletHoldingsPct !== undefined ? "COMPLETE" : "UNAVAILABLE";
  } else {
    currentBundleMetricStatus = snapshot.coverage === "PARTIAL" ? "PARTIAL" : "UNAVAILABLE";
  }

  const bundles: BundleMetrics = {
    initialBundledAcquisitionPct,
    initialBundleMetricStatus,
    initialBundleEstimate,
    currentBundleWalletHoldingsPct,
    currentBundleMetricStatus,
    clusters: clusters.filter((c) => c.classification === "CONFIRMED_BUNDLE"),
  };

  // 9. Sniper metrics — only INDEPENDENT_SNIPER clusters, which walletClusterService
  // already restricts to VERIFIED_BUY acquisitions (sufficiently supported market acquisition).
  const sniperWallets = clusters.filter((c) => c.classification === "INDEPENDENT_SNIPER").flatMap((c) => c.memberWallets);
  const sniperInitialAmounts = aggregateEligibleAcquirersByOwner(launch.acquirers, sniperWallets);
  const initialSniperAcquisitionPct =
    launch.coverage === "COMPLETE" && launch.launchSupply.status === "COMPLETE"
      ? calculateBundledAcquisitionPct(sniperInitialAmounts, launch.launchSupply.rawSupply)
      : undefined;
  const currentSniperAmounts = currentHoldingsOf(snapshot, sniperWallets);
  const currentSniperHoldingsPct = currentSniperAmounts ? calculateCurrentHoldingsPct(currentSniperAmounts, currentSupply) : undefined;

  const snipers: SniperMetrics = {
    initialSniperAcquisitionPct,
    currentSniperHoldingsPct,
    wallets: sniperWallets,
  };

  // 10. Developer metrics.
  let directHoldingsPct: number | undefined;
  let clusterHoldingsPct: number | undefined;
  let devLinkedWallets: string[] = [];
  if (developerWallet) {
    const devAmount = currentHoldingsOf(snapshot, [developerWallet]);
    directHoldingsPct = devAmount ? calculateCurrentHoldingsPct(devAmount, currentSupply) : undefined;

    const devClusters = clusters.filter((c) => c.classification === "DEV_LINKED_CLUSTER" || c.memberWallets.includes(developerWallet));
    devLinkedWallets = Array.from(new Set(devClusters.flatMap((c) => c.memberWallets).filter((w) => w !== developerWallet)));
    const devClusterAmounts = currentHoldingsOf(snapshot, [developerWallet, ...devLinkedWallets]);
    clusterHoldingsPct = devClusterAmounts ? calculateCurrentHoldingsPct(devClusterAmounts, currentSupply) : undefined;
  }

  const developer: DeveloperMetrics = {
    directHoldingsPct,
    clusterHoldingsPct,
    soldPct: undefined,
    transferredPct: undefined,
    linkedWallets: devLinkedWallets,
    creatorEvidence: devId.evidence,
  };

  // 11. Insider vs suspected-coordinated split (phase5d.txt §3). Coordination
  // alone never makes a cluster an insider — only a deterministic privileged-
  // access link does (here: a member's acquisition was INITIAL_DISTRIBUTION,
  // i.e. a direct transfer authorized by the fee payer/mint authority).
  const privilegedAcquisitionWallets = new Set(
    launch.acquirers.filter((a) => a.owner && a.classification === "INITIAL_DISTRIBUTION").map((a) => a.owner as string)
  );
  const likelyCoordinatedClusters = clusters.filter((c) => c.classification === "LIKELY_COORDINATED");
  const insiderClusters = likelyCoordinatedClusters.filter((c) => deriveClusterRole(c, privilegedAcquisitionWallets) === "INSIDER");
  const suspectedCoordinatedClusters = likelyCoordinatedClusters.filter(
    (c) => deriveClusterRole(c, privilegedAcquisitionWallets) === "SUSPECTED_COORDINATED"
  );
  const insiderWallets = Array.from(new Set(insiderClusters.flatMap((c) => c.memberWallets)));
  const suspectedCoordinatedWallets = Array.from(new Set(suspectedCoordinatedClusters.flatMap((c) => c.memberWallets)));
  const insiderAmounts = currentHoldingsOf(snapshot, insiderWallets);
  const suspectedCoordinatedAmounts = currentHoldingsOf(snapshot, suspectedCoordinatedWallets);
  const insiders: InsiderMetrics = {
    holdingsPct: insiderAmounts ? calculateCurrentHoldingsPct(insiderAmounts, currentSupply) : undefined,
    clusters: insiderClusters,
    suspectedCoordinatedHoldingsPct: suspectedCoordinatedAmounts
      ? calculateCurrentHoldingsPct(suspectedCoordinatedAmounts, currentSupply)
      : undefined,
    suspectedCoordinatedClusters,
  };

  // 12. Fresh-wallet metrics: only wallets whose pre-launch lookback was
  // actually and fully covered with no qualifying prior activity found.
  const freshWallets = boundedBuyerWallets.filter((w) => freshWalletResults.get(w)?.status === "FRESH");
  const freshAmounts = currentHoldingsOf(snapshot, freshWallets);
  const freshWalletMetrics: FreshWalletMetrics = {
    holdingsPct: freshAmounts ? calculateCurrentHoldingsPct(freshAmounts, currentSupply) : undefined,
    wallets: freshWallets,
    definition: FRESH_WALLET_DEFINITION_LABEL,
  };

  // 13. Overall coverage.
  const overallCoverage = worseOf(worseOf(launch.coverage, snapshot.coverage), currentSupply !== undefined ? "COMPLETE" : "PARTIAL");

  const report: SolanaTokenForensicsReport = {
    mint: input.mint,
    analysisLevel: input.analysisLevel,
    policyVersion: "", // stamped below, after eligibility is computed, to keep a single source of truth
    launch: {
      signature: launch.signature,
      slot: launch.slot,
      blockTime: launch.blockTime,
      // Never trust the discovery/config-supplied source label — only transaction evidence can prove it (phase5c.txt §5).
      source: launch.coverage === "COMPLETE" ? launch.derivedSource : "UNKNOWN",
      creatorWallet: developerWallet,
      creatorEvidence: launch.creatorCandidates.flatMap((c) => c.evidence),
    },
    coverage: {
      status: overallCoverage,
      analysisLevel: input.analysisLevel,
      holderPagesFetched: snapshot.holderPagesFetched,
      holderAccountsAnalyzed: snapshot.owners.reduce((sum, o) => sum + o.tokenAccounts.length, 0),
      transactionsAnalyzed: boundedBuyerWallets.length,
      walletsAnalyzed: boundedBuyerWallets.length,
      reachedConfiguredLimit: reachedWalletLimit,
      estimatedCreditsUsed: 0,
      requestCountsByMethod: {},
      warnings,
    },
    holderConcentration: snapshot.holderConcentration,
    bundles,
    developer,
    snipers,
    insiders,
    freshWallets: freshWalletMetrics,
    authorities,
    evidence: allEvidence,
    errors,
    startedAt,
    completedAt: now(),
  };

  const eligibility = evaluateTokenEligibility({
    mint: input.mint,
    initialBundledAcquisitionPct: report.bundles.initialBundledAcquisitionPct,
    initialBundleMetricStatus: report.bundles.initialBundleMetricStatus,
    currentBundleWalletHoldingsPct: report.bundles.currentBundleWalletHoldingsPct,
    currentBundleMetricStatus: report.bundles.currentBundleMetricStatus,
    warningMetrics: {
      developerClusterHoldingsPct: developer.clusterHoldingsPct,
      adjustedTop10HoldingsPct: snapshot.holderConcentration.adjustedTop10Pct,
      insiderClusterHoldingsPct: insiders.holdingsPct,
      sniperHoldingsPct: snipers.currentSniperHoldingsPct,
      boundedFreshWalletHoldingsPct: freshWalletMetrics.holdingsPct,
    },
    evaluatedAt: now(),
  });

  report.policyVersion = eligibility.policyVersion;

  return { report, eligibility, clusters, holderSnapshotSlot: snapshot.contextSlot };
}
