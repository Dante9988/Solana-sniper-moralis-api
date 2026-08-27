/**
 * Phase 6 — shared projection (phase6.txt §2.1).
 *
 * Pure functions only: no network, no Prisma, no env reads. Takes
 * already-loaded, plain-value rows and returns a `RiskView`. This is the one
 * place verdict/signal derivation happens; Discord and the HTTP API render
 * the same `RiskView` so they can never disagree with each other.
 *
 * Phase 6 adds no new analyzers: every signal here is read off values Phase
 * 1-5 already computed (the deterministic forensics eligibility policy's
 * reason codes, and the Phase 1/2 safety worker's authority/LP fields).
 * Where no analyzer exists yet (wash-trade detection, cross-launch developer
 * history), the signal is always `UNVERIFIED` — absence is never rendered as
 * safety (phase6.txt §1.2).
 */

export type SignalStatus = "CONFIRMED" | "CLEAR" | "UNVERIFIED";
export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "NONE";
export type Verdict = "EXCLUDED" | "HIGH_RISK" | "ELEVATED" | "UNVERIFIED";

export type SignalKey =
  | "BUNDLED_SUPPLY"
  | "WALLET_CLUSTERING"
  | "WASH_TRADE"
  | "MINT_AUTHORITY"
  | "LP_STATUS"
  | "DEV_HISTORY";

export type EvidenceRefKind = "TRANSACTION" | "WALLET" | "SLOT" | "ACCOUNT";

export interface EvidenceRef {
  kind: EvidenceRefKind;
  /** Transaction signature, wallet/account address, or slot number as a string — verifiable on a block explorer. */
  value: string;
  label?: string;
}

export interface Signal {
  key: SignalKey;
  status: SignalStatus;
  severity: Severity;
  /** e.g. "62% of supply acquired in launch block". Empty/neutral wording when status is not CONFIRMED. */
  headline: string;
  evidence: EvidenceRef[];
  measuredAt?: Date;
  /** Required, and only present, when status === 'UNVERIFIED'. */
  unverifiedReason?: string;
}

export interface RiskView {
  mint: string;
  verdict: Verdict;
  policyVersion: string;
  signals: Signal[];
  reportStatus: "COMPLETE" | "PARTIAL" | "FAILED";
  forensicsStatus: "PENDING" | "RUNNING" | "COMPLETE" | "PARTIAL" | "FAILED" | "ABSENT";
  synthesis?: { text: string; model: string; validated: boolean };
  recommendation: "RESEARCH_ONLY";
  generatedAt: Date;
}

/**
 * Fixed, non-negotiable duplicate of `forensics/thresholds.ts`'s
 * `MANDATORY_BUNDLE_EXCLUSION_PCT`. Not imported from there: that module
 * reads `process.env` at import time, which this pure presentation layer
 * must never do (phase6.txt §2). `riskView.test.ts` asserts the two stay
 * equal so drift is caught immediately.
 */
export const MANDATORY_BUNDLE_EXCLUSION_PCT = 40 as const;

/** The sole "mandatory signal" per phase5.txt/phase5d.txt — the two bundle metrics gating eligibility. */
const MANDATORY_SIGNAL_KEY: SignalKey = "BUNDLED_SUPPLY";

export type ForensicsPipelineStatus =
  | "DISABLED"
  | "NOT_REQUESTED"
  | "PENDING"
  | "RUNNING"
  | "COMPLETE"
  | "PARTIAL"
  | "FAILED";

