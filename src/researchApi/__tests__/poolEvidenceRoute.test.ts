import { PrismaClient } from "@prisma/client";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import fixtures from "../../pons/__fixtures__/v4PoolState.json";
import { createRobinhoodTokensRouter } from "../routes/robinhoodTokens";
import { loadApiConfig } from "../config";
import type { PoolEvidenceProvider } from "../poolEvidenceProvider";
import { buildPoolEvidence, buildPoolKey, poolIdFor } from "../../pons/v4PoolState";
import type { PoolEvidenceResult } from "../../pons/v4PoolEvidenceService";

/**
 * Phase 7D.3 §5 — the HTTP contract.
 *
 * The provider is injected, so these tests never touch an RPC. What they assert is the
 * wire shape: decimal strings for values that exceed Number.MAX_SAFE_INTEGER, no USD
 * anywhere, the execution caveat always present, and "no pool" delivered as a 200 with a
 * reason rather than an error status.
 */

const POOL = fixtures.pools[0] as any;

function realEvidence(): PoolEvidenceResult {
  const key = buildPoolKey({
    tokenAddress: POOL.token,
    pairToken: POOL.launch.pairToken,
    poolFee: POOL.launch.poolFee,
    tickSpacing: POOL.launch.tickSpacing,
    hooks: fixtures.memeHook,
  });
  const built = buildPoolEvidence({
    poolKey: key,
    poolId: poolIdFor(key),
    slot0Word: POOL.raw.slot0Word,
    liquidityWord: POOL.raw.liquidityWord,
    creatorTaxBps: POOL.launch.creatorTaxBps,
    observedAtBlock: fixtures.blockNumber,
  });
  if (!built.ok) throw new Error("fixture should build");
  return { status: "AVAILABLE", evidence: built.evidence };
}

function appWith(provider: PoolEvidenceProvider) {
  process.env.API_PUBLIC_READS = "true";
  const app = express();
  app.use((req, _res, next) => {
    (req as any).requestId = "test";
    next();
  });
  app.use(
    "/api/v1/tokens/robinhood",
    createRobinhoodTokensRouter(
      {} as PrismaClient,
      loadApiConfig(),
      {} as any,
      undefined,
      undefined,
      provider
    )
  );
  return app;
}

const TOKEN = POOL.token as string;

