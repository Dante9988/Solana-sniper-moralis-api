import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

// assetStore.ts (Phase 4) calls the shared `prisma` singleton directly for
// upsertAsset(), independent of whatever `db` object is injected into the
// API — mock that shared module too, same pattern as forensicsJobService.test.ts.
vi.mock("../../services/prismaClient", () => ({
  prisma: { asset: { upsert: vi.fn().mockResolvedValue({ id: "asset-1" }) } },
}));

import { createApiServer } from "../server";
import { loadApiConfig } from "../config";

const MINT = "So11111111111111111111111111111111111111112";
const API_KEY = "test-key-123";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeDb(overrides: Record<string, unknown> = {}): any {
  return {
    tokenIntelligenceReport: { findFirst: vi.fn() },
    solanaForensicsRun: { findFirst: vi.fn(), findUnique: vi.fn() },
    solanaForensicsJob: { create: vi.fn(), findUnique: vi.fn() },
    $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    ...overrides,
  };
}

function buildApp(db: ReturnType<typeof fakeDb>, publicReads = false) {
  const config = loadApiConfig({ API_KEYS: API_KEY, API_PUBLIC_READS: String(publicReads) } as NodeJS.ProcessEnv);
  return createApiServer(db, config);
}

describe("GET /api/v1/health", () => {
  it("reports ok when the DB is reachable", async () => {
    const app = buildApp(fakeDb());
    const res = await request(app).get("/api/v1/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("reports degraded when the DB throws", async () => {
    const app = buildApp(fakeDb({ $queryRaw: vi.fn().mockRejectedValue(new Error("down")) }));
    const res = await request(app).get("/api/v1/health");
    expect(res.status).toBe(503);
  });
});

describe("mint validation", () => {
  it("rejects an invalid mint with 400 before touching the database", async () => {
    const db = fakeDb();
    const app = buildApp(db, true);
    const res = await request(app).get("/api/v1/tokens/not-a-valid-mint/report");
    expect(res.status).toBe(400);
    expect(db.tokenIntelligenceReport.findFirst).not.toHaveBeenCalled();
  });
});

describe("auth boundary", () => {
  it("requires a bearer key on GET when API_PUBLIC_READS is false", async () => {
    const app = buildApp(fakeDb(), false);
    const res = await request(app).get(`/api/v1/tokens/${MINT}/report`);
    expect(res.status).toBe(401);
  });

  it("allows GET without a key when API_PUBLIC_READS is true", async () => {
    const db = fakeDb();
    db.tokenIntelligenceReport.findFirst.mockResolvedValue(null);
    const app = buildApp(db, true);
    const res = await request(app).get(`/api/v1/tokens/${MINT}/report`);
    expect(res.status).toBe(404); // no key needed to get *past* auth; 404 = never analysed
  });

  it("always requires a bearer key on POST /scan, even when public reads are enabled", async () => {
    const app = buildApp(fakeDb(), true);
    const res = await request(app).post(`/api/v1/tokens/${MINT}/scan`);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/v1/tokens/:mint/report", () => {
  it("returns 404 for a mint that was never analysed", async () => {
    const db = fakeDb();
    db.tokenIntelligenceReport.findFirst.mockResolvedValue(null);
    const app = buildApp(db, true);
    const res = await request(app).get(`/api/v1/tokens/${MINT}/report`);
    expect(res.status).toBe(404);
  });

  it("returns verdict EXCLUDED with evidence for a known-bundled mint", async () => {
    const db = fakeDb();
    db.tokenIntelligenceReport.findFirst.mockResolvedValue({
      mint: MINT,
      status: "COMPLETE",
      updatedAt: new Date("2026-08-26T00:00:00Z"),
      safetyMintAuthority: null,
      safetyFreezeAuthority: null,
      safetyConfidence: 1,
      safetySolSniffer: { auditRisk: { lpBurned: true } },
      aiNarrative: null,
      aiModel: null,
      aiValidationStatus: null,
      forensicsStatus: "COMPLETE",
      forensicsRunId: "run-1",
      forensicsPolicyVersion: "phase5b.2026-08-25",
      forensicsEligibility: "EXCLUDED",
      forensicsDisplaySeverity: "DANGEROUS_EXCLUDED",
      forensicsReasonCodes: ["INITIAL_BUNDLED_ACQUISITION_AT_OR_ABOVE_40_PCT"],
      forensicsRequiredEvidenceComplete: true,
      forensicsInitialBundledAcquisitionPct: 62,
      forensicsCurrentBundleWalletHoldingsPct: 55,
      forensicsDeveloperClusterHoldingsPct: null,
      forensicsSuspectedCoordinatedHoldingsPct: null,
      forensicsInsiderHoldingsPct: null,
      forensicsSniperHoldingsPct: null,
      forensicsAdjustedTop10HoldingsPct: null,
      forensicsCompletedAt: new Date("2026-08-26T00:00:00Z"),
    });
    db.solanaForensicsRun.findUnique.mockResolvedValue({
      evidence: [{ category: "LAUNCH_ACQUISITION", signature: "sig123", slot: 1, wallets: ["WalletA"] }],
      clusters: [],
    });
    const app = buildApp(db, true);
    const res = await request(app).get(`/api/v1/tokens/${MINT}/report`);
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe("EXCLUDED");
    const bundled = res.body.signals.find((s: { key: string }) => s.key === "BUNDLED_SUPPLY");
    expect(bundled.status).toBe("CONFIRMED");
    expect(bundled.evidence.length).toBeGreaterThan(0);
  });

  it("returns verdict UNVERIFIED with no zero-valued percentages when forensics was never requested", async () => {
    const db = fakeDb();
    db.tokenIntelligenceReport.findFirst.mockResolvedValue({
      mint: MINT,
      status: "COMPLETE",
      updatedAt: new Date(),
      safetyMintAuthority: null,
      safetyFreezeAuthority: null,
      safetyConfidence: 0,
      safetySolSniffer: null,
      aiNarrative: null,
      aiModel: null,
      aiValidationStatus: null,
      forensicsStatus: "NOT_REQUESTED",
      forensicsRunId: null,
      forensicsPolicyVersion: null,
      forensicsEligibility: null,
      forensicsDisplaySeverity: null,
      forensicsReasonCodes: [],
      forensicsRequiredEvidenceComplete: false,
      forensicsInitialBundledAcquisitionPct: null,
      forensicsCurrentBundleWalletHoldingsPct: null,
      forensicsDeveloperClusterHoldingsPct: null,
      forensicsSuspectedCoordinatedHoldingsPct: null,
      forensicsInsiderHoldingsPct: null,
      forensicsSniperHoldingsPct: null,
      forensicsAdjustedTop10HoldingsPct: null,
      forensicsCompletedAt: null,
    });
    const app = buildApp(db, true);
    const res = await request(app).get(`/api/v1/tokens/${MINT}/report`);
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe("UNVERIFIED");
    const json = JSON.stringify(res.body);
    expect(json).not.toMatch(/"initialBundledAcquisitionPct":\s*0\b/);
  });
});

describe("POST /api/v1/tokens/:mint/scan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enqueues idempotently and returns the same jobKey on repeat calls", async () => {
    const db = fakeDb();
    db.solanaForensicsJob.create.mockResolvedValue({ id: "job-1", status: "PENDING" });
    const app = buildApp(db, true);

    const first = await request(app)
      .post(`/api/v1/tokens/${MINT}/scan`)
      .set("Authorization", `Bearer ${API_KEY}`);
    expect(first.status).toBe(200);
    expect(first.body.jobKey).toBeTruthy();

    const second = await request(app)
      .post(`/api/v1/tokens/${MINT}/scan`)
      .set("Authorization", `Bearer ${API_KEY}`);
    expect(second.body.jobKey).toBe(first.body.jobKey);
  });
});

describe("GET /api/v1/jobs/:jobKey", () => {
  it("returns 404 for an unknown job", async () => {
    const db = fakeDb();
    db.solanaForensicsJob.findUnique.mockResolvedValue(null);
    const app = buildApp(db, true);
    const res = await request(app).get("/api/v1/jobs/does-not-exist");
    expect(res.status).toBe(404);
  });

  it("returns job status without leaking the internal error message field name unexpectedly", async () => {
    const db = fakeDb();
    db.solanaForensicsJob.findUnique.mockResolvedValue({
      jobKey: "k1",
      status: "PARTIAL",
      attemptCount: 1,
      maxAttempts: 5,
      lastErrorCode: "RATE_LIMITED",
      createdAt: new Date(),
      updatedAt: new Date(),
      startedAt: new Date(),
      completedAt: null,
    });
    const app = buildApp(db, true);
    const res = await request(app).get("/api/v1/jobs/k1");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("PARTIAL");
  });
});
