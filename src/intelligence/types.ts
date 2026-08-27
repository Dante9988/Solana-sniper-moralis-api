export interface TokenDiscoveryEvent {
  id: string;
  // UNKNOWN: an evidence-based fallback for listener configs that cannot
  // prove which of the three sources produced the event (see index.ts
  // deriveTokenSource — e.g. the current "pumpswap"-labeled pool config
  // actually subscribes to the Pump.fun bonding-curve program, not the
  // real PumpSwap AMM, per ARCHITECTURE.md).
  source: "PUMPFUN" | "PUMPSWAP" | "MIGRATION" | "UNKNOWN";
  signature: string;
  mint: string;
  poolAddress?: string;
  discoveredAt: Date;
  receivedAt: Date;
  rawPayload: unknown;
}

export type IntelligenceForensicsStatus =
  | "DISABLED"
  | "NOT_REQUESTED"
  | "PENDING"
  | "RUNNING"
  | "COMPLETE"
  | "PARTIAL"
  | "FAILED";

/**
 * Deterministic, read-only projection of the latest reconciled
 * SolanaForensicsRun for this mint — never computed here, only read/mapped.
 * Optional percentage fields are absent (never `0`) when unavailable.
 */
export interface IntelligenceForensicsAssessment {
  status: IntelligenceForensicsStatus;
  jobId?: string;
  runId?: string;
  analysisLevel?: "FAST" | "DEEP";
  policyVersion?: string;
  eligibility?: "ELIGIBLE" | "CAUTION" | "EXCLUDED" | "UNKNOWN";
  displaySeverity?: "NORMAL" | "WARNING" | "DANGEROUS_EXCLUDED" | "UNKNOWN";
  reasonCodes: string[];
  requiredEvidenceComplete: boolean;
  initialBundledAcquisitionPct?: number;
  currentBundleWalletHoldingsPct?: number;
  developerClusterHoldingsPct?: number;
  suspectedCoordinatedHoldingsPct?: number;
  insiderHoldingsPct?: number;
  sniperHoldingsPct?: number;
  adjustedTop10HoldingsPct?: number;
  completedAt?: Date;
}

export interface TokenIntelligenceReport {
  eventId: string;
  mint: string;
  token: {
    name?: string;
    symbol?: string;
    imageUrl?: string;
    metadataUri?: string;
    creator?: string;
    creationTime?: Date;
  };
  socials: {
    website?: string;
    twitter?: string;
    telegram?: string;
    discord?: string;
    findings: string[];
  };
  market: {
    price?: number;
    marketCap?: number;
    fdv?: number;
    liquidity?: number;
    volume24h?: number;
    holders?: number;
    pools: unknown[];
    sources: unknown[];
  };
  safety: {
    mintAuthority?: string;
    freezeAuthority?: string;
    creatorHoldingsPct?: number;
    topHolderConcentrationPct?: number;
    rugCheck?: unknown;
    solSniffer?: unknown;
    riskFactors: string[];
    confidence: number;
  };
  bundlesAndSnipers: {
    status?: "AVAILABLE" | "UNAVAILABLE";
    source?: string;
    sniperPct?: number;
    bundledPct?: number;
    findings: string[];
    evidence: unknown[];
    confidence: number;
    errors?: string[];
  };
  /**
   * Deterministic Phase 5 forensic assessment — separate from `aiAssessment`
   * and never influenced by it. Populated by `bundleSniperResearcher` via an
   * injected lookup/enqueue service; the researcher itself never runs the
   * expensive analyzer inline (see src/services/forensicsIntelligenceLookupService.ts).
   */
  forensics: IntelligenceForensicsAssessment;
  aiAssessment: {
    narrative?: string;
    category?: string | null;
    riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | "UNKNOWN";
    confidence: number;
    positiveSignals: string[];
    riskFactors: string[];
    reasons: string[];
    missingInformation: string[];
    dataQualityWarnings: string[];
    recommendation: "RESEARCH_ONLY";
    // Present whenever a real provider call was attempted (Phase 3+);
    // absent for the pre-Phase-3 stub path / when never attempted.
    meta?: AiSynthesisMeta;
  };
  processing: {
    status: "COMPLETE" | "PARTIAL" | "FAILED";
    errors: string[];
    startedAt: Date;
    completedAt?: Date;
  };
}

// Why the AI synthesis call did or didn't produce a usable structured
// result. NOT_CONFIGURED means ANTHROPIC_API_KEY is unset; PROHIBITED_CONTENT
// means the response passed schema validation but a local trading-language
// guard rejected it anyway (see providers/anthropicSynthesisProvider.ts).
export type AiSynthesisValidationStatus =
  | "VALID"
  | "REFUSED"
  | "TIMEOUT"
  | "AUTH_ERROR"
  | "RATE_LIMITED"
  | "SCHEMA_INVALID"
  | "PROHIBITED_CONTENT"
  | "API_ERROR"
  | "NOT_CONFIGURED";

export interface AiSynthesisMeta {
  provider: "anthropic";
  model: string;
  promptVersion: string;
  schemaVersion: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  completedAt: Date;
  validationStatus: AiSynthesisValidationStatus;
  failureReason?: string;
}

/**
 * Uniform worker contract: every research worker (real or stub) returns this
 * shape so the orchestrator can isolate a failing worker without failing the
 * whole report, and so Phase 2+ can swap a stub for a real implementation
 * without touching orchestrator.ts.
 */
export interface WorkerResult<T> {
  data: T;
  errors: string[];
  fatal?: string;
}

export type MetadataWorker = (
  event: TokenDiscoveryEvent
) => Promise<WorkerResult<TokenIntelligenceReport["token"]>>;

export type MarketWorker = (
  event: TokenDiscoveryEvent
) => Promise<WorkerResult<TokenIntelligenceReport["market"]>>;

export type SafetyWorker = (
  event: TokenDiscoveryEvent
) => Promise<WorkerResult<TokenIntelligenceReport["safety"]>>;

export interface BundleSniperWorkerResult {
  bundlesAndSnipers: TokenIntelligenceReport["bundlesAndSnipers"];
  forensics: TokenIntelligenceReport["forensics"];
}

export type BundleSniperWorker = (
  event: TokenDiscoveryEvent
) => Promise<WorkerResult<BundleSniperWorkerResult>>;

// Takes the metadata result as input: the pump.fun frontend payload used for
// metadata already carries website/twitter/telegram in the same HTTP call.
export type SocialWorker = (
  event: TokenDiscoveryEvent,
  metadata: TokenIntelligenceReport["token"]
) => Promise<WorkerResult<TokenIntelligenceReport["socials"]>>;

export type AiSynthesisWorker = (
  event: TokenDiscoveryEvent,
  partial: Omit<TokenIntelligenceReport, "aiAssessment" | "processing">
) => Promise<WorkerResult<TokenIntelligenceReport["aiAssessment"]>>;
