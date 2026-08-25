import { describe, expect, it, vi } from "vitest";
import { TokenIntelligenceOrchestrator } from "../orchestrator";
import { WorkerResult } from "../types";
import { pumpfunEvent } from "./fixtures/syntheticEvents";
import { bundleSniperResearcher } from "../workers/bundleSniperResearcher";

// No Prisma/DB in unit tests — persistence is exercised separately.
vi.mock("../reportStore", () => ({ saveReport: vi.fn().mockResolvedValue(undefined) }));

const ok = <T>(data: T): Promise<WorkerResult<T>> => Promise.resolve({ data, errors: [] });

describe("TokenIntelligenceOrchestrator", () => {
  it("keeps the pipeline usable but PARTIAL while internal bundle forensics are unavailable", async () => {
    const orchestrator = new TokenIntelligenceOrchestrator({
      metadata: () => ok({ name: "Synth", symbol: "SYNTH" }),
      market: () => ok({ price: 1, pools: [], sources: [] }),
      safety: () => ok({ riskFactors: [], confidence: 1 }),
      bundleSniper: bundleSniperResearcher,
      social: () => ok({ findings: [] }),
      aiSynthesis: () => ok({ riskLevel: "UNKNOWN" as const, confidence: 0, positiveSignals: [], riskFactors: [], reasons: [], missingInformation: [], dataQualityWarnings: [], recommendation: "RESEARCH_ONLY" as const }),
    });
    const report = await orchestrator.process(pumpfunEvent);
    expect(report.processing.status).toBe("PARTIAL");
    expect(report.token.name).toBe("Synth");
    expect(report.bundlesAndSnipers).toMatchObject({ status: "UNAVAILABLE", confidence: 0 });
  });

  it("returns COMPLETE when every worker succeeds with no errors", async () => {
    const orchestrator = new TokenIntelligenceOrchestrator({
      metadata: () => ok({ name: "Synth", symbol: "SYNTH" }),
      market: () => ok({ price: 1, pools: [], sources: [] }),
      safety: () => ok({ riskFactors: [], confidence: 1 }),
      bundleSniper: () => ok({ findings: [], evidence: [], confidence: 1 }),
      social: () => ok({ findings: [] }),
      aiSynthesis: () =>
        ok({
          riskLevel: "UNKNOWN" as const,
          confidence: 0,
          positiveSignals: [],
          riskFactors: [],
          reasons: [],
          missingInformation: [],
          dataQualityWarnings: [],
          recommendation: "RESEARCH_ONLY" as const,
        }),
    });

    const report = await orchestrator.process(pumpfunEvent);

    expect(report.processing.status).toBe("COMPLETE");
    expect(report.processing.errors).toHaveLength(0);
    expect(report.eventId).toBe(pumpfunEvent.id);
    expect(report.mint).toBe(pumpfunEvent.mint);
  });

  it("marks status PARTIAL when one worker throws but others succeed", async () => {
    const orchestrator = new TokenIntelligenceOrchestrator({
      metadata: () => ok({ name: "Synth", symbol: "SYNTH" }),
      market: () => {
        throw new Error("market API down");
      },
      safety: () => ok({ riskFactors: [], confidence: 1 }),
      bundleSniper: () => ok({ findings: [], evidence: [], confidence: 1 }),
      social: () => ok({ findings: [] }),
      aiSynthesis: () =>
        ok({
          riskLevel: "UNKNOWN" as const,
          confidence: 0,
          positiveSignals: [],
          riskFactors: [],
          reasons: [],
          missingInformation: [],
          dataQualityWarnings: [],
          recommendation: "RESEARCH_ONLY" as const,
        }),
    });

    const report = await orchestrator.process(pumpfunEvent);

    expect(report.processing.status).toBe("PARTIAL");
    expect(report.processing.errors.some((e) => e.includes("market API down"))).toBe(true);
    // A thrown worker must never propagate out of .process()
    expect(report.market).toEqual({ pools: [], sources: [] });
  });

  it("marks status PARTIAL when a worker returns a fatal WorkerResult (not a throw)", async () => {
    const orchestrator = new TokenIntelligenceOrchestrator({
      metadata: () => ok({ name: "Synth", symbol: "SYNTH" }),
      market: () => ok({ pools: [], sources: [] }),
      safety: () =>
        Promise.resolve({
          data: { riskFactors: [], confidence: 0 },
          errors: [],
          fatal: "no safety data source available",
        }),
      bundleSniper: () => ok({ findings: [], evidence: [], confidence: 1 }),
      social: () => ok({ findings: [] }),
      aiSynthesis: () =>
        ok({
          riskLevel: "UNKNOWN" as const,
          confidence: 0,
          positiveSignals: [],
          riskFactors: [],
          reasons: [],
          missingInformation: [],
          dataQualityWarnings: [],
          recommendation: "RESEARCH_ONLY" as const,
        }),
    });

    const report = await orchestrator.process(pumpfunEvent);

    expect(report.processing.status).toBe("PARTIAL");
    expect(report.processing.errors.some((e) => e.includes("no safety data source available"))).toBe(true);
  });

  it("marks status FAILED only when every worker returns fatal", async () => {
    const fatal = <T>(data: T): Promise<WorkerResult<T>> =>
      Promise.resolve({ data, errors: [], fatal: "no data" });

    const orchestrator = new TokenIntelligenceOrchestrator({
      metadata: () => fatal({}),
      market: () => fatal({ pools: [], sources: [] }),
      safety: () => fatal({ riskFactors: [], confidence: 0 }),
      bundleSniper: () => fatal({ findings: [], evidence: [], confidence: 0 }),
      social: () => fatal({ findings: [] }),
      aiSynthesis: () =>
        ok({
          riskLevel: "UNKNOWN" as const,
          confidence: 0,
          positiveSignals: [],
          riskFactors: [],
          reasons: [],
          missingInformation: [],
          dataQualityWarnings: [],
          recommendation: "RESEARCH_ONLY" as const,
        }),
    });

    const report = await orchestrator.process(pumpfunEvent);

    expect(report.processing.status).toBe("FAILED");
  });

  it("passes the metadata worker's result into the social worker", async () => {
    let receivedMetadata: unknown = null;

    const orchestrator = new TokenIntelligenceOrchestrator({
      metadata: () => ok({ name: "Synth", symbol: "SYNTH" }),
      market: () => ok({ pools: [], sources: [] }),
      safety: () => ok({ riskFactors: [], confidence: 1 }),
      bundleSniper: () => ok({ findings: [], evidence: [], confidence: 1 }),
      social: (_event, metadata) => {
        receivedMetadata = metadata;
        return ok({ findings: [] });
      },
      aiSynthesis: () =>
        ok({
          riskLevel: "UNKNOWN" as const,
          confidence: 0,
          positiveSignals: [],
          riskFactors: [],
          reasons: [],
          missingInformation: [],
          dataQualityWarnings: [],
          recommendation: "RESEARCH_ONLY" as const,
        }),
    });

    await orchestrator.process(pumpfunEvent);

    expect(receivedMetadata).toEqual({ name: "Synth", symbol: "SYNTH" });
  });

  it("downgrades an otherwise-COMPLETE report to PARTIAL when AI synthesis fails, while preserving the deterministic research", async () => {
    const orchestrator = new TokenIntelligenceOrchestrator({
      metadata: () => ok({ name: "Synth", symbol: "SYNTH" }),
      market: () => ok({ price: 1, pools: [], sources: [] }),
      safety: () => ok({ riskFactors: [], confidence: 1 }),
      bundleSniper: () => ok({ findings: [], evidence: [], confidence: 1 }),
      social: () => ok({ findings: [] }),
      aiSynthesis: () =>
        Promise.resolve({
          data: {
            riskLevel: "UNKNOWN" as const,
            confidence: 0,
            positiveSignals: [],
            riskFactors: [],
            reasons: ["AI synthesis unavailable (TIMEOUT)"],
            missingInformation: [],
            dataQualityWarnings: ["request timed out"],
            recommendation: "RESEARCH_ONLY" as const,
          },
          errors: ["aiSynthesis TIMEOUT: request timed out"],
        }),
    });

    const report = await orchestrator.process(pumpfunEvent);

    expect(report.processing.status).toBe("PARTIAL");
    expect(report.processing.errors.some((e) => e.includes("aiSynthesis") && e.includes("TIMEOUT"))).toBe(true);
    // Deterministic research must survive an AI failure untouched.
    expect(report.token).toEqual({ name: "Synth", symbol: "SYNTH" });
    expect(report.market).toEqual({ price: 1, pools: [], sources: [] });
    expect(report.aiAssessment.riskLevel).toBe("UNKNOWN");
    expect(report.aiAssessment.recommendation).toBe("RESEARCH_ONLY");
  });

  it("keeps a FAILED report FAILED even if AI synthesis itself succeeds", async () => {
    const fatal = <T>(data: T): Promise<WorkerResult<T>> =>
      Promise.resolve({ data, errors: [], fatal: "no data" });

    const orchestrator = new TokenIntelligenceOrchestrator({
      metadata: () => fatal({}),
      market: () => fatal({ pools: [], sources: [] }),
      safety: () => fatal({ riskFactors: [], confidence: 0 }),
      bundleSniper: () => fatal({ findings: [], evidence: [], confidence: 0 }),
      social: () => fatal({ findings: [] }),
      aiSynthesis: () =>
        ok({
          riskLevel: "LOW" as const,
          confidence: 1,
          positiveSignals: [],
          riskFactors: [],
          reasons: [],
          missingInformation: [],
          dataQualityWarnings: [],
          recommendation: "RESEARCH_ONLY" as const,
        }),
    });

    const report = await orchestrator.process(pumpfunEvent);

    expect(report.processing.status).toBe("FAILED");
  });
});
