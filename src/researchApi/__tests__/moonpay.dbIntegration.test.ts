import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiServer } from "../server";
import { loadApiConfig } from "../config";
import { loadMoonPayConfig } from "../../buying/moonpay/config";
import { MoonPayOrderService } from "../../buying/moonpay/orderService";
import { signWebhookForTest } from "../../buying/moonpay/webhook";
const RUN = process.env.RUN_DB_TESTS === "true";
const SUPABASE_URL = "https://moonpay-test.supabase.co";
const raw = readFileSync("src/buying/__tests__/fixtures/moonpay-completed.json", "utf8");
const input = { baseCurrencyCode: "usd", baseCurrencyAmount: "50", currencyCode: "eth", walletAddress: "0x1111111111111111111111111111111111111111", network: "ethereum-sepolia", idempotencyKey: "checkout-test-key" } as const;
describe.skipIf(!RUN)("MoonPay HTTP + disposable Postgres", () => {
  const db = new PrismaClient();
  let app: ReturnType<typeof createApiServer>;
  let key: CryptoKey;
  let service: MoonPayOrderService;
  const token = (sub = "user-a") => new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: "test" }).setIssuer(`${SUPABASE_URL}/auth/v1`).setSubject(sub).setAudience("authenticated").setIssuedAt().setExpirationTime("1h").sign(key);
  const checkout = async (over = {}, user = "user-a") => request(app).post("/api/v1/moonpay/checkouts").set("Authorization", `Bearer ${await token(user)}`).send({ ...input, ...over });
  const event = (external: string, over = {}, pretty = false) => {
    const body = JSON.parse(raw); body.data = { ...body.data, externalTransactionId: external, ...over };
    return JSON.stringify(body, null, pretty ? 2 : undefined);
  };
  const webhook = (body: string) => request(app).post("/api/v1/moonpay/webhook").set("Content-Type", "application/json").set("Moonpay-Signature-V2", signWebhookForTest(body, "wk_test_fixture", Math.floor(Date.now() / 1000))).send(body);
  beforeAll(async () => {
    vi.stubEnv("MOONPAY_SECRET_KEY", "sk_test_fixture"); vi.stubEnv("MOONPAY_PUBLISHABLE_KEY", "pk_test_fixture"); vi.stubEnv("MOONPAY_WEBHOOK_SECRET", "wk_test_fixture");
    const pair = await generateKeyPair("ES256"); key = pair.privateKey;
    const config = loadApiConfig({ SUPABASE_URL, API_CORS_ORIGINS: "http://localhost:8080" });
    app = createApiServer(db, config, { supabaseVerifierOverrides: { jwks: { keys: [{ ...await exportJWK(pair.publicKey), kid: "test", alg: "ES256" }] } } });
    service = new MoonPayOrderService(db, loadMoonPayConfig()!);
  });
  beforeEach(async () => {
    await db.moonPayWebhookEvent.deleteMany(); await db.moonPayOrder.deleteMany();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("[]")));
  });
  afterAll(async () => { await db.$disconnect(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it("requires auth for checkout, list and read", async () => {
    await request(app).post("/api/v1/moonpay/checkouts").send(input).expect(401);
    await request(app).get("/api/v1/moonpay/orders").expect(401);
    await request(app).get("/api/v1/moonpay/orders/unknown").expect(401);
  });
  it("atomically reuses concurrent checkout requests, with a signed resumable URL", async () => {
    const results = await Promise.all([checkout(), checkout(), checkout()]);
    expect(new Set(results.map((r) => r.body.orderId)).size).toBe(1);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await db.moonPayOrder.count()).toBe(1);
    for (const result of results) { expect(result.body.url).toContain("signature="); expect(result.body.url).toContain("lockAmount=true"); expect(JSON.stringify(result.body)).not.toMatch(/sk_test_fixture|wk_test_fixture/); }
  });
  it("rejects changed intent with the same key and isolates keys between users", async () => {
    const first = await checkout();
    expect((await checkout({ baseCurrencyAmount: "60" })).status).toBe(400);
    const other = await checkout({}, "user-b"); expect(other.status).toBe(201); expect(other.body.orderId).not.toBe(first.body.orderId);
  });
  it("enforces ownership on reads and lists", async () => {
    const result = await checkout();
    await request(app).get(`/api/v1/moonpay/orders/${result.body.orderId}`).set("Authorization", `Bearer ${await token("user-b")}`).expect(404);
    const list = await request(app).get("/api/v1/moonpay/orders").set("Authorization", `Bearer ${await token("user-b")}`).expect(200);
    expect(list.body.orders).toEqual([]);
  });
  it("rejects unsupported network, asset, invalid wallet, zero and redirect origin", async () => {
    for (const over of [{ network: "robinhood" }, { currencyCode: "usdc" }, { walletAddress: "0xwrong" }, { baseCurrencyAmount: "0" }, { redirectUrl: "https://evil.invalid" }]) {
      expect((await checkout(over, "validation-user")).status).toBe(400);
    }
  });
  it("authenticates untouched JSON bytes and persists the event atomically", async () => {
    const result = await checkout({}, "raw-user");
    const body = event(result.body.externalTransactionId, {}, true);
    expect((await webhook(body)).body.applied).toBe(true);
    expect(await db.moonPayWebhookEvent.count()).toBe(1);
    const order = await db.moonPayOrder.findUniqueOrThrow({ where: { id: result.body.orderId } });
    expect(order.status).toBe("COMPLETED"); expect(order.deliveredAmount).toBeNull(); expect(order.quotedAmount).not.toBeNull();
  });
  it("rejects missing signatures and oversized bodies before writes", async () => {
    await request(app).post("/api/v1/moonpay/webhook").send({}).expect(401);
    await request(app).post("/api/v1/moonpay/webhook").set("Content-Type", "application/json").send("x".repeat(66000)).expect(413);
    expect(await db.moonPayWebhookEvent.count()).toBe(0);
  });
  it("deduplicates retries with different JSON whitespace", async () => {
    const result = await checkout({}, "duplicate-user");
    expect((await webhook(event(result.body.externalTransactionId))).body.applied).toBe(true);
    expect((await webhook(event(result.body.externalTransactionId, {}, true))).body.applied).toBe(false);
    expect(await db.moonPayWebhookEvent.count()).toBe(1);
  });
  it("never regresses completion for older failed/cancelled/pending or newer failed events", async () => {
    const result = await checkout({}, "stale-user"); const ext = result.body.externalTransactionId;
    await webhook(event(ext));
    for (const status of ["pending", "failed", "cancelled"]) await webhook(event(ext, { status, updatedAt: "2026-09-19T12:00:00.000Z" }));
    await webhook(event(ext, { status: "failed", updatedAt: "2026-09-21T12:00:00.000Z" }));
    expect((await db.moonPayOrder.findUniqueOrThrow({ where: { id: result.body.orderId } })).status).toBe("COMPLETED");
  });
  it("serializes racing pending/completed events", async () => {
    const result = await checkout({}, "race-user");
    await Promise.all([webhook(event(result.body.externalTransactionId)), webhook(event(result.body.externalTransactionId, { status: "pending", updatedAt: "2026-09-19T12:00:00.000Z" }))]);
    expect((await db.moonPayOrder.findUniqueOrThrow({ where: { id: result.body.orderId } })).status).toBe("COMPLETED");
  });
  it("rejects malformed and mismatched identity fields without changing orders", async () => {
    const result = await checkout({}, "identity-user");
    for (const over of [{ id: null }, { updatedAt: "yesterday" }, { currency: { code: "btc", metadata: { networkCode: "bitcoin" } } }, { currency: { code: "eth", metadata: { networkCode: "robinhood" } } }, { walletAddress: "0x2222222222222222222222222222222222222222" }, { baseCurrencyAmount: 51 }]) {
      expect((await webhook(event(result.body.externalTransactionId, over))).body.applied).toBe(false);
    }
    expect((await db.moonPayOrder.findUniqueOrThrow({ where: { id: result.body.orderId } })).status).toBe("PENDING");
  });
  it("does not reinterpret Solana addresses case-insensitively", async () => {
    const wallet = "So11111111111111111111111111111111111111112";
    const result = await checkout({ currencyCode: "sol", network: "solana-devnet", walletAddress: wallet }, "sol-user");
    expect(result.status).toBe(201);
    expect((await webhook(event(result.body.externalTransactionId, { currency: { code: "sol", metadata: { networkCode: "solana" } }, walletAddress: wallet.toLowerCase() }))).body.applied).toBe(false);
  });
  it("rolls back the event marker when the order update fails so a retry can apply", async () => {
    const result = await checkout({}, "rollback-user");
    const failing = db.$extends({ query: { moonPayOrder: { update: async () => { throw new Error("simulated write failure"); } } } });
    await expect(new MoonPayOrderService(failing as unknown as PrismaClient, loadMoonPayConfig()!).applyWebhook(event(result.body.externalTransactionId), 1700000000)).rejects.toThrow("simulated write failure");
    expect(await db.moonPayWebhookEvent.count()).toBe(0);
    expect((await webhook(event(result.body.externalTransactionId))).body.applied).toBe(true);
  });
  it("recovers missed webhooks using secret auth, with bounded repeat reads", async () => {
    const result = await checkout({}, "recovery-user");
    const data = JSON.parse(event(result.body.externalTransactionId)).data;
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify([data])));
    const order = await db.moonPayOrder.findUniqueOrThrow({ where: { id: result.body.orderId } });
    await service.reconcile(order, fetcher); await service.reconcile(order, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe("Api-Key sk_test_fixture");
    expect((await db.moonPayOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("COMPLETED");
  });
  it("reports ambiguous provider transactions and API outages as uncertainty", async () => {
    const result = await checkout({}, "uncertain-user");
    const data = JSON.parse(event(result.body.externalTransactionId)).data;
    const order = await db.moonPayOrder.findUniqueOrThrow({ where: { id: result.body.orderId } });
    await service.reconcile(order, vi.fn().mockResolvedValue(new Response(JSON.stringify([data, { ...data, id: "other" }]))));
    const after = await db.moonPayOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("PENDING"); expect(after.reconciliationError).toContain("Multiple");
    const read = await request(app).get(`/api/v1/moonpay/orders/${order.id}`).set("Authorization", `Bearer ${await token("uncertain-user")}`).expect(200);
    expect(read.body.status).toBe("UNCERTAIN");
  });
  it("preserves the raw quote exactly, rejects a changed provider identity and environment", async () => {
    const result = await checkout({}, "binding-user");
    const body = raw.replace("checkout-test-1", result.body.externalTransactionId);
    expect((await webhook(body)).body.applied).toBe(true);
    const order = await db.moonPayOrder.findUniqueOrThrow({ where: { id: result.body.orderId } });
    expect(order.quotedAmount).toBe("0.012345678901234567");
    expect(order.deliveredAmount).toBeNull();
    expect((await webhook(event(order.externalTransactionId, { id: "different-provider-id" }))).body.applied).toBe(false);
    await db.moonPayOrder.update({ where: { id: order.id }, data: { environment: "production" } });
    expect((await webhook(event(order.externalTransactionId))).body.applied).toBe(false);
  });
  it("never leaks provider failures and retries transient API errors", async () => {
    const result = await checkout({}, "api-error-user");
    const order = await db.moonPayOrder.findUniqueOrThrow({ where: { id: result.body.orderId } });
    await service.reconcile(order, vi.fn().mockRejectedValue(new Error("sk_test_do-not-leak")));
    const after = await db.moonPayOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.reconciliationError).toBe("Provider lookup unavailable; retrying.");
    await db.moonPayOrder.update({ where: { id: order.id }, data: { lastReconciledAt: new Date(0) } });
    const data = JSON.parse(event(order.externalTransactionId)).data;
    await service.reconcile(order, vi.fn().mockResolvedValue(new Response(JSON.stringify([data]))));
    expect((await db.moonPayOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("COMPLETED");
  });
  it("rate limits checkout creation", async () => {
    const results = [];
    for (let i = 0; i < 11; i++) results.push(await checkout({}, "limited-user"));
    expect(results.at(-1)?.status).toBe(429);
  });
});
