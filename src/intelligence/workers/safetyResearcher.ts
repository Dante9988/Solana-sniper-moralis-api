import { fetchRugCheckReport, fetchSolSnifferReport } from "../../services/safetyCheckService";
import { TokenDiscoveryEvent, TokenIntelligenceReport, WorkerResult } from "../types";

type SafetyResult = TokenIntelligenceReport["safety"];

/**
 * Evidence-only safety worker. Never claims "safe" — only reports raw
 * findings, risk factors, and a confidence score for how much evidence was
 * actually available. Mirrors the read-only functions in
 * src/services/safetyCheckService.ts, never the trading-gated booleans in
 * src/transactions.ts.
 */
export async function safetyResearcher(
  event: TokenDiscoveryEvent
): Promise<WorkerResult<SafetyResult>> {
  const errors: string[] = [];
  const riskFactors: string[] = [];

  const [rugCheckResult, solSnifferResult] = await Promise.allSettled([
    fetchRugCheckReport(event.mint),
    fetchSolSnifferReport(event.mint),
  ]);

  const rugCheck = rugCheckResult.status === "fulfilled" ? rugCheckResult.value : null;
  const solSniffer = solSnifferResult.status === "fulfilled" ? solSnifferResult.value : null;

  if (!rugCheck) errors.push("RugCheck report unavailable");
  if (!solSniffer) errors.push("SolSniffer report unavailable");

  const data: SafetyResult = {
    rugCheck: rugCheck ?? undefined,
    solSniffer: solSniffer ?? undefined,
    riskFactors,
    confidence: 0,
  };

  if (rugCheck) {
    data.mintAuthority = rugCheck.token.mintAuthority ?? undefined;
    data.freezeAuthority = rugCheck.token.freezeAuthority ?? undefined;

    if (rugCheck.token.mintAuthority !== null) riskFactors.push("Mint authority is not renounced");
    if (rugCheck.token.freezeAuthority !== null) riskFactors.push("Freeze authority is not renounced");
    if (!rugCheck.token.isInitialized) riskFactors.push("Token is not initialized");
    if (rugCheck.tokenMeta.mutable) riskFactors.push("Token metadata is mutable");
    if (rugCheck.rugged) riskFactors.push("RugCheck flags this token as rugged");
    if (rugCheck.risks?.some((r) => r.name && r.name !== "Good")) {
      for (const risk of rugCheck.risks) {
        if (risk.name && risk.name !== "Good") {
          riskFactors.push(`RugCheck risk: ${risk.name}${risk.description ? ` — ${risk.description}` : ""}`);
        }
      }
    }

    const topHolders = rugCheck.topHolders ?? [];
    if (topHolders.length > 0) {
      data.topHolderConcentrationPct = Math.max(...topHolders.map((h) => h.pct));
      const creatorHolder = topHolders.find((h) => h.address === rugCheck.creator || h.owner === rugCheck.creator);
      if (creatorHolder) {
        data.creatorHoldingsPct = creatorHolder.pct;
      }
      if (data.topHolderConcentrationPct > 20) {
        riskFactors.push(`Top holder concentration is ${data.topHolderConcentrationPct.toFixed(1)}%`);
      }
    }
  }

  if (solSniffer?.auditRisk) {
    if (solSniffer.auditRisk.mintDisabled === false) riskFactors.push("SolSniffer: mint not disabled");
    if (solSniffer.auditRisk.freezeDisabled === false) riskFactors.push("SolSniffer: freeze authority not disabled");
    if (solSniffer.auditRisk.lpBurned === false) riskFactors.push("SolSniffer: LP tokens not burned");
  }

  // Confidence reflects how much evidence we actually gathered, not a
  // safety verdict — a report with zero risk factors found but zero sources
  // available should not read as "safe".
  const sourcesAvailable = [rugCheck, solSniffer].filter(Boolean).length;
  data.confidence = sourcesAvailable / 2;

  if (sourcesAvailable === 0) {
    return {
      data,
      errors,
      fatal: "No safety data source returned usable data",
    };
  }

  return { data, errors };
}
