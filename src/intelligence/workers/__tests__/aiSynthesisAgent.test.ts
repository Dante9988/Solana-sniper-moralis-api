import { describe, expect, it, vi } from "vitest";

vi.mock("../../providers/anthropicSynthesisProvider", () => ({
  synthesizeWithAnthropic: vi.fn(),
}));

import { synthesizeWithAnthropic } from "../../providers/anthropicSynthesisProvider";
import { aiSynthesisAgent } from "../aiSynthesisAgent";
import { pumpfunEvent } from "../../__tests__/fixtures/syntheticEvents";
import { TokenIntelligenceReport } from "../../types";

const mockedSynthesize = vi.mocked(synthesizeWithAnthropic);

const partial: Omit<TokenIntelligenceReport, "aiAssessment" | "processing"> = {
  eventId: pumpfunEvent.id,
  mint: pumpfunEvent.mint,
  token: {},
  socials: { findings: [] },
  market: { pools: [], sources: [] },
  safety: { riskFactors: [], confidence: 0 },
  bundlesAndSnipers: { findings: [], evidence: [], confidence: 0 },
};

const baseMeta = {
  provider: "anthropic" as const,
  model: "claude-haiku-4-5-20251001",
  promptVersion: "v1",
  schemaVersion: "v1",
  latencyMs: 42,
  completedAt: new Date("2026-01-01T00:00:02Z"),
};

describe("aiSynthesisAgent", () => {
  it("maps a successful provider result onto the WorkerResult contract with no errors", async () => {
    mockedSynthesize.mockResolvedValue({
      ok: true,
      data: {
        narrative: "narrative text",
        category: "meme",
        riskLevel: "LOW",
        confidence: 0.8,
        positiveSignals: ["a"],
        riskFactors: ["b"],
        reasons: ["c"],
        missingInformation: ["d"],
        dataQualityWarnings: [],
        recommendation: "RESEARCH_ONLY",
      },
      meta: { ...baseMeta, validationStatus: "VALID" },
    });

    const result = await aiSynthesisAgent(pumpfunEvent, partial);

    expect(result.errors).toHaveLength(0);
    expect(result.data.riskLevel).toBe("LOW");
    expect(result.data.narrative).toBe("narrative text");
    expect(result.data.recommendation).toBe("RESEARCH_ONLY");
    expect(result.data.meta?.validationStatus).toBe("VALID");
  });

  it("falls back to a safe UNKNOWN assessment and preserves the deterministic report when the provider fails", async () => {
    mockedSynthesize.mockResolvedValue({
      ok: false,
      meta: { ...baseMeta, validationStatus: "TIMEOUT", failureReason: "request timed out" },
    });

    const result = await aiSynthesisAgent(pumpfunEvent, partial);

    expect(result.data.riskLevel).toBe("UNKNOWN");
    expect(result.data.confidence).toBe(0);
    expect(result.data.recommendation).toBe("RESEARCH_ONLY");
    expect(result.data.narrative).toBeUndefined();
    expect(result.data.dataQualityWarnings).toContain("request timed out");
    expect(result.errors.some((e) => e.includes("TIMEOUT"))).toBe(true);
    expect(result.data.meta?.validationStatus).toBe("TIMEOUT");
  });

  it("never throws when the provider itself rejects", async () => {
    mockedSynthesize.mockRejectedValue(new Error("unexpected"));

    await expect(aiSynthesisAgent(pumpfunEvent, partial)).rejects.toThrow();
    // Note: aiSynthesisAgent itself doesn't need to catch this — the
    // orchestrator's safeRun() wrapper is the isolation boundary for every
    // worker, including aiSynthesis (see orchestrator.ts safeRun usage).
  });

  it("computes deterministic missingInformation heuristics as a fallback signal even though AI failed", async () => {
    mockedSynthesize.mockResolvedValue({
      ok: false,
      meta: { ...baseMeta, validationStatus: "NOT_CONFIGURED", failureReason: "ANTHROPIC_API_KEY is not set" },
    });

    const emptyPartial: Omit<TokenIntelligenceReport, "aiAssessment" | "processing"> = {
      eventId: pumpfunEvent.id,
      mint: pumpfunEvent.mint,
      token: {},
      socials: { findings: [] },
      market: { pools: [], sources: [] },
      safety: { riskFactors: [], confidence: 0 },
      bundlesAndSnipers: { findings: [], evidence: [], confidence: 0 },
    };

    const result = await aiSynthesisAgent(pumpfunEvent, emptyPartial);

    expect(result.data.missingInformation).toEqual(
      expect.arrayContaining(["token identity", "market price", "safety report", "bundle/sniper evidence", "social links"])
    );
  });
});
