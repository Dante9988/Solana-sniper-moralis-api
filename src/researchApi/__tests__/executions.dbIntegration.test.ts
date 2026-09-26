/**
 * Phase 7E.1 §13/§14/§15 — real execution over real HTTP and real PostgreSQL.
 *
 * The execution engine is injected, so no RPC is touched here; calldata construction is
 * covered by the venue unit tests and the fork suite. What this proves is everything
 * around it, and the parts that only a real database can prove:
 *
 *   - the feature flag refuses before anything is written (§20)
 *   - creation is idempotent, and a reused key for a different trade is refused (§14)
 *   - one transaction hash reconciles to one execution, enforced by a unique index (§14)
 *   - concurrent identical requests produce ONE row, not two
 *   - a reload restores pending state from the database, not from a browser (§15)
 *   - users cannot see each other's trades
 *   - recording a hash does not mark a trade successful (§2)
 *
 * Disposable database only (src/testSupport/disposableDatabaseGuard.ts):
 *   EXECUTIONS_RUN_DB_TESTS=true DATABASE_URL=postgresql://…/ci_7e1_test npx vitest run --no-file-parallelism src/researchApi/__tests__/executions.dbIntegration.test.ts
 */

import { PrismaClient } from "@prisma/client";
import express from "express";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyReceipt, recordMissingReceipt, MAX_RECONCILE_ATTEMPTS } from "../../services/executionService";
import type { BuildOutcome, ExecutionPlan } from "../../pons/execution/venue";
import type { PonsQuote } from "../../pons/quote/quoteService";
import { saveQuoteSnapshot } from "../../services/paperTradingService";
import { loadApiConfig } from "../config";
import type { ExecutionEngine } from "../executionEngineProvider";
import { buildSupabaseVerifier } from "../middleware/authenticate";
import { createExecutionsRouter } from "../routes/executions";

const RUN = process.env.EXECUTIONS_RUN_DB_TESTS === "true";

const TOKEN = "0x3bd9136d51af679bd1b11d06b951155543c5449f";
const CURVE = "0x074995b1c320d5e125b2105c08035f319aa82df8";
const WALLET = "0x1111111111111111111111111111111111111111";
const SUPABASE_URL = "https://test-project.supabase.co";
const USER_A = "aaaaaaaa-0000-4000-8000-0000000007e1";
const USER_B = "bbbbbbbb-0000-4000-8000-0000000007e1";
const KID = "exec-test-key";
const HASH_A = `0x${"a".repeat(64)}`;
const HASH_B = `0x${"b".repeat(64)}`;

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

function quote(overrides: Partial<PonsQuote> = {}): PonsQuote {
  const now = Date.now();
  return {
    chain: "robinhood",
    chainId: 4663,
    tokenAddress: TOKEN,
    side: "buy",
    venue: "PONS_V2_BONDING_CURVE",
    method: "CURVE_FORMULA_AT_PINNED_BLOCK",
    input: { currency: "0x0000000000000000000000000000000000000000", symbol: "ETH", decimals: 18, amount: "10000000000000000" },
    output: { currency: TOKEN, symbol: "SMA", decimals: 18, amount: "5000", expected: "5000", minimum: "4950" },
    spent: "10000000000000000",
    refund: "0",
    slippageBps: 100,
    fees: [],
    priceImpact: { allInBps: 12, poolOnlyBps: null, spotOutPerInX36: "1" },
    block: { number: "62211539", hash: `0x${"c".repeat(64)}`, timestamp: "1790294395" },
    quotedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 30_000).toISOString(),
    calculationVersion: "pons-v2-curve-1",
    policyVersion: "quote-policy-1",
    venueState: { kind: "curve", curve: CURVE, quoteReserve: "1", tokenReserve: "2", sellableTokens: "3", graduationThreshold: "4", trackedQuote: "5" },
    warnings: [],
    limitations: [],
    sourceReferences: [],
    ...overrides,
  } as PonsQuote;
}

