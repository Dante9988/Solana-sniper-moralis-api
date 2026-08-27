/**
 * Phase 6 — versioned HTTP JSON projection (phase6.txt §2.2). Pure function,
 * stable field names; `src/researchApi/routes/tokens.ts` returns this shape as-is.
 */

import { RiskView } from "./riskView";

export const API_RISK_VIEW_VERSION = 1 as const;

export interface ApiRiskView {
  apiVersion: 1;
  mint: string;
  verdict: RiskView["verdict"];
  policyVersion: string;
  reportStatus: RiskView["reportStatus"];
  forensicsStatus: RiskView["forensicsStatus"];
  recommendation: "RESEARCH_ONLY";
  generatedAt: string;
  signals: Array<{
    key: RiskView["signals"][number]["key"];
    status: RiskView["signals"][number]["status"];
    severity: RiskView["signals"][number]["severity"];
    headline: string;
    evidence: RiskView["signals"][number]["evidence"];
    measuredAt?: string;
    unverifiedReason?: string;
  }>;
  synthesis?: { text: string; model: string; validated: boolean };
}

export function toApiJson(view: RiskView): ApiRiskView {
  return {
    apiVersion: API_RISK_VIEW_VERSION,
    mint: view.mint,
    verdict: view.verdict,
    policyVersion: view.policyVersion,
    reportStatus: view.reportStatus,
    forensicsStatus: view.forensicsStatus,
    recommendation: view.recommendation,
    generatedAt: view.generatedAt.toISOString(),
    signals: view.signals.map((signal) => ({
      key: signal.key,
      status: signal.status,
      severity: signal.severity,
      headline: signal.headline,
      evidence: signal.evidence,
      measuredAt: signal.measuredAt?.toISOString(),
      unverifiedReason: signal.unverifiedReason,
    })),
    synthesis: view.synthesis,
  };
}
