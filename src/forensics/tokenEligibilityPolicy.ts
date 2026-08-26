/**
 * Phase 5A deterministic eligibility policy. Pure application logic — no
 * network I/O, no AI, no persistence. Anthropic may only explain a finalized
 * assessment; nothing in this module accepts or is influenced by AI input.
 *
 * Mandatory rule (non-negotiable, phase5.txt / phase4-5.txt §10):
 *   initialBundledAcquisitionPct >= 40 OR currentBundleWalletHoldingsPct >= 40
 *   => EXCLUDED, regardless of any other signal.
 * Missing/estimated/materially-incomplete mandatory evidence => UNKNOWN, never ELIGIBLE.
 */

import {
  CAUTION_THRESHOLDS,
  FORENSICS_POLICY_VERSION,
  MANDATORY_BUNDLE_EXCLUSION_PCT,
} from "./thresholds";
import {
  MandatoryMetricStatus,
  TokenEligibilityAssessment,
} from "./types";

export interface EligibilityWarningMetrics {
  developerClusterHoldingsPct?: number;
  adjustedTop10HoldingsPct?: number;
  insiderClusterHoldingsPct?: number;
  sniperHoldingsPct?: number;
  boundedFreshWalletHoldingsPct?: number;
}

export interface TokenEligibilityInput {
  mint: string;
  initialBundledAcquisitionPct?: number;
  initialBundleMetricStatus: MandatoryMetricStatus;
  currentBundleWalletHoldingsPct?: number;
  currentBundleMetricStatus: MandatoryMetricStatus;
  warningMetrics: EligibilityWarningMetrics;
  /** Injectable for deterministic tests; defaults to `new Date()`. */
  evaluatedAt?: Date;
}

function exceedsExclusion(pct: number | undefined): boolean {
  return pct !== undefined && pct >= MANDATORY_BUNDLE_EXCLUSION_PCT;
}

function buildEvaluatedMetrics(
  input: TokenEligibilityInput
): Record<string, number | boolean | null> {
  return {
    initialBundledAcquisitionPct: input.initialBundledAcquisitionPct ?? null,
    currentBundleWalletHoldingsPct: input.currentBundleWalletHoldingsPct ?? null,
    initialBundleMetricComplete: input.initialBundleMetricStatus === "COMPLETE",
    currentBundleMetricComplete: input.currentBundleMetricStatus === "COMPLETE",
    developerClusterHoldingsPct: input.warningMetrics.developerClusterHoldingsPct ?? null,
    adjustedTop10HoldingsPct: input.warningMetrics.adjustedTop10HoldingsPct ?? null,
    insiderClusterHoldingsPct: input.warningMetrics.insiderClusterHoldingsPct ?? null,
    sniperHoldingsPct: input.warningMetrics.sniperHoldingsPct ?? null,
    boundedFreshWalletHoldingsPct: input.warningMetrics.boundedFreshWalletHoldingsPct ?? null,
  };
}

/**
 * Pure, deterministic, and total: for any well-formed input there is exactly
 * one outcome. The AI layer never sees this function and cannot call it with
 * an override — there is no parameter through which one could be supplied.
 */
