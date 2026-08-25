import { TokenDiscoveryEvent, TokenIntelligenceReport, WorkerResult } from "../types";

type BundleSniperResult = TokenIntelligenceReport["bundlesAndSnipers"];
const PENDING = "Internal bundle and wallet-cluster forensics are not implemented yet";

/** Phase 3.1 placeholder: absence of internal forensics is unknown, never safe/zero evidence. */
export async function bundleSniperResearcher(
  _event: TokenDiscoveryEvent
): Promise<WorkerResult<BundleSniperResult>> {
  return {
    data: {
      status: "UNAVAILABLE",
      source: "INTERNAL_FORENSICS_PENDING",
      findings: [],
      evidence: [],
      confidence: 0,
      errors: [PENDING],
    },
    errors: [PENDING],
  };
}
