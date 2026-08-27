import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  requestForensicsExplanation,
  maybeResynthesizeForensicsExplanation,
  FORENSICS_RESYNTHESIS_SCHEMA_VERSION,
  type AnthropicClientLike,
} from "../forensicsAiResynthesis";

const VALID_RESPONSE_TEXT = JSON.stringify({
  narrative: "This token shows concentrated holdings among a cluster of coordinated wallets.",
  riskFactors: ["coordinated wallet cluster"],
  reasons: ["initial bundled acquisition at or above policy threshold"],
  missingInformation: [],
  dataQualityWarnings: [],
  recommendation: "RESEARCH_ONLY",
});

function fakeClient(response: unknown): AnthropicClientLike {
  return { messages: { create: vi.fn(async () => response as never) } };
}

describe("requestForensicsExplanation — deps-injected, never a live call in tests", () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("returns ok:false without constructing a real client when no API key and no injected client are present", async () => {
    const result = await requestForensicsExplanation({ deterministicReport: {}, priorWorkerResults: {} });
    expect(result.ok).toBe(false);
    expect(result.failureReason).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("success path: validates and returns the narrow explanation schema, no eligibility/percentage fields", async () => {
    const client = fakeClient({
      stop_reason: "end_turn",
      content: [{ type: "text", text: VALID_RESPONSE_TEXT }],
    });
    const result = await requestForensicsExplanation({ deterministicReport: { x: 1 }, priorWorkerResults: {} }, { client });
    expect(result.ok).toBe(true);
    expect(result.data?.recommendation).toBe("RESEARCH_ONLY");
    expect(result.data).not.toHaveProperty("eligibility");
    expect(client.messages.create).toHaveBeenCalledTimes(1);
    const callArgs = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.tools).toBeUndefined();
  });

  it("model refusal is treated as a failure, not a crash", async () => {
    const client = fakeClient({
      stop_reason: "refusal",
      stop_details: { explanation: "cannot comply" },
      content: [],
    });
    const result = await requestForensicsExplanation({ deterministicReport: {}, priorWorkerResults: {} }, { client });
    expect(result.ok).toBe(false);
    expect(result.failureReason).toBe("cannot comply");
  });

  it("invalid JSON in the text block fails cleanly", async () => {
    const client = fakeClient({ stop_reason: "end_turn", content: [{ type: "text", text: "not json" }] });
    const result = await requestForensicsExplanation({ deterministicReport: {}, priorWorkerResults: {} }, { client });
    expect(result.ok).toBe(false);
    expect(result.failureReason).toMatch(/invalid JSON/);
  });

  it("a response missing required schema fields fails validation rather than being coerced", async () => {
    const client = fakeClient({
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify({ narrative: "x" }) }],
    });
    const result = await requestForensicsExplanation({ deterministicReport: {}, priorWorkerResults: {} }, { client });
    expect(result.ok).toBe(false);
    expect(result.failureReason).toBe("schema validation failed");
  });

  it("a thrown client error is classified and never propagates", async () => {
    const client: AnthropicClientLike = { messages: { create: vi.fn(async () => { throw new Error("network down"); }) } };
    const result = await requestForensicsExplanation({ deterministicReport: {}, priorWorkerResults: {} }, { client });
    expect(result.ok).toBe(false);
    expect(result.failureReason).toBe("network down");
  });
});