export function evaluateTokenEligibility(
  input: TokenEligibilityInput
): TokenEligibilityAssessment {
  const evaluatedAt = input.evaluatedAt ?? new Date();
  const evaluatedMetrics = buildEvaluatedMetrics(input);
  const requiredEvidenceComplete =
    input.initialBundleMetricStatus === "COMPLETE" &&
    input.currentBundleMetricStatus === "COMPLETE";

  // 1) Mandatory hard exclusion — checked first and unconditionally. An
  //    EXCLUDED verdict is the conservative direction, so it applies even if
  //    the *other* mandatory metric is incomplete.
  const exclusionReasons: string[] = [];
  if (exceedsExclusion(input.initialBundledAcquisitionPct)) {
    exclusionReasons.push("INITIAL_BUNDLED_ACQUISITION_AT_OR_ABOVE_40_PCT");
  }
  if (exceedsExclusion(input.currentBundleWalletHoldingsPct)) {
    exclusionReasons.push("CURRENT_BUNDLE_WALLET_HOLDINGS_AT_OR_ABOVE_40_PCT");
  }
  if (exclusionReasons.length > 0) {
    return {
      eligibility: "EXCLUDED",
      displaySeverity: "DANGEROUS_EXCLUDED",
      reasonCodes: exclusionReasons,
      evaluatedMetrics,
      requiredEvidenceComplete,
      policyVersion: FORENSICS_POLICY_VERSION,
      evaluatedAt,
    };
  }

  // 2) Missing/estimated/materially-incomplete mandatory evidence => UNKNOWN.
  //    Never ELIGIBLE from partial or estimated bundle evidence.
  if (!requiredEvidenceComplete) {
    return {
      eligibility: "UNKNOWN",
      displaySeverity: "UNKNOWN",
      reasonCodes: ["MANDATORY_BUNDLE_EVIDENCE_INCOMPLETE"],
      evaluatedMetrics,
      requiredEvidenceComplete: false,
      policyVersion: FORENSICS_POLICY_VERSION,
      evaluatedAt,
    };
  }

  // 3) Both mandatory metrics are complete and below 40% — evaluate warnings.
  const maxMandatoryPct = Math.max(
    input.initialBundledAcquisitionPct ?? 0,
    input.currentBundleWalletHoldingsPct ?? 0
  );

  const warningReasons: string[] = [];
  if (maxMandatoryPct >= CAUTION_THRESHOLDS.bundledSupplyPct) {
    warningReasons.push("BUNDLED_SUPPLY_WARNING_THRESHOLD");
  }
  if (
    (input.warningMetrics.developerClusterHoldingsPct ?? 0) >=
    CAUTION_THRESHOLDS.developerClusterHoldingsPct
  ) {
    warningReasons.push("DEVELOPER_CLUSTER_HOLDINGS_WARNING_THRESHOLD");
  }
  if (
    (input.warningMetrics.adjustedTop10HoldingsPct ?? 0) >=
    CAUTION_THRESHOLDS.adjustedTop10HoldingsPct
  ) {
    warningReasons.push("ADJUSTED_TOP10_HOLDINGS_WARNING_THRESHOLD");
  }
  if (
    (input.warningMetrics.insiderClusterHoldingsPct ?? 0) >=
    CAUTION_THRESHOLDS.insiderClusterHoldingsPct
  ) {
    warningReasons.push("INSIDER_CLUSTER_HOLDINGS_WARNING_THRESHOLD");
  }
  if ((input.warningMetrics.sniperHoldingsPct ?? 0) >= CAUTION_THRESHOLDS.sniperHoldingsPct) {
    warningReasons.push("SNIPER_HOLDINGS_WARNING_THRESHOLD");
  }
  if (
    (input.warningMetrics.boundedFreshWalletHoldingsPct ?? 0) >=
    CAUTION_THRESHOLDS.boundedFreshWalletHoldingsPct
  ) {
    warningReasons.push("BOUNDED_FRESH_WALLET_HOLDINGS_WARNING_THRESHOLD");
  }

  if (warningReasons.length > 0) {
    return {
      eligibility: "CAUTION",
      displaySeverity: "WARNING",
      reasonCodes: warningReasons,
      evaluatedMetrics,
      requiredEvidenceComplete: true,
      policyVersion: FORENSICS_POLICY_VERSION,
      evaluatedAt,
    };
  }

  return {
    eligibility: "ELIGIBLE",
    displaySeverity: "NORMAL",
    reasonCodes: ["MANDATORY_BUNDLE_METRICS_BELOW_WARNING_THRESHOLD"],
    evaluatedMetrics,
    requiredEvidenceComplete: true,
    policyVersion: FORENSICS_POLICY_VERSION,
    evaluatedAt,
  };
}
