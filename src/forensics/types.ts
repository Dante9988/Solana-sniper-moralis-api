/**
 * Phase 5A data contracts: deterministic Solana bundle/dev/insider/sniper/holder
 * forensics. Pure types + policy only. No network, RPC, or persistence here.
 */

export type AnalysisLevel = "FAST" | "DEEP";

export type CoverageStatus = "COMPLETE" | "PARTIAL" | "UNAVAILABLE";

/**
 * Status of one of the two mandatory bundle metrics.
 * ESTIMATED_ONLY means only a labeled, non-authoritative estimate exists
 * (see `BundleAcquisitionEstimate`); it can never satisfy `COMPLETE` and can
 * never drive `ELIGIBLE`.
 */
export type MandatoryMetricStatus = "COMPLETE" | "PARTIAL" | "UNAVAILABLE" | "ESTIMATED_ONLY";

export type WalletRelationshipType =
  | "COMMON_FUNDER"
  | "DEV_FUNDED"
  | "DIRECT_TRANSFER"
  | "COMMON_FEE_PAYER"
  | "SAME_TRANSACTION"
  | "SAME_SLOT"
  | "LAUNCH_WINDOW"
  | "RECURRING_COHORT"
  | "UNKNOWN";

export type WalletClusterClassification =
  | "CONFIRMED_BUNDLE"
  | "DEV_LINKED_CLUSTER"
  | "LIKELY_COORDINATED"
  | "INDEPENDENT_SNIPER"
  | "UNKNOWN";

export type ForensicEvidenceSource =
  | "HELIUS_DAS"
  | "HELIUS_RPC"
  | "SOLANA_STANDARD_RPC"
  | "MINT_ACCOUNT_DECODE"
  | "PUMPFUN_PROGRAM_STATE"
  | "PUMPSWAP_PROGRAM_STATE"
  | "RAYDIUM_PROGRAM_STATE"
  | "OTHER";

export interface ForensicEvidence {
  id: string;
  category: string;
  description: string;
  reasonCode: string;
  source: ForensicEvidenceSource;
  signature?: string;
  slot?: number;
  wallets?: string[];
  /** wallet address -> raw base-unit amount, as a string to preserve precision. */
  amounts?: Record<string, string>;
  retrievedAt: Date;
}

export interface ForensicError {
  stage: string;
  message: string;
  retryable: boolean;
  occurredAt: Date;
}

export interface WalletRelationship {
  type: WalletRelationshipType;
  wallets: [string, string];
  reasonCode: string;
  evidence: ForensicEvidence[];
  /**
   * False when this signal is merely a consequence of another already-counted
   * transaction artifact (e.g. a common fee payer that is only common because
   * both wallets share the same `SAME_TRANSACTION`). Classifiers must not count
   * two non-independent signals toward a `LIKELY_COORDINATED`/`CONFIRMED_BUNDLE`
   * evidence minimum.
   */
  independentSignal: boolean;
}

export interface WalletCluster {
  id: string;
  classification: WalletClusterClassification;
  /** 0..1. Never a substitute for missing evidence. */
  confidence: number;
  memberWallets: string[];
  relationships: WalletRelationship[];
  reasonCodes: string[];
  evidence: ForensicEvidence[];
}

export interface ForensicCoverage {
  status: CoverageStatus;
  analysisLevel: AnalysisLevel;
  holderPagesFetched: number;
  holderAccountsAnalyzed: number;
  transactionsAnalyzed: number;
  walletsAnalyzed: number;
  reachedConfiguredLimit: boolean;
  estimatedCreditsUsed: number;
  requestCountsByMethod: Record<string, number>;
  warnings: string[];
}

export interface ExcludedAccountEvidence {
  address: string;
  reasonCode: string;
  evidence: ForensicEvidence[];
}

export interface HolderConcentration {
  rawTop10Pct?: number;
  adjustedTop10Pct?: number;
  largestNonSystemHolderPct?: number;
  holderCount?: number;
  excludedAccounts: ExcludedAccountEvidence[];
}

export interface BundleAcquisitionEstimate {
  pct: number;
  denominatorSource: "CURRENT_SUPPLY_APPROXIMATION";
  /** Human-readable statement of why this is not authoritative. Always non-empty. */
  limitation: string;
}

export interface BundleMetrics {
  initialBundledAcquisitionPct?: number;
  initialBundleMetricStatus: MandatoryMetricStatus;
  /** Only populated when launch supply cannot be reconstructed; never read by eligibility policy. */
  initialBundleEstimate?: BundleAcquisitionEstimate;
  currentBundleWalletHoldingsPct?: number;
  currentBundleMetricStatus: MandatoryMetricStatus;
  clusters: WalletCluster[];
}

export interface DeveloperMetrics {
  directHoldingsPct?: number;
  clusterHoldingsPct?: number;
  soldPct?: number;
  transferredPct?: number;
  linkedWallets: string[];
  /** How the creator/developer wallet was identified. Empty means not identified. */
  creatorEvidence: ForensicEvidence[];
}

export interface SniperMetrics {
  initialSniperAcquisitionPct?: number;
  currentSniperHoldingsPct?: number;
  wallets: string[];
}

export interface InsiderMetrics {
  /** Only wallets with a deterministic privileged-access link (creator/developer, controlled initial distribution, etc.) — never every LIKELY_COORDINATED cluster (phase5d.txt §3). */
  holdingsPct?: number;
  clusters: WalletCluster[];
  /** LIKELY_COORDINATED clusters WITHOUT a privileged-access link land here instead of `holdingsPct`. */
  suspectedCoordinatedHoldingsPct?: number;
  suspectedCoordinatedClusters: WalletCluster[];
}

export interface FreshWalletMetrics {
  holdingsPct?: number;
  wallets: string[];
  /** e.g. "NO_ACTIVITY_OBSERVED_IN_BOUNDED_30_DAY_LOOKBACK" — bounded, never an absolute "newly created" claim. */
  definition: string;
}

export interface AuthorityState {
  tokenProgram?: "SPL_TOKEN" | "TOKEN_2022" | "UNKNOWN";
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  warnings: string[];
}

export interface LaunchInfo {
  signature?: string;
  slot?: number;
  blockTime?: Date;
  source: "PUMPFUN" | "PUMPSWAP" | "RAYDIUM" | "MIGRATION" | "UNKNOWN";
  creatorWallet?: string;
  creatorEvidence: ForensicEvidence[];
}

export interface SolanaTokenForensicsReport {
  mint: string;
  analysisLevel: AnalysisLevel;
  policyVersion: string;
  launch: LaunchInfo;
  coverage: ForensicCoverage;
  holderConcentration: HolderConcentration;
  bundles: BundleMetrics;
  developer: DeveloperMetrics;
  snipers: SniperMetrics;
  insiders: InsiderMetrics;
  freshWallets: FreshWalletMetrics;
  authorities: AuthorityState;
  evidence: ForensicEvidence[];
  errors: ForensicError[];
  startedAt: Date;
  completedAt?: Date;
}

export type TokenEligibility = "ELIGIBLE" | "CAUTION" | "EXCLUDED" | "UNKNOWN";

export type TokenEligibilityDisplaySeverity =
  | "NORMAL"
  | "WARNING"
  | "DANGEROUS_EXCLUDED"
  | "UNKNOWN";

export interface TokenEligibilityAssessment {
  eligibility: TokenEligibility;
  displaySeverity: TokenEligibilityDisplaySeverity;
  reasonCodes: string[];
  evaluatedMetrics: Record<string, number | boolean | null>;
  requiredEvidenceComplete: boolean;
  policyVersion: string;
  evaluatedAt: Date;
}
