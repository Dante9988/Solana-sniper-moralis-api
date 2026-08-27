/**
 * Phase 5E — pure, reusable eligibility guard for future search/recommendation
 * layers (phase5e.txt §11). Deterministic, imports nothing AI-related, and
 * is not connected to trading or notifications by this module or any caller
 * in this phase.
 */

import { TokenEligibility } from "./types";

export type CandidateGateMode = "NORMAL" | "HUMAN_REVIEW_ONLY" | "BLOCKED";

export interface CandidateGateResult {
  allowed: boolean;
  mode: CandidateGateMode;
  reasonCodes: string[];
}

export interface CandidateGateAssessment {
  eligibility?: TokenEligibility;
  requiredEvidenceComplete?: boolean;
}

function blocked(reasonCode: string): CandidateGateResult {
  return { allowed: false, mode: "BLOCKED", reasonCodes: [reasonCode] };
}

export function evaluateCandidateGate(assessment: CandidateGateAssessment | undefined | null): CandidateGateResult {
  if (!assessment || assessment.eligibility === undefined) {
    return blocked("MISSING_ELIGIBILITY_ASSESSMENT");
  }

  switch (assessment.eligibility) {
    case "EXCLUDED":
      return blocked("ELIGIBILITY_EXCLUDED");
    case "UNKNOWN":
      return blocked("ELIGIBILITY_UNKNOWN");
    case "CAUTION":
      return { allowed: true, mode: "HUMAN_REVIEW_ONLY", reasonCodes: ["ELIGIBILITY_CAUTION"] };
    case "ELIGIBLE":
      if (!assessment.requiredEvidenceComplete) {
        return blocked("ELIGIBLE_BUT_REQUIRED_EVIDENCE_INCOMPLETE");
      }
      return { allowed: true, mode: "NORMAL", reasonCodes: ["ELIGIBLE_COMPLETE_EVIDENCE"] };
    default:
      return blocked("UNRECOGNIZED_ELIGIBILITY_VALUE");
  }
}
