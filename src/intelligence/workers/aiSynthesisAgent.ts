import { TokenDiscoveryEvent, TokenIntelligenceReport, WorkerResult } from "../types";
import { synthesizeWithAnthropic } from "../providers/anthropicSynthesisProvider";

type AiAssessmentResult = TokenIntelligenceReport["aiAssessment"];

function deterministicMissingInformation(
  partial: Omit<TokenIntelligenceReport, "aiAssessment" | "processing">
): string[] {
  const missingInformation: string[] = [];
  if (!partial.token.name && !partial.token.symbol) missingInformation.push("token identity");
  if (partial.market.price === undefined) missingInformation.push("market price");
  if (!partial.safety.rugCheck && !partial.safety.solSniffer) missingInformation.push("safety report");
  if (partial.bundlesAndSnipers.evidence.length === 0) missingInformation.push("bundle/sniper evidence");
  if (!partial.socials.website && !partial.socials.twitter && !partial.socials.telegram) {
    missingInformation.push("social links");
  }
  return missingInformation;
}

/**
 * Phase 3: real AI synthesis via the Anthropic Messages API
 * (providers/anthropicSynthesisProvider.ts). This wrapper's only job is to
 * map that provider's result onto the WorkerResult<aiAssessment> contract
 * and guarantee the deterministic report is always preserved — an AI
 * failure of any kind (timeout, refusal, rate limit, malformed output,
 * missing API key) degrades gracefully to the same safe "unknown" shape
 * the Phase 1 stub used, it never throws, and it never fabricates
 * narrative/risk content.
 */
export async function aiSynthesisAgent(
  event: TokenDiscoveryEvent,
  partial: Omit<TokenIntelligenceReport, "aiAssessment" | "processing">
): Promise<WorkerResult<AiAssessmentResult>> {
  const missingInformation = deterministicMissingInformation(partial);

  const result = await synthesizeWithAnthropic(event, partial);

  if (!result.ok || !result.data) {
    return {
      data: {
        riskLevel: "UNKNOWN",
        confidence: 0,
        positiveSignals: [],
        riskFactors: [],
        reasons: [`AI synthesis unavailable (${result.meta.validationStatus})`],
        missingInformation,
        dataQualityWarnings: result.meta.failureReason ? [result.meta.failureReason] : [],
        recommendation: "RESEARCH_ONLY",
        meta: result.meta,
      },
      errors: [`aiSynthesis ${result.meta.validationStatus}: ${result.meta.failureReason ?? "no data returned"}`],
    };
  }

  return {
    data: {
      narrative: result.data.narrative,
      category: result.data.category,
      riskLevel: result.data.riskLevel,
      confidence: result.data.confidence,
      positiveSignals: result.data.positiveSignals,
      riskFactors: result.data.riskFactors,
      reasons: result.data.reasons,
      missingInformation: result.data.missingInformation,
      dataQualityWarnings: result.data.dataQualityWarnings,
      recommendation: "RESEARCH_ONLY",
      meta: result.meta,
    },
    errors: [],
  };
}
