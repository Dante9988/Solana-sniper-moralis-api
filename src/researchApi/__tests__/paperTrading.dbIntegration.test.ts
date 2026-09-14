/**
 * Phase 7D.3.2 §5/§6 — quotes, simulations and paper positions over real HTTP and real
 * PostgreSQL.
 *
 * The quote engine is injected (no RPC here — chain behaviour is covered by the fork suite
 * and the fixture tests). What this proves is everything around it: snapshots are persisted
 * and immutable, unavailable states are sanitized and not persisted, expiry is enforced,
 * paper positions require a real Supabase identity, creation is idempotent, a reused key
 * is refused, and users cannot see each other's positions.
 *
 *   PAPER_RUN_DB_TESTS=true DATABASE_URL=postgresql://... npx vitest run src/researchApi/__tests__/paperTrading.dbIntegration.test.ts
 */

import { PrismaClient } from "@prisma/client";
import express from "express";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadApiConfig } from "../config";
import { buildSupabaseVerifier } from "../middleware/authenticate";
import type { QuoteEngine } from "../quoteEngineProvider";
import { createPaperTradingRouter } from "../routes/paperTrading";
import type { PonsQuote, QuoteOutcome } from "../../pons/quote/quoteService";
import type { SimulationOutcome } from "../../pons/quote/simulationService";
import type { MarketEvidenceOutcome } from "../../pons/quote/marketEvidenceService";

const RUN = process.env.PAPER_RUN_DB_TESTS === "true";

const TOKEN = "0x3bd9136d51af679bd1b11d06b951155543c5449f";
const OTHER_TOKEN = "0x583b10d1912e8d3def8709a6c1cb7ac88fa27fd7";
const SUPABASE_URL = "https://test-project.supabase.co";
const USER_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const USER_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const KID = "paper-test-key";

let privateKey: CryptoKey;
let jwks: { keys: JWK[] };

async function tokenFor(userId: string): Promise<string> {
  return new SignJWT({ email: `${userId}@example.com` })
    .setProtectedHeader({ alg: "ES256", kid: KID })
    .setIssuedAt()
    .setIssuer(`${SUPABASE_URL}/auth/v1`)
    .setAudience("authenticated")
    .setSubject(userId)
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(privateKey);
}

/** Numbers from the fork evidence: SMA 0.01 ETH buy at block 62211539. */
function quote(overrides: Partial<PonsQuote> = {}): PonsQuote {
  const now = Date.now();
  return {
    chain: "robinhood",
    chainId: 4663,
    tokenAddress: TOKEN,
    side: "buy",
    venue: "PONS_V2_UNISWAP_V4",
    method: "V4_QUOTER_ETH_CALL",
    input: { currency: "0x0000000000000000000000000000000000000000", symbol: "ETH", decimals: 18, amount: "10000000000000000" },
    output: {
      currency: TOKEN,
      symbol: "SMA",
      decimals: 18,
      amount: "314124783476025846823395",
      expected: "314124783476025846823395",
      minimum: "310983535641265588355161",
    },
    spent: "10000000000000000",
    refund: "0",
    slippageBps: 100,
    fees: [
      { kind: "HOOK_FEE", bps: 100, currency: TOKEN, chargedOn: "OUTPUT", amount: { min: "3238399829649750998", max: "3238399829649750998", exact: true } },
    ],
    priceImpact: { allInBps: 318, poolOnlyBps: 19, spotOutPerInX36: "32435118231651234567890123000000000000000000" },
    block: { number: "62211539", hash: "0x6554d2c6d1a1b2f99b9782f9d4157c125b6d051129d859df0fdb4395751d4d25", timestamp: "1789328376" },
    quotedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 30_000).toISOString(),
    calculationVersion: "pons-v2-v4quoter-1",
    policyVersion: "quote-policy-1",
    venueState: {
      kind: "pool",
      poolId: "0x" + "11".repeat(32),
      poolKey: { currency0: "0x0000000000000000000000000000000000000000", currency1: TOKEN, fee: 0, tickSpacing: 200, hooks: "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044" },
      sqrtPriceX96: "1",
      tick: 172959,
      activeLiquidityRaw: "29277002188455998248583",
      quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
      quoterGasEstimate: "84044",
    },
    warnings: [],
    limitations: [{ code: "ESTIMATE_NOT_EXECUTION", message: "estimate" }],
    sourceReferences: [],
    ...overrides,
  };
}