function plan(q: PonsQuote, overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    venue: "ROBINHOOD_PONS_CURVE",
    route: { kind: "BONDING_CURVE", target: CURVE },
    chainId: 4663,
    walletAddress: WALLET,
    side: q.side,
    tokenAddress: q.tokenAddress,
    approvals: [],
    swap: { chainId: 4663, to: CURVE, data: "0xdeadbeef", value: q.input.amount, gasLimit: "250000", description: "Buy SMA." },
    poolId: null,
    outputCurrency: q.output.currency,
    hookAddress: null,
    deadline: null,
    expectedOutput: q.output.expected,
    minimumOutput: q.output.minimum,
    quoteBlock: q.block,
    calldataVersion: "pons-v2-execution-1",
    ...overrides,
  };
}

describe.skipIf(!RUN)("real execution — Postgres + HTTP", () => {
  const db = new PrismaClient();
  let nextBuild: (q: PonsQuote, wallet: string) => BuildOutcome = (q, wallet) => ({ status: "BUILT", plan: plan(q, { walletAddress: wallet }) });
  const engine: ExecutionEngine = { buildTransaction: async ({ quote: q, walletAddress }) => nextBuild(q, walletAddress) };

  let app: express.Express;

  beforeAll(async () => {
    // The disposable-database guard runs as vitest globalSetup, keyed off
    // EXECUTIONS_RUN_DB_TESTS; there is nothing to assert here.
    const pair = await generateKeyPair("ES256");
    privateKey = pair.privateKey;
    const jwk = await exportJWK(pair.publicKey);
    jwk.kid = KID;
    jwk.alg = "ES256";
    jwks = { keys: [jwk] };

    const config = loadApiConfig({ SUPABASE_URL, REAL_TRADING_ENABLED: "true" } as NodeJS.ProcessEnv);
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as { requestId?: string }).requestId = "test";
      next();
    });
    app.use("/api/v1", createExecutionsRouter(db, config, { supabaseVerifier: buildSupabaseVerifier(config, { jwks }) }, engine, { requestsPerMinute: 10_000 }));
  });

  async function cleanup() {
    const users = [USER_A, USER_B];
    await db.executionReceipt.deleteMany({ where: { submission: { intent: { userId: { in: users } } } } });
    await db.submittedExecution.deleteMany({ where: { intent: { userId: { in: users } } } });
    await db.executionIntent.deleteMany({ where: { userId: { in: users } } });
    await db.$executeRawUnsafe(`ALTER TABLE "EvidenceSnapshot" DISABLE TRIGGER "EvidenceSnapshot_immutable"`);
    try {
      await db.$executeRawUnsafe(`DELETE FROM "EvidenceSnapshot" WHERE "tokenAddress" = '${TOKEN}' AND "parentId" IS NOT NULL`);
      await db.$executeRawUnsafe(`DELETE FROM "EvidenceSnapshot" WHERE "tokenAddress" = '${TOKEN}'`);
    } finally {
      await db.$executeRawUnsafe(`ALTER TABLE "EvidenceSnapshot" ENABLE TRIGGER "EvidenceSnapshot_immutable"`);
    }
  }

  beforeEach(async () => {
    nextBuild = (q, wallet) => ({ status: "BUILT", plan: plan(q, { walletAddress: wallet }) });
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await db.$disconnect();
  });

  async function storeQuote(q: PonsQuote = quote()): Promise<string> {
    const snapshot = await saveQuoteSnapshot(db, { status: "QUOTED", quote: q }, {
      tokenAddress: q.tokenAddress,
      side: q.side,
      amountIn: q.input.amount,
      slippageBps: q.slippageBps,
    });
    return snapshot.id;
  }

  async function createIntent(options: { user?: string; key?: string; quoteId?: string; wallet?: string } = {}) {
    const quoteId = options.quoteId ?? (await storeQuote());
    return request(app)
      .post("/api/v1/me/executions")
      .set("Authorization", `Bearer ${await tokenFor(options.user ?? USER_A)}`)
      .set("Idempotency-Key", options.key ?? "exec-key-00000001")
      .send({ quoteId, walletAddress: options.wallet ?? WALLET });
  }

  it("requires a signed-in user", async () => {
    const res = await request(app).post("/api/v1/me/executions").set("Idempotency-Key", "exec-key-00000001").send({ quoteId: await storeQuote(), walletAddress: WALLET });
    expect(res.status).toBe(401);
    expect(await db.executionIntent.count()).toBe(0);
  });

  it("requires an Idempotency-Key", async () => {
    const res = await request(app)
      .post("/api/v1/me/executions")
      .set("Authorization", `Bearer ${await tokenFor(USER_A)}`)
      .send({ quoteId: await storeQuote(), walletAddress: WALLET });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("prepares a trade and persists it with the calldata the wallet was given", async () => {
    const res = await createIntent();
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("READY");
    expect(res.body.plan.swap.data).toBe("0xdeadbeef");

    const row = await db.executionIntent.findUniqueOrThrow({ where: { id: res.body.intentId } });
    expect(row.state).toBe("READY_FOR_REVIEW");
    expect(row.calldata).toBe("0xdeadbeef");
    expect(row.minimumOutput.toFixed()).toBe("4950");
    expect(row.walletAddress).toBe(WALLET);
  });

  it("replays the same intent for a repeated Idempotency-Key instead of creating a second trade", async () => {
    const quoteId = await storeQuote();
    const first = await createIntent({ quoteId });
    const second = await createIntent({ quoteId });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.intentId).toBe(first.body.intentId);
    expect(await db.executionIntent.count({ where: { userId: USER_A } })).toBe(1);
  });

  it("creates exactly one row when identical requests race", async () => {
    const quoteId = await storeQuote();
    const results = await Promise.all([createIntent({ quoteId }), createIntent({ quoteId }), createIntent({ quoteId })]);
    const ids = new Set(results.map((r) => r.body.intentId));
    expect(ids.size).toBe(1);
    expect(await db.executionIntent.count({ where: { userId: USER_A } })).toBe(1);
  });

  it("refuses a key reused for a DIFFERENT trade", async () => {
    await createIntent({ key: "exec-key-00000009" });
    const other = await storeQuote(quote({ output: { currency: TOKEN, symbol: "SMA", decimals: 18, amount: "9999", expected: "9999", minimum: "9000" } } as Partial<PonsQuote>));
    const res = await createIntent({ key: "exec-key-00000009", quoteId: other });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("writes nothing at all when real trading is disabled", async () => {
    const config = loadApiConfig({ SUPABASE_URL } as NodeJS.ProcessEnv); // flag absent -> off
    const gated = express();
    gated.use(express.json());
    gated.use((req, _res, next) => {
      (req as { requestId?: string }).requestId = "test";
      next();
    });
    // The real engine, not the stub: the refusal must come from the flag, not the double.
    gated.use("/api/v1", createExecutionsRouter(db, config, { supabaseVerifier: buildSupabaseVerifier(config, { jwks }) }, undefined, { requestsPerMinute: 10_000 }));

    const res = await request(gated)
      .post("/api/v1/me/executions")
      .set("Authorization", `Bearer ${await tokenFor(USER_A)}`)
      .set("Idempotency-Key", "exec-key-00000002")
      .send({ quoteId: await storeQuote(), walletAddress: WALLET });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("REFUSED");
    expect(res.body.reason).toBe("REAL_TRADING_DISABLED");
    expect(await db.executionIntent.count({ where: { userId: USER_A } })).toBe(0);
  });

  it("persists nothing when the engine refuses", async () => {
    nextBuild = () => ({ status: "REFUSED", reason: "QUOTE_EXPIRED", detail: "stale" });
    const res = await createIntent();
    expect(res.body).toMatchObject({ status: "REFUSED", reason: "QUOTE_EXPIRED" });
    expect(await db.executionIntent.count({ where: { userId: USER_A } })).toBe(0);
  });

  describe("submissions", () => {
    async function prepared() {
      const res = await createIntent();
      return res.body.intentId as string;
    }

    async function submit(intentId: string, hash: string, user = USER_A) {
      return request(app)
        .post(`/api/v1/me/executions/${intentId}/submissions`)
        .set("Authorization", `Bearer ${await tokenFor(user)}`)
        .send({ transactionHash: hash });
    }

    it("records the hash and moves to SUBMITTED — not to a success state", async () => {
      const intentId = await prepared();
      const res = await submit(intentId, HASH_A);

      expect(res.status).toBe(201);
      expect(res.body.execution.state).toBe("SUBMITTED");
      // §2: a hash existing is not a result.
      expect(res.body.execution.state).not.toBe("CONFIRMED");
      expect(res.body.execution.submissions[0].receipt).toBeNull();
      expect(res.body.execution.paper).toBe(false);
    });

    it("replays the same submission rather than recording a second one", async () => {
      const intentId = await prepared();
      await submit(intentId, HASH_A);
      const again = await submit(intentId, HASH_A);

      expect(again.status).toBe(200);
      expect(again.body.execution.submissions).toHaveLength(1);
      expect(await db.submittedExecution.count({ where: { intentId } })).toBe(1);
    });

    it("refuses a hash already recorded against another trade", async () => {
      const first = await prepared();
      await submit(first, HASH_A);

      const secondQuote = await storeQuote();
      const second = (await createIntent({ key: "exec-key-00000003", quoteId: secondQuote })).body.intentId as string;
      const res = await submit(second, HASH_A);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("EXECUTION_CONFLICT");
    });

    it("rejects a malformed hash", async () => {
      const intentId = await prepared();
      const res = await submit(intentId, "0x123");
      expect(res.status).toBe(400);
    });

    it("does not let one user submit against another user's trade", async () => {
      const intentId = await prepared();
      const res = await submit(intentId, HASH_B, USER_B);
      expect(res.status).toBe(404);
    });
  });

  describe("reconciliation and reload", () => {
    async function submitted() {
      const intentId = (await createIntent()).body.intentId as string;
      await request(app)
        .post(`/api/v1/me/executions/${intentId}/submissions`)
        .set("Authorization", `Bearer ${await tokenFor(USER_A)}`)
        .send({ transactionHash: HASH_A });
      const submission = await db.submittedExecution.findFirstOrThrow({ where: { intentId } });
      return { intentId, submissionId: submission.id };
    }

    it("restores a pending trade on reload, from the database rather than the browser", async () => {
      const { intentId } = await submitted();
      const res = await request(app).get("/api/v1/me/executions").set("Authorization", `Bearer ${await tokenFor(USER_A)}`);

      expect(res.status).toBe(200);
      const found = res.body.executions.find((e: { id: string }) => e.id === intentId);
      expect(found.state).toBe("SUBMITTED");
      expect(found.stateLabel).toBeTruthy();
      expect(found.submissions[0].transactionHash).toBe(HASH_A);
    });

    it("writes a confirmed receipt and the amounts the chain reported", async () => {
      const { intentId, submissionId } = await submitted();
      const applied = await applyReceipt(db, {
        submissionId,
        reconciled: {
          status: "CONFIRMED",
          blockNumber: "62211600",
          blockHash: `0x${"d".repeat(64)}`,
          gasUsed: "150000",
          effectiveGasPrice: "1000000000",
          actualInput: "9900000000000000",
          grossVenueOutput: "4980",
          netWalletOutput: "4980",
          hookFeeAmount: null,
          matchedWallet: true,
          failureReason: null,
        },
      });
      expect(applied).toMatchObject({ ok: true, state: "CONFIRMED", changed: true });

      const res = await request(app).get(`/api/v1/me/executions/${intentId}`).set("Authorization", `Bearer ${await tokenFor(USER_A)}`);
      expect(res.body.execution.state).toBe("CONFIRMED");
      // The chain's numbers, not the quote's.
      expect(res.body.execution.submissions[0].receipt.netWalletOutput).toBe("4980");
      expect(res.body.execution.expectedOutput).toBe("5000");
    });

    it("is idempotent: re-applying the same receipt does not change state again", async () => {
      const { submissionId } = await submitted();
      const reconciled = {
        status: "CONFIRMED" as const,
        blockNumber: "62211600",
        blockHash: `0x${"d".repeat(64)}`,
        gasUsed: "150000",
        effectiveGasPrice: null,
        actualInput: null,
        grossVenueOutput: null,
        netWalletOutput: null,
        hookFeeAmount: null,
        matchedWallet: false,
        failureReason: null,
      };
      expect(await applyReceipt(db, { submissionId, reconciled })).toMatchObject({ changed: true });
      expect(await applyReceipt(db, { submissionId, reconciled })).toMatchObject({ ok: true, changed: false });
      expect(await db.executionReceipt.count({ where: { submissionId } })).toBe(1);
    });

    it("never overwrites a confirmed trade with a later DROPPED verdict", async () => {
      const { intentId, submissionId } = await submitted();
      await applyReceipt(db, {
        submissionId,
        reconciled: {
          status: "CONFIRMED",
          blockNumber: "62211600",
          blockHash: `0x${"d".repeat(64)}`,
          gasUsed: "150000",
          effectiveGasPrice: null,
          actualInput: null,
          grossVenueOutput: null,
          netWalletOutput: null,
          hookFeeAmount: null,
          matchedWallet: false,
          failureReason: null,
        },
      });
      for (let i = 0; i < MAX_RECONCILE_ATTEMPTS + 2; i += 1) {
        await recordMissingReceipt(db, submissionId);
      }
      const row = await db.executionIntent.findUniqueOrThrow({ where: { id: intentId } });
      expect(row.state).toBe("CONFIRMED");
    });

    it("calls a hash the chain never mined DROPPED, but only after repeated attempts", async () => {
      const { intentId, submissionId } = await submitted();

      expect(await recordMissingReceipt(db, submissionId)).toBe("CONFIRMING");
      const early = await db.executionIntent.findUniqueOrThrow({ where: { id: intentId } });
      expect(early.state).toBe("CONFIRMING");

      for (let i = 1; i < MAX_RECONCILE_ATTEMPTS; i += 1) {
        await recordMissingReceipt(db, submissionId);
      }
      const late = await db.executionIntent.findUniqueOrThrow({ where: { id: intentId } });
      expect(late.state).toBe("DROPPED");
      expect(late.failureReason).toBeTruthy();
    });

    it("records a revert as a failure with its reason", async () => {
      const { intentId, submissionId } = await submitted();
      await applyReceipt(db, {
        submissionId,
        reconciled: {
          status: "REVERTED",
          blockNumber: "62211600",
          blockHash: `0x${"d".repeat(64)}`,
          gasUsed: "150000",
          effectiveGasPrice: null,
          actualInput: null,
          grossVenueOutput: null,
          netWalletOutput: null,
          hookFeeAmount: null,
          matchedWallet: false,
          failureReason: "the transaction reverted on chain",
        },
      });
      const row = await db.executionIntent.findUniqueOrThrow({ where: { id: intentId } });
      expect(row.state).toBe("REVERTED");
      expect(row.failureReason).toBe("the transaction reverted on chain");
    });

    it("keeps users' trades apart", async () => {
      const { intentId } = await submitted();
      const mine = await request(app).get("/api/v1/me/executions").set("Authorization", `Bearer ${await tokenFor(USER_B)}`);
      expect(mine.body.executions).toHaveLength(0);

      const direct = await request(app).get(`/api/v1/me/executions/${intentId}`).set("Authorization", `Bearer ${await tokenFor(USER_B)}`);
      expect(direct.status).toBe(404);
    });
  });

  it("stores no column that could hold a key, seed or signature", async () => {
    const columns = await db.$queryRawUnsafe<{ table_name: string; column_name: string }[]>(
      `select table_name, column_name from information_schema.columns
       where table_name in ('ExecutionIntent','SubmittedExecution','ExecutionReceipt')`
    );
    const suspicious = columns.filter((c) => /priv|secret|seed|mnemonic|signature|signed/i.test(c.column_name));
    expect(suspicious).toEqual([]);
  });
});
