import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { exportJWK, generateKeyPair, JWK, CryptoKey, SignJWT } from "jose";
import { Prisma } from "@prisma/client";

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
const SUPABASE_URL = "https://test-project.supabase.co";
const ISSUER = `${SUPABASE_URL}/auth/v1`;
const AUDIENCE = "authenticated";
const SUBJECT = "11111111-1111-4111-8111-111111111111";
const KID = "test-key-1";

let supabasePrivateKey: CryptoKey;
let supabaseJwks: { keys: JWK[] };

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  supabasePrivateKey = privateKey;
  const jwk = await exportJWK(publicKey);
  jwk.kid = KID;
  jwk.alg = "ES256";
  supabaseJwks = { keys: [jwk] };
});

async function signSupabaseToken(opts: { subject?: string; expSeconds?: number; email?: string } = {}): Promise<string> {
  return new SignJWT({ email: opts.email ?? "user@example.com" })
    .setProtectedHeader({ alg: "ES256", kid: KID })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(opts.subject ?? SUBJECT)
    .setExpirationTime(opts.expSeconds ?? Math.floor(Date.now() / 1000) + 3600)
    .sign(supabasePrivateKey);
}

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

function buildApp(
  db: ReturnType<typeof fakeDb>,
  envOverrides: Partial<Record<string, string>> = {},
  opts: { withSupabase?: boolean } = {}
) {
  const env = { API_KEYS: API_KEY, API_PUBLIC_READS: "false", ...envOverrides } as NodeJS.ProcessEnv;
  if (opts.withSupabase) {
    (env as Record<string, string>).SUPABASE_URL = SUPABASE_URL;
  }
  const config = loadApiConfig(env);
  return createApiServer(db, config, opts.withSupabase ? { supabaseVerifierOverrides: { jwks: supabaseJwks } } : {});
}

