import { BundleSniperWorkerResult, TokenDiscoveryEvent, WorkerResult } from "../types";
import {
  defaultForensicsIntelligenceService,
  ForensicsIntelligenceService,
} from "../../services/forensicsIntelligenceLookupService";
import { IntelligenceForensicsAssessment } from "../types";

/**
 * Phase 5E: bundle/sniper research is now backed by the deterministic Phase 5
 * forensics job system via a narrow injected service — never a network call,
 * never the live analyzer, never anything AI-influenced. Absence of evidence
 * is still never represented as zero/safe (phase5.txt's Phase 3.1 rule,
 * unchanged): only status COMPLETE with real numbers ever populates
 * bundledPct/sniperPct.
 */

function mapToLegacyBundlesAndSnipers(
  forensics: IntelligenceForensicsAssessment
): BundleSniperWorkerResult["bundlesAndSnipers"] {
  const resolved = forensics.status === "COMPLETE" || forensics.status === "PARTIAL";
  return {
    status: resolved ? "AVAILABLE" : "UNAVAILABLE",
    source: resolved ? "INTERNAL_FORENSICS_ENGINE" : "INTERNAL_FORENSICS_PENDING",
    sniperPct: forensics.sniperHoldingsPct,
    bundledPct: forensics.currentBundleWalletHoldingsPct,
    findings: forensics.reasonCodes,
    evidence: [],
    confidence: forensics.requiredEvidenceComplete ? 1 : 0,
    errors: forensics.status === "FAILED" ? forensics.reasonCodes : undefined,
  };
}

export function createBundleSniperResearcher(
  service: ForensicsIntelligenceService = defaultForensicsIntelligenceService
) {
  return async function bundleSniperResearcher(
    event: TokenDiscoveryEvent
  ): Promise<WorkerResult<BundleSniperWorkerResult>> {
    const forensics = await service.getOrEnqueueForensicsAssessment({
      mint: event.mint,
      eventId: event.id,
      discoverySignature: event.signature,
      discoverySource: event.source,
    });

    const bundlesAndSnipers = mapToLegacyBundlesAndSnipers(forensics);

    // An EXCLUDED/CAUTION/ELIGIBLE result with COMPLETE evidence is not an
    // error — the report may be technically complete while eligibility is
    // excluded (phase5e.txt §7). Anything short of COMPLETE (DISABLED,
    // NOT_REQUESTED, PENDING, RUNNING, PARTIAL, FAILED) is recorded as a
    // soft error so the orchestrator's existing PARTIAL-degradation logic
    // applies unchanged — no special-casing needed in orchestrator.ts.
    const errors: string[] =
      forensics.status === "COMPLETE"
        ? []
        : [
            `deterministic forensics ${forensics.status.toLowerCase()}${
              forensics.jobId ? ` (job ${forensics.jobId})` : ""
            }`,
          ];

    return { data: { bundlesAndSnipers, forensics }, errors };
  };
}

export const bundleSniperResearcher = createBundleSniperResearcher();