describe("GET /api/v1/tokens/robinhood/:tokenAddress/pool", () => {
  it("returns real pool evidence with every large value as a decimal string", async () => {
    const res = await request(appWith({ fetch: async () => realEvidence() }))
      .get(`/api/v1/tokens/robinhood/${TOKEN}/pool`)
      .expect(200);

    expect(res.body.status).toBe("AVAILABLE");
    expect(res.body.apiVersion).toBe(1);

    const e = res.body.evidence;
    expect(e.protocol).toBe("uniswap-v4");
    expect(e.poolId).toBe(POOL.poolId.toLowerCase());

    // The precision rule: these exceed Number.MAX_SAFE_INTEGER.
    for (const field of [e.slot0.sqrtPriceX96, e.liquidity, e.priceC1PerC0X18, e.priceC0PerC1X18]) {
      expect(typeof field).toBe("string");
      expect(BigInt(field)).toBeGreaterThan(0n);
    }
    expect(BigInt(e.slot0.sqrtPriceX96)).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));

    // Small, safely-representable fields stay numbers.
    expect(typeof e.slot0.tick).toBe("number");
    expect(typeof e.lpFeeHundredthsBip).toBe("number");
  });

  it("never emits a USD figure", async () => {
    const res = await request(appWith({ fetch: async () => realEvidence() }))
      .get(`/api/v1/tokens/robinhood/${TOKEN}/pool`)
      .expect(200);

    expect(JSON.stringify(res.body).toLowerCase()).not.toContain("usd");
    expect(res.body.evidence.nativeSymbol).toBe("ETH");
  });

  it("always carries the after-swap caveat, so the UI cannot present this as a quote", async () => {
    const res = await request(appWith({ fetch: async () => realEvidence() }))
      .get(`/api/v1/tokens/robinhood/${TOKEN}/pool`)
      .expect(200);

    expect(res.body.evidence.executionCaveat).toMatch(/not an executable quote/i);
    expect(res.body.evidence.creatorTaxBps).toBe(200);
  });

  it.each([
    ["NOT_GRADUATED", "phase 0"],
    ["RPC_UNAVAILABLE", "connection reset"],
    ["POOL_NOT_INITIALIZED", "slot0 zero"],
    ["UNSUPPORTED_VENUE", "unknown token"],
  ])("delivers %s as a 200 with a reason, not an HTTP error", async (reason, internalDetail) => {
    const res = await request(
      appWith({ fetch: async () => ({ status: "UNAVAILABLE", reason: reason as any, detail: internalDetail }) })
    )
      .get(`/api/v1/tokens/robinhood/${TOKEN}/pool`)
      .expect(200);

    expect(res.body.status).toBe("UNAVAILABLE");
    expect(res.body.reason).toBe(reason);
    // Phase 7D.3.1 §1: the stable code is the contract and the message is ours. The
    // internal diagnostic string is deliberately NOT echoed — it is where provider URLs,
    // keys and calldata leak from.
    expect(res.body.detail).not.toBe(internalDetail);
    expect(typeof res.body.detail).toBe("string");
    expect(res.body.detail.length).toBeGreaterThan(0);
    // No half-populated evidence alongside an unavailable status.
    expect(res.body.evidence).toBeUndefined();
  });

  it("never forwards raw provider text, URLs, calldata or keys to the client", async () => {
    // The shape of a real viem error: URL with the API key, request body, calldata.
    const leaky = [
      "RPC Request failed.",
      "URL: https://robinhood-mainnet.g.alchemy.com/v2/SYNTHETIC_TEST_KEY_NOT_A_REAL_CREDENTIAL",
      'Request body: {"method":"eth_call","params":[{"data":"0xdc4c90d3","to":"0x7eD5"}]}',
      "Details: Monthly capacity limit exceeded.",
    ].join("\n");

    const res = await request(
      appWith({ fetch: async () => ({ status: "UNAVAILABLE", reason: "RPC_UNAVAILABLE", detail: leaky }) })
    )
      .get(`/api/v1/tokens/robinhood/${TOKEN}/pool`)
      .expect(200);

    const body = JSON.stringify(res.body);
    expect(body).not.toContain("SYNTHETIC_TEST_KEY_NOT_A_REAL_CREDENTIAL");
    expect(body).not.toContain("alchemy.com");
    expect(body).not.toContain("0xdc4c90d3");
    expect(body).not.toContain("Request body");
    // The stable code survives; the message is ours, not the provider's.
    expect(res.body.reason).toBe("RPC_UNAVAILABLE");
    expect(res.body.detail).toMatch(/connectivity problem, not a fact about the token/i);
  });

  it("returns a stable message per reason code", async () => {
    for (const [reason, pattern] of [
      ["NOT_GRADUATED", /has not graduated/i],
      ["POOL_NOT_INITIALIZED", /not been initialized/i],
      ["UNSUPPORTED_VENUE", /not launched through a venue/i],
    ] as const) {
      const res = await request(
        appWith({ fetch: async () => ({ status: "UNAVAILABLE", reason: reason as any, detail: "internal noise" }) })
      )
        .get(`/api/v1/tokens/robinhood/${TOKEN}/pool`)
        .expect(200);
      expect(res.body.reason).toBe(reason);
      expect(res.body.detail).toMatch(pattern);
      expect(res.body.detail).not.toContain("internal noise");
    }
  });

  it("rejects a malformed address before doing any chain work", async () => {
    let called = false;
    await request(appWith({ fetch: async () => { called = true; return realEvidence(); } }))
      .get("/api/v1/tokens/robinhood/not-an-address/pool")
      .expect(400);
    expect(called).toBe(false);
  });
});