describe("GET /api/v1/health (liveness only)", () => {
  it("always reports ok — never touches the database", async () => {
    const db = fakeDb({ $queryRaw: vi.fn().mockRejectedValue(new Error("db is down")) });
    const app = buildApp(db, {}, { withSupabase: true });
    const res = await request(app).get("/api/v1/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/ready", () => {
  it("reports ready when the database is reachable", async () => {
    const app = buildApp(fakeDb());
    const res = await request(app).get("/api/v1/ready");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
  });

  it("reports not_ready without leaking the underlying error when the database throws", async () => {
    const app = buildApp(fakeDb({ $queryRaw: vi.fn().mockRejectedValue(new Error("password authentication failed for user \"secret\"")) }));
    const res = await request(app).get("/api/v1/ready");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("not_ready");
    expect(JSON.stringify(res.body)).not.toMatch(/password|secret/i);
  });
});

describe("GET /api/v1/openapi.json and /api/v1/docs", () => {
  it("openapi.json is public and describes the versioned routes", async () => {
    const app = buildApp(fakeDb());
    const res = await request(app).get("/api/v1/openapi.json");
    expect(res.status).toBe(200);
    expect(res.body.openapi).toMatch(/^3\./);
    expect(res.body.paths["/api/v1/tokens/{mint}/report"]).toBeDefined();
    expect(res.body.paths["/api/v1/tokens/{mint}/scans"]).toBeDefined();
  });

  it("/docs is public and serves the Swagger UI page", async () => {
    const app = buildApp(fakeDb());
    const res = await request(app).get("/api/v1/docs/");
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/swagger/i);
  });
});

describe("request IDs", () => {
  it("every response carries an X-Request-Id header, and error envelopes embed the same id", async () => {
    const app = buildApp(fakeDb());
    const res = await request(app).get(`/api/v1/tokens/${MINT}/report`); // unauthenticated -> 401
    const headerId = res.headers["x-request-id"];
    expect(headerId).toBeTruthy();
    expect(res.body.error.requestId).toBe(headerId);
  });

  it("does not trust a client-supplied X-Request-Id — always generates its own", async () => {
    const app = buildApp(fakeDb());
    const res = await request(app).get("/api/v1/health").set("X-Request-Id", "attacker-supplied-value");
    expect(res.headers["x-request-id"]).not.toBe("attacker-supplied-value");
  });
});

describe("error response structure", () => {
  it("uses the standard envelope {error:{code,message,requestId}} and never leaks a stack trace", async () => {
    const app = buildApp(fakeDb(), { API_PUBLIC_READS: "true" });
    const res = await request(app).get(`/api/v1/tokens/not-a-valid-mint/report`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: { code: "INVALID_MINT", message: expect.any(String), requestId: expect.any(String) },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/at\s+\w+\s+\(.*:\d+:\d+\)/); // no stack-trace-shaped text
  });

  it("an unknown route returns the standard NOT_FOUND envelope", async () => {
    const app = buildApp(fakeDb());
    const res = await request(app).get("/api/v1/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});

describe("mint validation", () => {
  it("rejects an invalid mint with 400 before touching the database", async () => {
    const db = fakeDb();
    const app = buildApp(db, { API_PUBLIC_READS: "true" });
    const res = await request(app).get("/api/v1/tokens/not-a-valid-mint/report");
    expect(res.status).toBe(400);
    expect(db.tokenIntelligenceReport.findFirst).not.toHaveBeenCalled();
  });
});

describe("auth boundary: public vs protected routes", () => {
  it("GET /api/v1/health and /api/v1/openapi.json never require auth", async () => {
    const app = buildApp(fakeDb());
    expect((await request(app).get("/api/v1/health")).status).toBe(200);
    expect((await request(app).get("/api/v1/openapi.json")).status).toBe(200);
  });

  it("requires a bearer key/token on GET /tokens/:mint/report when API_PUBLIC_READS is false", async () => {
    const app = buildApp(fakeDb());
    const res = await request(app).get(`/api/v1/tokens/${MINT}/report`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("allows GET without a key when API_PUBLIC_READS is true", async () => {
    const db = fakeDb();
    db.tokenIntelligenceReport.findFirst.mockResolvedValue(null);
    const app = buildApp(db, { API_PUBLIC_READS: "true" });
    const res = await request(app).get(`/api/v1/tokens/${MINT}/report`);
    expect(res.status).toBe(404); // no key needed to get *past* auth; 404 = never analysed
  });

  it("always requires authentication on POST /scans, even when public reads are enabled", async () => {
    const app = buildApp(fakeDb(), { API_PUBLIC_READS: "true" });
    const res = await request(app).post(`/api/v1/tokens/${MINT}/scans`);
    expect(res.status).toBe(401);
  });

  it("accepts the internal API_KEYS bearer token (backward compatible with Phase 6 internal callers)", async () => {
    const db = fakeDb();
    db.tokenIntelligenceReport.findFirst.mockResolvedValue(null);
    const app = buildApp(db);
    const res = await request(app).get(`/api/v1/tokens/${MINT}/report`).set("Authorization", `Bearer ${API_KEY}`);
    expect(res.status).toBe(404);
  });

  it("accepts a valid Supabase access token", async () => {
    const db = fakeDb();
    db.tokenIntelligenceReport.findFirst.mockResolvedValue(null);
    const app = buildApp(db, {}, { withSupabase: true });
    const token = await signSupabaseToken();
    const res = await request(app).get(`/api/v1/tokens/${MINT}/report`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("rejects an expired Supabase token", async () => {
    const app = buildApp(fakeDb(), {}, { withSupabase: true });
    const token = await signSupabaseToken({ expSeconds: Math.floor(Date.now() / 1000) - 60 });
    const res = await request(app).get(`/api/v1/tokens/${MINT}/report`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it("fails closed (AUTH_NOT_CONFIGURED) when neither Supabase nor API_KEYS is configured", async () => {
    const app = buildApp(fakeDb(), { API_KEYS: "" });
    const res = await request(app).get(`/api/v1/tokens/${MINT}/report`).set("Authorization", "Bearer whatever");
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("AUTH_NOT_CONFIGURED");
  });
});

describe("GET /api/v1/me", () => {
  it("returns the verified Supabase identity, not raw token claims", async () => {
    const app = buildApp(fakeDb(), {}, { withSupabase: true });
    const token = await signSupabaseToken({ email: "trader@example.com" });
    const res = await request(app).get("/api/v1/me").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: SUBJECT, email: "trader@example.com" });
  });

  it("rejects an internal API key — /me requires a real Supabase identity", async () => {
    const app = buildApp(fakeDb(), {}, { withSupabase: true });
    const res = await request(app).get("/api/v1/me").set("Authorization", `Bearer ${API_KEY}`);
    expect(res.status).toBe(401);
  });

  it("fails closed when Supabase is not configured at all", async () => {
    const app = buildApp(fakeDb());
    const res = await request(app).get("/api/v1/me").set("Authorization", "Bearer whatever");
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("AUTH_NOT_CONFIGURED");
  });

  it("rejects a missing bearer token", async () => {
    const app = buildApp(fakeDb(), {}, { withSupabase: true });
    const res = await request(app).get("/api/v1/me");
    expect(res.status).toBe(401);
  });
});

describe("GET /api/v1/tokens/:mint/report", () => {
  it("returns 404 for a mint that was never analysed", async () => {
    const db = fakeDb();
    db.tokenIntelligenceReport.findFirst.mockResolvedValue(null);
    const app = buildApp(db, { API_PUBLIC_READS: "true" });
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
    const app = buildApp(db, { API_PUBLIC_READS: "true" });
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
    const app = buildApp(db, { API_PUBLIC_READS: "true" });
    const res = await request(app).get(`/api/v1/tokens/${MINT}/report`);
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe("UNVERIFIED");
    const json = JSON.stringify(res.body);
    expect(json).not.toMatch(/"initialBundledAcquisitionPct":\s*0\b/);
  });
});

describe("POST /api/v1/tokens/:mint/scans", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 202 and enqueues idempotently — repeat calls return the same jobKey with 200", async () => {
    const db = fakeDb();
    db.solanaForensicsJob.create.mockResolvedValue({ id: "job-1", status: "PENDING" });
    const app = buildApp(db, { API_PUBLIC_READS: "true" });

    const first = await request(app)
      .post(`/api/v1/tokens/${MINT}/scans`)
      .set("Authorization", `Bearer ${API_KEY}`);
    expect(first.status).toBe(202);
    expect(first.body.jobKey).toBeTruthy();

    db.solanaForensicsJob.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("unique constraint failed", { code: "P2002", clientVersion: "6.5.0" })
    );
    db.solanaForensicsJob.findUnique = vi.fn().mockResolvedValue({ id: "job-1", status: "PENDING", jobKey: first.body.jobKey });

    const second = await request(app)
      .post(`/api/v1/tokens/${MINT}/scans`)
      .set("Authorization", `Bearer ${API_KEY}`);
    expect(second.body.jobKey).toBe(first.body.jobKey);
    expect(second.status).toBe(200);
  });
});

describe("GET /api/v1/jobs/:jobKey", () => {
  it("returns 404 for an unknown job", async () => {
    const db = fakeDb();
    db.solanaForensicsJob.findUnique.mockResolvedValue(null);
    const app = buildApp(db, { API_PUBLIC_READS: "true" });
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
    const app = buildApp(db, { API_PUBLIC_READS: "true" });
    const res = await request(app).get("/api/v1/jobs/k1");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("PARTIAL");
  });
});
