import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateCandidateGate } from "../candidateGate";

describe("evaluateCandidateGate — mandatory behavior (phase5e.txt §11)", () => {
  it("EXCLUDED -> BLOCKED", () => {
    const result = evaluateCandidateGate({ eligibility: "EXCLUDED", requiredEvidenceComplete: true });
    expect(result).toMatchObject({ allowed: false, mode: "BLOCKED" });
  });

  it("UNKNOWN -> BLOCKED", () => {
    const result = evaluateCandidateGate({ eligibility: "UNKNOWN", requiredEvidenceComplete: false });
    expect(result).toMatchObject({ allowed: false, mode: "BLOCKED" });
  });

  it("missing assessment -> BLOCKED", () => {
    expect(evaluateCandidateGate(undefined)).toMatchObject({ allowed: false, mode: "BLOCKED" });
    expect(evaluateCandidateGate(null)).toMatchObject({ allowed: false, mode: "BLOCKED" });
    expect(evaluateCandidateGate({})).toMatchObject({ allowed: false, mode: "BLOCKED" });
  });

  it("CAUTION -> HUMAN_REVIEW_ONLY", () => {
    const result = evaluateCandidateGate({ eligibility: "CAUTION", requiredEvidenceComplete: true });
    expect(result).toMatchObject({ allowed: true, mode: "HUMAN_REVIEW_ONLY" });
  });

  it("ELIGIBLE with complete required evidence -> NORMAL", () => {
    const result = evaluateCandidateGate({ eligibility: "ELIGIBLE", requiredEvidenceComplete: true });
    expect(result).toMatchObject({ allowed: true, mode: "NORMAL" });
  });

  it("ELIGIBLE with incomplete required evidence -> BLOCKED", () => {
    const result = evaluateCandidateGate({ eligibility: "ELIGIBLE", requiredEvidenceComplete: false });
    expect(result).toMatchObject({ allowed: false, mode: "BLOCKED" });
  });

  it("is deterministic and imports nothing AI-related", () => {
    const source = readFileSync("src/forensics/candidateGate.ts", "utf8");
    expect(source).not.toMatch(/anthropic/i);
    expect(source).not.toMatch(/from ["'][^"']*ai/i);
  });

  it("is not connected to trading or notifications", () => {
    const source = readFileSync("src/forensics/candidateGate.ts", "utf8");
    expect(source).not.toMatch(/tradingService|sniperooService|discord/i);
  });
});
