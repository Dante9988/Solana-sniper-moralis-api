import {
  AiSynthesisWorker,
  BundleSniperWorker,
  MarketWorker,
  MetadataWorker,
  SafetyWorker,
  SocialWorker,
  TokenDiscoveryEvent,
  TokenIntelligenceReport,
  WorkerResult,
} from "./types";
import { metadataResearcher } from "./workers/metadataResearcher";
import { marketResearcher } from "./workers/marketResearcher";
import { safetyResearcher } from "./workers/safetyResearcher";
import { bundleSniperResearcher } from "./workers/bundleSniperResearcher";
import { socialResearcher } from "./workers/socialResearcher";
import { aiSynthesisAgent } from "./workers/aiSynthesisAgent";
import { saveReport } from "./reportStore";

interface OrchestratorWorkers {
  metadata: MetadataWorker;
  market: MarketWorker;
  safety: SafetyWorker;
  bundleSniper: BundleSniperWorker;
  social: SocialWorker;
  aiSynthesis: AiSynthesisWorker;
}

async function safeRun<T>(
  label: string,
  run: () => Promise<WorkerResult<T>>,
  emptyData: T
): Promise<WorkerResult<T>> {
  try {
    return await run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`TokenIntelligenceOrchestrator: worker "${label}" threw:`, err);
    return { data: emptyData, errors: [], fatal: message };
  }
}

export class TokenIntelligenceOrchestrator {
  constructor(private workers: OrchestratorWorkers) {}

  async process(event: TokenDiscoveryEvent): Promise<TokenIntelligenceReport> {
    const startedAt = new Date();
    const processingErrors: string[] = [];
    let anyFatal = false;
    let anyDataAtAll = false;
    let anyErrorAtAll = false;

    const record = <T>(label: string, result: WorkerResult<T>) => {
      if (result.fatal) {
        anyFatal = true;
        anyErrorAtAll = true;
        processingErrors.push(`[${label}] ${result.fatal}`);
      } else {
        anyDataAtAll = true;
      }
      if (result.errors.length > 0) {
        anyErrorAtAll = true;
        for (const e of result.errors) processingErrors.push(`[${label}] ${e}`);
      }
    };

    const metadataPromise = safeRun("metadata", () => this.workers.metadata(event), {});
    const marketPromise = safeRun("market", () => this.workers.market(event), {
      pools: [],
      sources: [],
    });
    const safetyPromise = safeRun("safety", () => this.workers.safety(event), {
      riskFactors: [],
      confidence: 0,
    });
    const bundleSniperPromise = safeRun("bundleSniper", () => this.workers.bundleSniper(event), {
      bundlesAndSnipers: { findings: [], evidence: [], confidence: 0 },
      forensics: { status: "FAILED" as const, reasonCodes: [], requiredEvidenceComplete: false },
    });
    const socialPromise = metadataPromise.then((metadataResult) =>
      safeRun("social", () => this.workers.social(event, metadataResult.data), { findings: [] })
    );

    const [metadataResult, marketResult, safetyResult, bundleSniperResult, socialResult] =
      await Promise.all([
        metadataPromise,
        marketPromise,
        safetyPromise,
        bundleSniperPromise,
        socialPromise,
      ]);

    record("metadata", metadataResult);
    record("market", marketResult);
    record("safety", safetyResult);
    record("bundleSniper", bundleSniperResult);
    record("social", socialResult);

    // Status from the research workers above only. aiSynthesis (real as of
    // Phase 3) is a downstream summarizer of whatever they found and must
    // not be able to turn a FAILED report into PARTIAL just by trivially
    // succeeding itself — so this baseline is computed before aiSynthesis
    // runs and can only be downgraded afterward (see below), never upgraded.
    const researchStatus: TokenIntelligenceReport["processing"]["status"] = !anyDataAtAll
      ? "FAILED"
      : anyFatal || anyErrorAtAll
        ? "PARTIAL"
        : "COMPLETE";

    const partial: Omit<TokenIntelligenceReport, "aiAssessment" | "processing"> = {
      eventId: event.id,
      mint: event.mint,
      token: metadataResult.data,
      socials: socialResult.data,
      market: marketResult.data,
      safety: safetyResult.data,
      bundlesAndSnipers: bundleSniperResult.data.bundlesAndSnipers,
      forensics: bundleSniperResult.data.forensics,
    };

    const aiResult = await safeRun("aiSynthesis", () => this.workers.aiSynthesis(event, partial), {
      riskLevel: "UNKNOWN" as const,
      confidence: 0,
      positiveSignals: [],
      riskFactors: [],
      reasons: [],
      missingInformation: [],
      dataQualityWarnings: [],
      recommendation: "RESEARCH_ONLY" as const,
    });
    if (aiResult.fatal) processingErrors.push(`[aiSynthesis] ${aiResult.fatal}`);
    for (const e of aiResult.errors) processingErrors.push(`[aiSynthesis] ${e}`);

    // A failed/timed-out/refused/malformed AI call must degrade an
    // otherwise-COMPLETE report to PARTIAL and record the failure — it must
    // never crash the listener or discard the deterministic research above.
    const aiFailed = Boolean(aiResult.fatal) || aiResult.errors.length > 0;
    const status: TokenIntelligenceReport["processing"]["status"] =
      researchStatus === "COMPLETE" && aiFailed ? "PARTIAL" : researchStatus;

    const report: TokenIntelligenceReport = {
      ...partial,
      aiAssessment: aiResult.data,
      processing: {
        status,
        errors: processingErrors,
        startedAt,
        completedAt: new Date(),
      },
    };

    await saveReport(report).catch((err) => {
      console.error(`TokenIntelligenceOrchestrator: failed to persist report for ${event.mint}:`, err);
    });

    return report;
  }
}

export const defaultOrchestrator = new TokenIntelligenceOrchestrator({
  metadata: metadataResearcher,
  market: marketResearcher,
  safety: safetyResearcher,
  bundleSniper: bundleSniperResearcher,
  social: socialResearcher,
  aiSynthesis: aiSynthesisAgent,
});

export function processTokenDiscoveryEvent(
  event: TokenDiscoveryEvent
): Promise<TokenIntelligenceReport> {
  return defaultOrchestrator.process(event);
}