function fakeDb(opts: {
  report?: Record<string, unknown> | null;
  run?: Record<string, unknown> | null;
}) {
  const report = opts.report === undefined
    ? { id: "report-1", forensicsRunId: "run-1", aiSchemaVersion: null, tokenName: "Synth", tokenSymbol: "SYN", marketPrice: null, marketCap: null, safetyMintAuthority: null, safetyFreezeAuthority: null }
    : opts.report;
  const run = opts.run === undefined
    ? { id: "run-1", reportJson: {}, eligibility: { eligibility: "CAUTION" } }
    : opts.run;

  return {
    tokenIntelligenceReport: {
      findUnique: vi.fn(async () => report),
      update: vi.fn(async () => ({})),
    },
    solanaForensicsRun: {
      findUnique: vi.fn(async () => run),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("maybeResynthesizeForensicsExplanation — idempotency and failure isolation", () => {
  it("no-ops when the report no longer exists", async () => {
    const db = fakeDb({ report: null });
    const client = fakeClient({ stop_reason: "end_turn", content: [{ type: "text", text: VALID_RESPONSE_TEXT }] });
    await maybeResynthesizeForensicsExplanation(db, "report-1", "run-1", { client });
    expect(client.messages.create).not.toHaveBeenCalled();
    expect(db.tokenIntelligenceReport.update).not.toHaveBeenCalled();
  });

  it("skips (idempotent) when this exact run was already re-synthesized under the current schema version", async () => {
    const db = fakeDb({ report: { id: "report-1", forensicsRunId: "run-1", aiSchemaVersion: FORENSICS_RESYNTHESIS_SCHEMA_VERSION } });
    const client = fakeClient({ stop_reason: "end_turn", content: [{ type: "text", text: VALID_RESPONSE_TEXT }] });
    await maybeResynthesizeForensicsExplanation(db, "report-1", "run-1", { client });
    expect(client.messages.create).not.toHaveBeenCalled();
    expect(db.tokenIntelligenceReport.update).not.toHaveBeenCalled();
  });

  it("re-synthesizes when the run id differs from the previously re-synthesized run, even under the same schema version", async () => {
    const db = fakeDb({ report: { id: "report-1", forensicsRunId: "run-0", aiSchemaVersion: FORENSICS_RESYNTHESIS_SCHEMA_VERSION } });
    const client = fakeClient({ stop_reason: "end_turn", content: [{ type: "text", text: VALID_RESPONSE_TEXT }] });
    await maybeResynthesizeForensicsExplanation(db, "report-1", "run-1", { client });
    expect(client.messages.create).toHaveBeenCalledTimes(1);
    expect(db.tokenIntelligenceReport.update).toHaveBeenCalledTimes(1);
  });

  it("on success, writes only pre-existing ai* columns — never a forensics* column", async () => {
    const db = fakeDb({});
    const client = fakeClient({ stop_reason: "end_turn", content: [{ type: "text", text: VALID_RESPONSE_TEXT }] });
    await maybeResynthesizeForensicsExplanation(db, "report-1", "run-1", { client });
    const update = db.tokenIntelligenceReport.update.mock.calls[0][0];
    expect(update.where).toEqual({ id: "report-1" });
    for (const key of Object.keys(update.data)) {
      expect(key.startsWith("ai")).toBe(true);
    }
    expect(update.data.aiSchemaVersion).toBe(FORENSICS_RESYNTHESIS_SCHEMA_VERSION);
  });

  it("on failure, never calls update — the completed deterministic report and prior AI assessment are left untouched", async () => {
    const db = fakeDb({});
    const client: AnthropicClientLike = { messages: { create: vi.fn(async () => { throw new Error("rate limited"); }) } };
    await maybeResynthesizeForensicsExplanation(db, "report-1", "run-1", { client });
    expect(db.tokenIntelligenceReport.update).not.toHaveBeenCalled();
  });

  it("no-ops when the run no longer exists", async () => {
    const db = fakeDb({ run: null });
    const client = fakeClient({ stop_reason: "end_turn", content: [{ type: "text", text: VALID_RESPONSE_TEXT }] });
    await maybeResynthesizeForensicsExplanation(db, "report-1", "run-1", { client });
    expect(client.messages.create).not.toHaveBeenCalled();
  });
});

describe("Phase 5E boundary: disabled by default means this module is never reached from reconciliation", () => {
  it("FORENSICS_AI_RESYNTHESIS_ENABLED is unset by default in this test environment", () => {
    expect(process.env.FORENSICS_AI_RESYNTHESIS_ENABLED).toBeUndefined();
  });
});
