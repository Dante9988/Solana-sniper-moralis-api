/**
 * Phase 7D.4 §7 — vanity handoff over real HTTP, real JWT verification and real Postgres.
 *   PAPER_RUN_DB_TESTS=true DATABASE_URL=postgresql://…/ci_x_test npx vitest run --no-file-parallelism src/researchApi/__tests__/vanityRoutes.dbIntegration.test.ts
 */
import { PrismaClient } from "@prisma/client";
import bs58 from "bs58";
import express from "express";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import request from "supertest";
import nacl from "tweetnacl";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadApiConfig } from "../config";
import { ConsumeVanityResponseSchema, VanityAvailabilityResponseSchema, VanityReservationResponseSchema } from "../contracts/vanity";
import { buildSupabaseVerifier } from "../middleware/authenticate";
import { createVanityRouter } from "../routes/vanity";

const RUN = process.env.PAPER_RUN_DB_TESTS === "true";
const SUPABASE_URL = "https://test-project.supabase.co";
const INTERNAL_KEY = "internal-test-key-7d47-routes";
const USER_A = "aaaaaaaa-7d48-4000-8000-00000000000a";
const USER_B = "bbbbbbbb-7d48-4000-8000-00000000000b";
const SUFFIX = "rte7d48";

describe.skipIf(!RUN)("vanity routes — real HTTP + Postgres", () => {
  const db = new PrismaClient();
  let app: express.Express;
  let privateKey: CryptoKey;
  const token = (sub: string) =>
    new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: "k" }).setIssuedAt().setIssuer(`${SUPABASE_URL}/auth/v1`).setAudience("authenticated").setSubject(sub).setExpirationTime("1h").sign(privateKey);

  beforeAll(async () => {
    const pair = await generateKeyPair("ES256");
    privateKey = pair.privateKey;
    const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "k", alg: "ES256" };
    const config = loadApiConfig({ SUPABASE_URL, API_KEYS: INTERNAL_KEY } as NodeJS.ProcessEnv);
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as { requestId?: string }).requestId = "test";
      next();
    });
    app.use("/api/v1", createVanityRouter(db, config, { supabaseVerifier: buildSupabaseVerifier(config, { jwks: { keys: [jwk] } }) }));
  });
  const cleanup = async () => {
    await db.vanityAddress.deleteMany({ where: { suffix: SUFFIX } });
    await db.vanityAddress.updateMany({ where: { retiredReason: "route test isolation" }, data: { status: "AVAILABLE", retiredReason: null } });
  };
  beforeEach(async () => {
    await cleanup();
    await db.vanityAddress.updateMany({ where: { status: "AVAILABLE" }, data: { status: "RETIRED", retiredReason: "route test isolation" } });
    const address = bs58.encode(nacl.sign.keyPair().publicKey);
    await db.vanityAddress.create({ data: { chain: "solana", address, generationType: "ed25519-keypair-suffix", suffix: SUFFIX, secretRef: `keystore:v1:${address}` } });
  });
  afterAll(async () => {
    await cleanup();
    await db.$disconnect();
  });

  it("publishes availability, and labels Robinhood unsupported", async () => {
    const sol = await request(app).get("/api/v1/vanity/availability?chain=solana").set("Authorization", `Bearer ${await token(USER_A)}`).expect(200);
    expect(VanityAvailabilityResponseSchema.parse(sol.body)).toMatchObject({ supported: true, available: 1, suffix: SUFFIX });
    const rh = await request(app).get("/api/v1/vanity/availability?chain=robinhood").set("Authorization", `Bearer ${await token(USER_A)}`).expect(200);
    expect(rh.body).toMatchObject({ supported: false, available: 0 });
  });

  it("reserves for a signed-in user only, idempotently, and returns no secret material", async () => {
    await request(app).post("/api/v1/me/vanity/reservations").send({ chain: "solana" }).expect(401);
    await request(app).post("/api/v1/me/vanity/reservations").set("Authorization", `Bearer ${INTERNAL_KEY}`).set("Idempotency-Key", "vanity-key-1").send({ chain: "solana" }).expect(401);
    const auth = `Bearer ${await token(USER_A)}`;
    await request(app).post("/api/v1/me/vanity/reservations").set("Authorization", auth).send({ chain: "solana" }).expect(400);
    const first = await request(app).post("/api/v1/me/vanity/reservations").set("Authorization", auth).set("Idempotency-Key", "vanity-key-1").send({ chain: "solana" }).expect(201);
    const again = await request(app).post("/api/v1/me/vanity/reservations").set("Authorization", auth).set("Idempotency-Key", "vanity-key-1").send({ chain: "solana" }).expect(200);
    const body = VanityReservationResponseSchema.parse(first.body);
    expect(again.body.reservation.reservationId).toBe(body.reservation.reservationId);
    expect(body.reservation.deployed).toBe(false);
    expect(JSON.stringify(first.body)).not.toMatch(/keystore|secret|private/i);

    const b = `Bearer ${await token(USER_B)}`;
    await request(app).post("/api/v1/me/vanity/reservations").set("Authorization", b).set("Idempotency-Key", "vanity-key-b").send({ chain: "solana" }).expect(409);
    expect((await request(app).get("/api/v1/me/vanity/reservation?chain=solana").set("Authorization", b).expect(200)).body.reservation).toBeNull();
    await request(app).delete(`/api/v1/me/vanity/reservations/${body.reservation.reservationId}`).set("Authorization", b).expect(404);
    await request(app).post("/api/v1/me/vanity/reservations").set("Authorization", auth).set("Idempotency-Key", "vanity-key-r").send({ chain: "robinhood" }).expect(400);
  });

  it("consumes through the internal key only, idempotently, and a consumed address cannot be released", async () => {
    const auth = `Bearer ${await token(USER_A)}`;
    const r = await request(app).post("/api/v1/me/vanity/reservations").set("Authorization", auth).set("Idempotency-Key", "vanity-key-2").send({ chain: "solana" }).expect(201);
    const id = r.body.reservation.reservationId;
    await request(app).post(`/api/v1/internal/vanity/reservations/${id}/consume`).set("Authorization", auth).set("Idempotency-Key", "consume-key-1").expect(401);
    await request(app).post(`/api/v1/internal/vanity/reservations/${id}/consume`).set("Authorization", `Bearer ${INTERNAL_KEY}`).expect(400);
    const c = await request(app).post(`/api/v1/internal/vanity/reservations/${id}/consume`).set("Authorization", `Bearer ${INTERNAL_KEY}`).set("Idempotency-Key", "consume-key-1").expect(201);
    expect(ConsumeVanityResponseSchema.parse(c.body)).toMatchObject({ reservation: { status: "CONSUMED", deployed: false } });
    await request(app).post(`/api/v1/internal/vanity/reservations/${id}/consume`).set("Authorization", `Bearer ${INTERNAL_KEY}`).set("Idempotency-Key", "consume-key-1").expect(200);
    await request(app).post(`/api/v1/internal/vanity/reservations/${id}/consume`).set("Authorization", `Bearer ${INTERNAL_KEY}`).set("Idempotency-Key", "consume-key-2").expect(409);
    await request(app).delete(`/api/v1/me/vanity/reservations/${id}`).set("Authorization", auth).expect(409);
    const mine = await request(app).get("/api/v1/me/vanity/reservation?chain=solana").set("Authorization", auth).expect(200);
    expect(mine.body.reservation).toMatchObject({ status: "CONSUMED" });
    expect(JSON.stringify(mine.body)).not.toMatch(/keystore/);
  });
});