export interface RiskViewForensicsInput {
  status: ForensicsPipelineStatus;
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

export interface RiskViewEvidenceRow {
  category: string;
  signature?: string | null;
  slot?: number | null;
  wallets: string[];
}

export interface RiskViewClusterRow {
  classification: string;
  members: string[];
}

export interface RiskViewSafetyInput {
  /** Non-null string means the authority still exists (not renounced). `undefined`/`null` is ambiguous between "renounced" and "never observed" — `confidence` disambiguates. */
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  /** 0 means the Phase 1/2 safety worker never completed for this report. */
  confidence: number;
  /** From `safetySolSniffer.auditRisk.lpBurned`; `undefined` means the field was never populated. */
  lpBurned?: boolean;
}

export interface RiskViewAiInput {
  narrative?: string;
  model?: string;
  validationStatus?: string;
}

export interface RiskViewInput {
  mint: string;
  reportStatus: "COMPLETE" | "PARTIAL" | "FAILED";
  generatedAt: Date;
  safety: RiskViewSafetyInput;
  ai?: RiskViewAiInput;
  forensics: RiskViewForensicsInput;
  forensicsEvidence: RiskViewEvidenceRow[];
  forensicsClusters: RiskViewClusterRow[];
}

function pct(value: number | undefined): string {
  return value === undefined ? "" : `${Number(value.toFixed(2))}%`;
}

function unverified(key: SignalKey, reason: string): Signal {
  return { key, status: "UNVERIFIED", severity: "NONE", headline: "Not verified", evidence: [], unverifiedReason: reason };
}

function clear(key: SignalKey, headline: string, measuredAt?: Date): Signal {
  return { key, status: "CLEAR", severity: "NONE", headline, evidence: [], measuredAt };
}

function confirmed(
  key: SignalKey,
  severity: Severity,
  headline: string,
  evidence: EvidenceRef[],
  measuredAt?: Date
): Signal {
  return { key, status: "CONFIRMED", severity, headline, evidence, measuredAt };
}

const FORENSICS_UNVERIFIED_REASON: Record<ForensicsPipelineStatus, string> = {
  DISABLED: "Forensics analysis is disabled for this deployment.",
  NOT_REQUESTED: "No forensics analysis has been requested for this token yet.",
  PENDING: "Forensics analysis is queued but has not started.",
  RUNNING: "Forensics analysis is in progress.",
  FAILED: "The last forensics analysis attempt failed.",
  COMPLETE: "",
  PARTIAL: "",
};

function forensicsUsable(f: RiskViewForensicsInput): boolean {
  return f.status === "COMPLETE" || f.status === "PARTIAL";
}

function launchAcquisitionEvidence(rows: RiskViewEvidenceRow[]): EvidenceRef[] {
  return rows
    .filter((r) => r.category === "LAUNCH_ACQUISITION")
    .flatMap((r): EvidenceRef[] => {
      const refs: EvidenceRef[] = [];
      if (r.signature) refs.push({ kind: "TRANSACTION", value: r.signature });
      if (r.slot !== undefined && r.slot !== null) refs.push({ kind: "SLOT", value: String(r.slot) });
      for (const wallet of r.wallets) refs.push({ kind: "WALLET", value: wallet });
      return refs;
    });
}

function clusterEvidence(rows: RiskViewEvidenceRow[], clusters: RiskViewClusterRow[]): EvidenceRef[] {
  const fromEvidence = rows
    .filter((r) => r.category === "WALLET_RELATIONSHIP" || r.category === "WALLET_FUNDING")
    .flatMap((r): EvidenceRef[] => {
      const refs: EvidenceRef[] = [];
      if (r.signature) refs.push({ kind: "TRANSACTION", value: r.signature });
      for (const wallet of r.wallets) refs.push({ kind: "WALLET", value: wallet });
      return refs;
    });
  const fromClusters = clusters.flatMap((c): EvidenceRef[] =>
    c.members.map((wallet) => ({ kind: "WALLET" as const, value: wallet, label: c.classification }))
  );
  return [...fromEvidence, ...fromClusters];
}

function computeBundledSupplySignal(f: RiskViewForensicsInput, evidenceRows: RiskViewEvidenceRow[]): Signal {
  const key: SignalKey = "BUNDLED_SUPPLY";

  // Mandatory hard-exclusion check happens unconditionally, ahead of the
  // "is the pipeline usable" gate — mirrors tokenEligibilityPolicy.ts's own
  // ordering: an exclusion can fire even if the *other* mandatory metric is
  // incomplete.
  const worst = Math.max(f.initialBundledAcquisitionPct ?? -1, f.currentBundleWalletHoldingsPct ?? -1);
  if (worst >= MANDATORY_BUNDLE_EXCLUSION_PCT) {
    const value = f.initialBundledAcquisitionPct !== undefined && f.initialBundledAcquisitionPct >= MANDATORY_BUNDLE_EXCLUSION_PCT
      ? f.initialBundledAcquisitionPct
      : f.currentBundleWalletHoldingsPct;
    return confirmed(
      key,
      "CRITICAL",
      `${pct(value)} of supply acquired in the launch block or currently held by the bundled cluster`,
      launchAcquisitionEvidence(evidenceRows),
      f.completedAt
    );
  }

  if (!forensicsUsable(f)) return unverified(key, FORENSICS_UNVERIFIED_REASON[f.status]);
  if (!f.requiredEvidenceComplete || f.eligibility === "UNKNOWN") {
    return unverified(key, "Mandatory bundle-acquisition evidence is incomplete for this token.");
  }

  if (f.reasonCodes.includes("BUNDLED_SUPPLY_WARNING_THRESHOLD")) {
    return confirmed(
      key,
      "HIGH",
      `${pct(worst)} of supply acquired in the launch block`,
      launchAcquisitionEvidence(evidenceRows),
      f.completedAt
    );
  }

  return clear(key, "No bundled-acquisition threshold was crossed.", f.completedAt);
}

function computeWalletClusteringSignal(f: RiskViewForensicsInput, evidenceRows: RiskViewEvidenceRow[], clusters: RiskViewClusterRow[]): Signal {
  const key: SignalKey = "WALLET_CLUSTERING";
  if (!forensicsUsable(f)) return unverified(key, FORENSICS_UNVERIFIED_REASON[f.status]);
  if (!f.requiredEvidenceComplete || f.eligibility === "UNKNOWN") {
    return unverified(key, "Wallet-cluster evidence is incomplete for this token.");
  }

  if (f.reasonCodes.includes("INSIDER_CLUSTER_HOLDINGS_WARNING_THRESHOLD")) {
    return confirmed(
      key,
      "CRITICAL",
      `${pct(f.insiderHoldingsPct)} of supply held by wallets with a deterministic privileged-access link to the developer`,
      clusterEvidence(evidenceRows, clusters),
      f.completedAt
    );
  }
  if (
    f.reasonCodes.includes("DEVELOPER_CLUSTER_HOLDINGS_WARNING_THRESHOLD") ||
    f.reasonCodes.includes("ADJUSTED_TOP10_HOLDINGS_WARNING_THRESHOLD")
  ) {
    const value = f.developerClusterHoldingsPct ?? f.adjustedTop10HoldingsPct;
    return confirmed(
      key,
      "HIGH",
      `${pct(value)} of supply concentrated in a developer-linked or top-holder cluster`,
      clusterEvidence(evidenceRows, clusters),
      f.completedAt
    );
  }
  if (
    f.reasonCodes.includes("SNIPER_HOLDINGS_WARNING_THRESHOLD") ||
    f.reasonCodes.includes("BOUNDED_FRESH_WALLET_HOLDINGS_WARNING_THRESHOLD")
  ) {
    const value = f.sniperHoldingsPct ?? f.suspectedCoordinatedHoldingsPct;
    return confirmed(
      key,
      "MEDIUM",
      `${pct(value)} of supply held by sniper or suspected-coordinated wallets`,
      clusterEvidence(evidenceRows, clusters),
      f.completedAt
    );
  }
  if (f.suspectedCoordinatedHoldingsPct !== undefined && f.suspectedCoordinatedHoldingsPct > 0) {
    return confirmed(
      key,
      "LOW",
      `${pct(f.suspectedCoordinatedHoldingsPct)} of supply held by suspected-coordinated wallets below the warning threshold`,
      clusterEvidence(evidenceRows, clusters),
      f.completedAt
    );
  }

  return clear(key, "No coordinated-wallet or insider concentration threshold was crossed.", f.completedAt);
}

function computeMintAuthoritySignal(safety: RiskViewSafetyInput): Signal {
  const key: SignalKey = "MINT_AUTHORITY";
  if (safety.confidence <= 0) return unverified(key, "The mint/freeze authority check never completed for this token.");

  const refs: EvidenceRef[] = [];
  if (safety.mintAuthority) refs.push({ kind: "ACCOUNT", value: safety.mintAuthority, label: "mint authority" });
  if (safety.freezeAuthority) refs.push({ kind: "ACCOUNT", value: safety.freezeAuthority, label: "freeze authority" });

  if (safety.mintAuthority && safety.freezeAuthority) {
    return confirmed(key, "HIGH", "Mint authority and freeze authority are both still active", refs);
  }
  if (safety.mintAuthority) return confirmed(key, "HIGH", "Mint authority is still active — supply is not fixed", refs);
  if (safety.freezeAuthority) return confirmed(key, "MEDIUM", "Freeze authority is still active — accounts can be frozen", refs);
  return clear(key, "Mint authority and freeze authority are both renounced.");
}

function computeLpStatusSignal(safety: RiskViewSafetyInput): Signal {
  const key: SignalKey = "LP_STATUS";
  if (safety.confidence <= 0 || safety.lpBurned === undefined) {
    return unverified(key, "Liquidity-pool burn status is unavailable for this token.");
  }
  if (!safety.lpBurned) return confirmed(key, "HIGH", "Liquidity-pool tokens are not burned/locked", []);
  return clear(key, "Liquidity-pool tokens are burned.");
}

/** No wash-trade analyzer exists anywhere in Phase 1-5 — this can never be anything but UNVERIFIED. */
function computeWashTradeSignal(): Signal {
  return unverified("WASH_TRADE", "No wash-trade analyzer is implemented yet — this signal cannot be evaluated.");
}

/** No cross-launch developer-history analyzer exists anywhere in Phase 1-5 — this can never be anything but UNVERIFIED. */
function computeDevHistorySignal(): Signal {
  return unverified("DEV_HISTORY", "No developer launch-history analyzer is implemented yet — this signal cannot be evaluated.");
}

function deriveVerdict(signals: Signal[]): Verdict {
  const bundled = signals.find((s) => s.key === MANDATORY_SIGNAL_KEY);

  // 1) Phase 5A mandatory exclusion.
  if (bundled?.status === "CONFIRMED" && bundled.severity === "CRITICAL") return "EXCLUDED";

  // 2) Any signal CONFIRMED at CRITICAL.
  if (signals.some((s) => s.status === "CONFIRMED" && s.severity === "CRITICAL")) return "HIGH_RISK";

  // 3) The mandatory signal is UNVERIFIED.
  if (bundled?.status === "UNVERIFIED") return "UNVERIFIED";

  // 4) Any signal CONFIRMED at HIGH/MEDIUM.
  if (signals.some((s) => s.status === "CONFIRMED" && (s.severity === "HIGH" || s.severity === "MEDIUM"))) {
    return "ELEVATED";
  }

  // 5) Otherwise. Deliberately never CLEAR (phase6.txt §2.1).
  return "UNVERIFIED";
}

function mapForensicsStatusForView(status: ForensicsPipelineStatus): RiskView["forensicsStatus"] {
  if (status === "DISABLED" || status === "NOT_REQUESTED") return "ABSENT";
  return status;
}

export function buildRiskView(input: RiskViewInput): RiskView {
  const signals: Signal[] = [
    computeBundledSupplySignal(input.forensics, input.forensicsEvidence),
    computeWalletClusteringSignal(input.forensics, input.forensicsEvidence, input.forensicsClusters),
    computeWashTradeSignal(),
    computeMintAuthoritySignal(input.safety),
    computeLpStatusSignal(input.safety),
    computeDevHistorySignal(),
  ];

  return {
    mint: input.mint,
    verdict: deriveVerdict(signals),
    policyVersion: input.forensics.policyVersion ?? "unversioned",
    signals,
    reportStatus: input.reportStatus,
    forensicsStatus: mapForensicsStatusForView(input.forensics.status),
    synthesis:
      input.ai?.narrative && input.ai.model
        ? { text: input.ai.narrative, model: input.ai.model, validated: input.ai.validationStatus === "VALID" }
        : undefined,
    recommendation: "RESEARCH_ONLY",
    generatedAt: input.generatedAt,
  };
}
