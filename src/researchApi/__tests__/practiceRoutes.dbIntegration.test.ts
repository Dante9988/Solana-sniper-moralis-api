/**
 * Phase 7D.4 §5 — Practice over real HTTP, real JWT verification and real Postgres.
 *   PAPER_RUN_DB_TESTS=true DATABASE_URL=postgresql://…/ci_x_test npx vitest run --no-file-parallelism src/researchApi/__tests__/practiceRoutes.dbIntegration.test.ts
 */
import { PrismaClient } from "@prisma/client";
import express from "express";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadApiConfig } from "../config";
import { PracticeOverviewResponseSchema, PracticePortfolioResponseSchema } from "../contracts/practice";
import { buildSupabaseVerifier } from "../middleware/authenticate";
import { createPracticeRouter } from "../routes/practice";

const RUN = process.env.PAPER_RUN_DB_TESTS === "true";
const SUPABASE_URL = "https://test-project.supabase.co";
const USER_A = "aaaaaaaa-7d41-4000-8000-00000000000a";
const USER_B = "bbbbbbbb-7d41-4000-8000-00000000000b";
const ETH = "0x0000000000000000000000000000000000000000";

describe.skipIf(!RUN)("practice routes — real HTTP + Postgres", () => {
  const db = new PrismaClient();
  let app: express.Express;
  let privateKey: CryptoKey;
  const token = (sub: string) =>
    new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: "k" }).setIssuedAt().setIssuer(`${SUPABASE_URL}/auth/v1`).setAudience("authenticated").setSubject(sub).setExpirationTime("1h").sign(privateKey);

  beforeAll(async () => {
    const pair = await generateKeyPair("ES256");
    privateKey = pair.privateKey;
    const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "k", alg: "ES256" };
    const config = loadApiConfig({ SUPABASE_URL } as NodeJS.ProcessEnv);
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as { requestId?: string }).requestId = "test";
      next();
    });
    app.use("/api/v1", createPracticeRouter(db, config, { supabaseVerifier: buildSupabaseVerifier(config, { jwks: { keys: [jwk] } }) }));
  });
  const cleanup = async () => {
    await db.practicePortfolio.deleteMany({ where: { userId: { in: [USER_A, USER_B] } } });
    await db.practiceAchievement.deleteMany({ where: { userId: { in: [USER_A, USER_B] } } });
  };
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await db.$disconnect();
  });

  it("requires a signed-in user and an Idempotency-Key", async () => {
    await request(app).get("/api/v1/me/practice").expect(401);
    await request(app).post("/api/v1/me/practice/portfolios").set("Authorization", `Bearer ${await token(USER_A)}`).send({ name: "x", balances: [{ currency: ETH, amount: "1" }] }).expect(400);
  });

  it("creates a portfolio, returns the published shape, and never shows it to another user", async () => {
    const created = await request(app)
      .post("/api/v1/me/practice/portfolios")
      .set("Authorization", `Bearer ${await token(USER_A)}`)
      .set("Idempotency-Key", "portfolio-key-0001")
      .send({ name: "Learning", balances: [{ currency: ETH, amount: "1000000000000000000" }] })
      .expect(201);
    expect(PracticePortfolioResponseSchema.safeParse(created.body).success).toBe(true);
    const id = created.body.portfolio.id;

    const replay = await request(app)
      .post("/api/v1/me/practice/portfolios")
      .set("Authorization", `Bearer ${await token(USER_A)}`)
      .set("Idempotency-Key", "portfolio-key-0001")
      .send({ name: "Learning", balances: [{ currency: ETH, amount: "1000000000000000000" }] })
      .expect(200);
    expect(replay.body.portfolio.id).toBe(id);

    const overview = await request(app).get("/api/v1/me/practice").set("Authorization", `Bearer ${await token(USER_A)}`).expect(200);
    expect(PracticeOverviewResponseSchema.safeParse(overview.body).success).toBe(true);
    expect(overview.body.portfolios.map((p: { id: string }) => p.id)).toEqual([id]);

    const asB = await request(app).get("/api/v1/me/practice").set("Authorization", `Bearer ${await token(USER_B)}`).expect(200);
    expect(asB.body.portfolios).toEqual([]);
    await request(app).get(`/api/v1/me/practice/portfolios/${id}`).set("Authorization", `Bearer ${await token(USER_B)}`).expect(404);
  });

  it("refuses marking a do-it step as done by request", async () => {
    await request(app).post("/api/v1/me/practice/lesson/steps").set("Authorization", `Bearer ${await token(USER_A)}`).send({ step: "place-trade" }).expect(400);
    const ok = await request(app).post("/api/v1/me/practice/lesson/steps").set("Authorization", `Bearer ${await token(USER_A)}`).send({ step: "track" }).expect(200);
    expect(ok.body.lesson.steps.find((s: { id: string }) => s.id === "track").done).toBe(true);
    await db.practiceLessonProgress.deleteMany({ where: { userId: USER_A } });
  });
});
