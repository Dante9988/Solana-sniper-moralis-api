import { fetchPumpFunFrontendData } from "../../services/pumpFunSocialClient";
import { TokenDiscoveryEvent, TokenIntelligenceReport, WorkerResult } from "../types";

type SocialResult = TokenIntelligenceReport["socials"];

/**
 * Phase 1 stub: thin pass-through of whatever socials pump.fun's frontend
 * API returned (already fetched once by metadataResearcher's own call —
 * this worker re-fetches rather than threading the payload through, since
 * the metadata worker's contract only returns TokenIntelligenceReport["token"]).
 * No verification (domain age, account-age/impersonation checks) — that
 * needs services this codebase doesn't have yet; deferred to a later phase.
 */
export async function socialResearcher(
  event: TokenDiscoveryEvent,
  _metadata: TokenIntelligenceReport["token"]
): Promise<WorkerResult<SocialResult>> {
  const errors: string[] = [];
  const findings: string[] = [];

  const pumpFunData = await fetchPumpFunFrontendData(event.mint).catch((err) => {
    errors.push(`pump.fun social fetch failed: ${err}`);
    return null;
  });

  if (!pumpFunData) {
    return {
      data: { findings },
      errors,
      fatal: "No social data source returned usable data",
    };
  }

  const data: SocialResult = {
    website: pumpFunData.website || undefined,
    twitter: pumpFunData.twitter || undefined,
    telegram: pumpFunData.telegram || undefined,
    findings,
  };

  if (!data.website && !data.twitter && !data.telegram) {
    findings.push("No social links found in pump.fun metadata");
  }

  return { data, errors };
}