function simulated(q: PonsQuote, success = true): SimulationOutcome {
  return {
    status: success ? "SIMULATED" : "REVERTED",
    block: q.block,
    simulatedAt: new Date().toISOString(),
    method: "ETH_CALL_STATE_OVERRIDE",
    route: { kind: "UNIVERSAL_ROUTER", target: "0x8876789976decbfcbbbe364623c63652db8c0904" },
    account: "0x0000000000000000000000000000000051350001",
    simulator: { sourceSha256: "x", runtimeCodeHash: "y" },
    inputBalanceOverride: { currency: q.input.currency, slot: null },
    result: {
      success,
      spent: success ? q.spent : "0",
      received: success ? q.output.expected : "0",
      gasUsed: "135338",
      expectedOut: q.output.expected,
      minimumOut: q.output.minimum,
      matchesQuote: success,
      revert: success ? null : { selector: "0x8b063d73", data: "0x8b063d73", meaning: "V4TooLittleReceived" },
    },
    calculationVersion: "pons-v2-route-sim-1",
    limitations: [],
  };
}

describe.skipIf(!RUN)("paper trading — real Postgres + real HTTP", () => {
  const db = new PrismaClient();
  let nextQuote: () => QuoteOutcome = () => ({ status: "QUOTED", quote: quote() });
  let nextSimulation: (q: PonsQuote) => SimulationOutcome = (q) => simulated(q);
  let nextEvidence: () => MarketEvidenceOutcome = () => ({ status: "UNAVAILABLE", reason: "RPC_UNAVAILABLE", detail: "HTTP 429 https://provider.example/v2/SYNTHETIC_SECRET_KEY" });
  const engine: QuoteEngine = {
    quote: async () => nextQuote(),
    simulate: async (q) => nextSimulation(q),
    marketEvidence: async () => nextEvidence(),
  };

  let app: express.Express;

  beforeAll(async () => {
    const pair = await generateKeyPair("ES256");
    privateKey = pair.privateKey;
    const jwk = await exportJWK(pair.publicKey);
    jwk.kid = KID;
    jwk.alg = "ES256";
    jwks = { keys: [jwk] };

    const config = loadApiConfig({ SUPABASE_URL, API_PUBLIC_READS: "true" } as NodeJS.ProcessEnv);
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as { requestId?: string }).requestId = "test";
      next();
    });
    // The quote limiter is exercised on its own below; here it would only throttle the suite.
    app.use("/api/v1", createPaperTradingRouter(db, config, { supabaseVerifier: buildSupabaseVerifier(config, { jwks }) }, engine, { quoteRequestsPerMinute: 10_000 }));
  });

  async function cleanup() {
    const users = [USER_A, USER_B];
    await db.paperPosition.deleteMany({ where: { userId: { in: users } } });
    // Snapshots are immutable by design; tests bypass the trigger only to clean up.
    await db.$executeRawUnsafe(`ALTER TABLE "EvidenceSnapshot" DISABLE TRIGGER "EvidenceSnapshot_immutable"`);
    try {
      await db.$executeRawUnsafe(`DELETE FROM "EvidenceSnapshot" WHERE "tokenAddress" IN ('${TOKEN}', '${OTHER_TOKEN}') AND "parentId" IS NOT NULL`);
      await db.$executeRawUnsafe(`DELETE FROM "EvidenceSnapshot" WHERE "tokenAddress" IN ('${TOKEN}', '${OTHER_TOKEN}')`);
    } finally {
      await db.$executeRawUnsafe(`ALTER TABLE "EvidenceSnapshot" ENABLE TRIGGER "EvidenceSnapshot_immutable"`);
    }
  }

  beforeEach(async () => {
    nextQuote = () => ({ status: "QUOTED", quote: quote() });
    nextSimulation = (q) => simulated(q);
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await db.$disconnect();
  });

  function postQuote(body: object = { side: "buy", amount: "10000000000000000", slippageBps: 100 }, token = TOKEN) {
    return request(app).post(`/api/v1/tokens/robinhood/${token}/quotes`).send(body);
  }

  // ------------------------------------------------------------------ quotes

  it("persists a quote as an immutable snapshot with block, hash and versions", async () => {
    const res = await postQuote().expect(200);
    expect(res.body.status).toBe("QUOTED");
    expect(res.body.quote.output.expected).toBe("314124783476025846823395");

    const row = await db.evidenceSnapshot.findUniqueOrThrow({ where: { id: res.body.snapshotId } });
    expect(row.kind).toBe("QUOTE");
    expect(row.blockNumber).toBe(62211539n);
    expect(row.blockHash).toBe("0x6554d2c6d1a1b2f99b9782f9d4157c125b6d051129d859df0fdb4395751d4d25");
    expect(row.calculationVersion).toBe("pons-v2-v4quoter-1");
    expect(row.policyVersion).toBe("quote-policy-1");
    expect(row.payloadSha256).toMatch(/^[0-9a-f]{64}$/);

    const evidence = await request(app).get(`/api/v1/evidence/${row.id}`).expect(200);
    expect(evidence.body.block.hash).toBe(row.blockHash);
    expect(evidence.body.payloadSha256).toBe(row.payloadSha256);
  });

  it("rejects UPDATE and DELETE on snapshots at the database", async () => {
    const res = await postQuote().expect(200);
    await expect(db.evidenceSnapshot.update({ where: { id: res.body.snapshotId }, data: { status: "TAMPERED" } })).rejects.toThrow(/immutable/);
    await expect(db.evidenceSnapshot.delete({ where: { id: res.body.snapshotId } })).rejects.toThrow(/immutable/);
  });

  it("persists an unsupported quote with its reason as missing evidence", async () => {
    nextQuote = () => ({
      status: "UNSUPPORTED",
      reason: "GRADUATION_IN_PROGRESS",
      detail: "curve trading has stopped and the V4 pool is not created yet",
      tokenAddress: TOKEN,
      side: "buy",
      block: { number: "1", hash: "0x" + "ab".repeat(32), timestamp: "1" },
      venue: null,
      policyVersion: "quote-policy-1",
    });
    const res = await postQuote().expect(200);
    expect(res.body.status).toBe("UNSUPPORTED");
    expect(res.body.quote).toBeUndefined();
    const row = await db.evidenceSnapshot.findUniqueOrThrow({ where: { id: res.body.snapshotId } });
    expect(row.missingEvidence).toEqual([{ code: "GRADUATION_IN_PROGRESS", detail: expect.any(String) }]);
  });

  it("returns a sanitized, retryable UNAVAILABLE and persists nothing", async () => {
    nextQuote = () => ({ status: "UNAVAILABLE", reason: "RPC_UNAVAILABLE", detail: "HTTP 429 https://provider.example/v2/SYNTHETIC_SECRET_KEY" });
    const before = await db.evidenceSnapshot.count({ where: { tokenAddress: TOKEN } });
    const res = await postQuote().expect(200);
    expect(res.body).toMatchObject({ status: "UNAVAILABLE", reason: "RPC_UNAVAILABLE", retryable: true });
    expect(JSON.stringify(res.body)).not.toMatch(/SYNTHETIC_SECRET_KEY|provider\.example|https?:\/\//);
    expect(await db.evidenceSnapshot.count({ where: { tokenAddress: TOKEN } })).toBe(before);
  });

  it("rate-limits quoting separately, because every quote costs chain reads", async () => {
    const config = loadApiConfig({ SUPABASE_URL, API_PUBLIC_READS: "true" } as NodeJS.ProcessEnv);
    const limited = express();
    limited.use(express.json());
    limited.use((req, _res, next) => {
      (req as { requestId?: string }).requestId = "test";
      next();
    });
    limited.use("/api/v1", createPaperTradingRouter(db, config, { supabaseVerifier: null }, engine, { quoteRequestsPerMinute: 2 }));
    const body = { side: "buy", amount: "10000000000000000", slippageBps: 100 };
    await request(limited).post(`/api/v1/tokens/robinhood/${TOKEN}/quotes`).send(body).expect(200);
    await request(limited).post(`/api/v1/tokens/robinhood/${TOKEN}/quotes`).send(body).expect(200);
    const third = await request(limited).post(`/api/v1/tokens/robinhood/${TOKEN}/quotes`).send(body).expect(429);
    expect(third.body.error.code).toBe("RATE_LIMITED");
  });

  it("validates the quote body", async () => {
    await postQuote({ side: "buy", amount: "1.5", slippageBps: 100 }).expect(400);
    await postQuote({ side: "hold", amount: "1", slippageBps: 100 }).expect(400);
    await postQuote({ side: "buy", amount: "1", slippageBps: 9_000 }).expect(400);
    await postQuote({ side: "buy", amount: "0", slippageBps: 100 }).expect(400);
  });

  it("serves market evidence refusals and outages as results, never leaking provider text", async () => {
    const outage = await request(app).get(`/api/v1/tokens/robinhood/${TOKEN}/market-evidence`).expect(200);
    expect(outage.body).toMatchObject({ status: "UNAVAILABLE", retryable: true });
    expect(JSON.stringify(outage.body)).not.toMatch(/SYNTHETIC_SECRET_KEY|provider\.example|https?:\/\//);

    nextEvidence = () => ({ status: "UNSUPPORTED", reason: "GRADUATION_IN_PROGRESS", detail: "the curve has stopped trading and the V4 pool has not been created yet", block: null });
    const swept = await request(app).get(`/api/v1/tokens/robinhood/${TOKEN}/market-evidence`).expect(200);
    expect(swept.body).toMatchObject({ status: "UNSUPPORTED", reason: "GRADUATION_IN_PROGRESS" });

    await request(app).get(`/api/v1/tokens/robinhood/not-an-address/market-evidence`).expect(400);
  });

  // ------------------------------------------------------------- simulations

  it("links a simulation to its quote and inherits the quote's expiry", async () => {
    const q = await postQuote().expect(200);
    const sim = await request(app).post(`/api/v1/tokens/robinhood/${TOKEN}/simulations`).send({ quoteId: q.body.snapshotId }).expect(200);
    expect(sim.body.status).toBe("SIMULATED");
    expect(sim.body.simulation.result.matchesQuote).toBe(true);
    const row = await db.evidenceSnapshot.findUniqueOrThrow({ where: { id: sim.body.snapshotId } });
    const parent = await db.evidenceSnapshot.findUniqueOrThrow({ where: { id: q.body.snapshotId } });
    expect(row.kind).toBe("SIMULATION");
    expect(row.parentId).toBe(parent.id);
    expect(row.expiresAt?.toISOString()).toBe(parent.expiresAt?.toISOString());
  });

  it("refuses to simulate an expired quote or a quote for a different token", async () => {
    nextQuote = () => ({ status: "QUOTED", quote: quote({ expiresAt: new Date(Date.now() - 1).toISOString() }) });
    const expired = await postQuote().expect(200);
    const res = await request(app).post(`/api/v1/tokens/robinhood/${TOKEN}/simulations`).send({ quoteId: expired.body.snapshotId }).expect(409);
    expect(res.body.error.code).toBe("QUOTE_EXPIRED");

    nextQuote = () => ({ status: "QUOTED", quote: quote() });
    const fresh = await postQuote().expect(200);
    await request(app).post(`/api/v1/tokens/robinhood/${OTHER_TOKEN}/simulations`).send({ quoteId: fresh.body.snapshotId }).expect(404);
  });

  // ---------------------------------------------------------- paper positions

  async function quoteAndSimulate(success = true) {
    nextSimulation = (qq) => simulated(qq, success);
    const q = await postQuote().expect(200);
    const s = await request(app).post(`/api/v1/tokens/robinhood/${TOKEN}/simulations`).send({ quoteId: q.body.snapshotId }).expect(200);
    return { quoteId: q.body.snapshotId as string, simulationId: s.body.snapshotId as string };
  }

  it("requires a Supabase user and an idempotency key", async () => {
    const ids = await quoteAndSimulate();
    await request(app).post("/api/v1/me/paper-positions").send(ids).expect(401);
    await request(app).get("/api/v1/me/paper-positions").expect(401);
    const res = await request(app)
      .post("/api/v1/me/paper-positions")
      .set("Authorization", `Bearer ${await tokenFor(USER_A)}`)
      .send(ids)
      .expect(400);
    expect(res.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("creates once, replays the same row on retry, and restores it with its evidence", async () => {
    const ids = await quoteAndSimulate();
    const auth = `Bearer ${await tokenFor(USER_A)}`;

    const first = await request(app).post("/api/v1/me/paper-positions").set("Authorization", auth).set("Idempotency-Key", "paper-key-0001").send(ids).expect(201);
    expect(first.body.created).toBe(true);
    expect(first.body.position).toMatchObject({ fillBasis: "EXECUTION_SIMULATION", paper: true, side: "buy" });
    expect(first.body.position.output.amount).toBe("314124783476025846823395");

    const [second, third] = await Promise.all([
      request(app).post("/api/v1/me/paper-positions").set("Authorization", auth).set("Idempotency-Key", "paper-key-0001").send(ids),
      request(app).post("/api/v1/me/paper-positions").set("Authorization", auth).set("Idempotency-Key", "paper-key-0001").send(ids),
    ]);
    for (const r of [second, third]) {
      expect(r.status).toBe(200);
      expect(r.body.created).toBe(false);
      expect(r.body.position.id).toBe(first.body.position.id);
    }
    expect(await db.paperPosition.count({ where: { userId: USER_A } })).toBe(1);

    // "Refresh": a fresh list read restores the position and the exact evidence it was based on.
    const list = await request(app).get("/api/v1/me/paper-positions").set("Authorization", auth).expect(200);
    expect(list.body.positions).toHaveLength(1);
    expect(list.body.positions[0].quote.id).toBe(ids.quoteId);
    expect(list.body.positions[0].simulation.id).toBe(ids.simulationId);
    expect(list.body.positions[0].quote.block.hash).toBe("0x6554d2c6d1a1b2f99b9782f9d4157c125b6d051129d859df0fdb4395751d4d25");
  });

  it("refuses to reuse an idempotency key for a different fill", async () => {
    const auth = `Bearer ${await tokenFor(USER_A)}`;
    const a = await quoteAndSimulate();
    const b = await quoteAndSimulate();
    await request(app).post("/api/v1/me/paper-positions").set("Authorization", auth).set("Idempotency-Key", "paper-key-0002").send(a).expect(201);
    const res = await request(app).post("/api/v1/me/paper-positions").set("Authorization", auth).set("Idempotency-Key", "paper-key-0002").send(b).expect(422);
    expect(res.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("refuses expired quotes, mismatched simulations and reverted simulations", async () => {
    const auth = `Bearer ${await tokenFor(USER_A)}`;

    nextQuote = () => ({ status: "QUOTED", quote: quote({ expiresAt: new Date(Date.now() + 400).toISOString() }) });
    const soon = await postQuote().expect(200);
    await new Promise((r) => setTimeout(r, 500));
    const expired = await request(app).post("/api/v1/me/paper-positions").set("Authorization", auth).set("Idempotency-Key", "paper-key-0003").send({ quoteId: soon.body.snapshotId, simulationId: null }).expect(409);
    expect(expired.body.error.code).toBe("QUOTE_EXPIRED");

    nextQuote = () => ({ status: "QUOTED", quote: quote() });
    const a = await quoteAndSimulate();
    const b = await quoteAndSimulate();
    const mismatch = await request(app).post("/api/v1/me/paper-positions").set("Authorization", auth).set("Idempotency-Key", "paper-key-0004").send({ quoteId: a.quoteId, simulationId: b.simulationId }).expect(409);
    expect(mismatch.body.error.code).toBe("SIMULATION_NOT_FOR_QUOTE");

    const reverted = await quoteAndSimulate(false);
    const r = await request(app).post("/api/v1/me/paper-positions").set("Authorization", auth).set("Idempotency-Key", "paper-key-0005").send(reverted).expect(409);
    expect(r.body.error.code).toBe("SIMULATION_NOT_SUCCESSFUL");
  });

  it("never lets one user see or replay another user's paper positions", async () => {
    const ids = await quoteAndSimulate();
    await request(app).post("/api/v1/me/paper-positions").set("Authorization", `Bearer ${await tokenFor(USER_A)}`).set("Idempotency-Key", "shared-key-0001").send(ids).expect(201);

    const listB = await request(app).get("/api/v1/me/paper-positions").set("Authorization", `Bearer ${await tokenFor(USER_B)}`).expect(200);
    expect(listB.body.positions).toHaveLength(0);

    // The same key under another user is that user's own, independent request.
    const b = await request(app).post("/api/v1/me/paper-positions").set("Authorization", `Bearer ${await tokenFor(USER_B)}`).set("Idempotency-Key", "shared-key-0001").send(ids).expect(201);
    expect(b.body.created).toBe(true);
    expect(await db.paperPosition.count({ where: { userId: USER_A } })).toBe(1);
    expect(await db.paperPosition.count({ where: { userId: USER_B } })).toBe(1);
  });

  it("records a quote-based fill as such when no simulation backs it", async () => {
    const q = await postQuote().expect(200);
    const res = await request(app)
      .post("/api/v1/me/paper-positions")
      .set("Authorization", `Bearer ${await tokenFor(USER_A)}`)
      .set("Idempotency-Key", "paper-key-0006")
      .send({ quoteId: q.body.snapshotId, simulationId: null })
      .expect(201);
    expect(res.body.position.fillBasis).toBe("QUOTE");
    expect(res.body.position.simulation).toBeNull();
  });
});
