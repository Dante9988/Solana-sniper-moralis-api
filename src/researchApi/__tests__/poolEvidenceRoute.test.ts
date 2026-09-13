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
  ])("delivers %s as a 200 with a reason, not an HTTP error", async (reason, detail) => {
    const res = await request(
      appWith({ fetch: async () => ({ status: "UNAVAILABLE", reason: reason as any, detail }) })
    )
      .get(`/api/v1/tokens/robinhood/${TOKEN}/pool`)
      .expect(200);

    expect(res.body.status).toBe("UNAVAILABLE");
    expect(res.body.reason).toBe(reason);
    expect(res.body.detail).toBe(detail);
    // No half-populated evidence alongside an unavailable status.
    expect(res.body.evidence).toBeUndefined();
  });

  it("rejects a malformed address before doing any chain work", async () => {
    let called = false;
    await request(appWith({ fetch: async () => { called = true; return realEvidence(); } }))
      .get("/api/v1/tokens/robinhood/not-an-address/pool")
      .expect(400);
    expect(called).toBe(false);
  });
});
