/**
 * Real-Postgres, real-HTTP integration test for
 * `GET /api/v1/tokens/robinhood/:tokenAddress/candles` (Phase 7B.5B §12).
 * Same real-DB/real-Express/real-supertest convention as
 * robinhoodTokens.dbIntegration.test.ts — no mocked DB layer.
 *
 * Run:
 *   CANDLES_RUN_DB_TESTS=true DATABASE_URL=postgresql://... npx vitest run src/researchApi/__tests__/robinhoodCandles.dbIntegration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { PrismaClient } from "@prisma/client";
import { createApiServer } from "../server";
import { loadApiConfig } from "../config";
import { generateOpenApiDocument } from "../contracts/openapi";

const RUN_DB_TESTS = process.env.CANDLES_RUN_DB_TESTS === "true";

const CHAIN = "robinhood";
const TOKEN_ADDRESS = "0xcafecafecafecafecafecafecafecafecafecafe";
const QUOTE_ADDRESS = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";

function buildApp(db: PrismaClient) {
  const env = { API_PUBLIC_READS: "true" } as NodeJS.ProcessEnv;
  const config = loadApiConfig(env);
  return createApiServer(db, config, {});
}

describe.skipIf(!RUN_DB_TESTS)("GET /api/v1/tokens/robinhood/:tokenAddress/candles — real Postgres + real HTTP", () => {
  const prisma = new PrismaClient();

  async function cleanup() {
    await prisma.marketCandle.deleteMany({ where: { chain: CHAIN, tokenAddress: TOKEN_ADDRESS } });
    await prisma.chainTrade.deleteMany({ where: { chain: CHAIN, tokenAddress: TOKEN_ADDRESS } });
    await prisma.discoveredToken.deleteMany({ where: { chain: CHAIN, tokenAddress: TOKEN_ADDRESS } });
  }

  beforeAll(async () => {
    await cleanup();
    await prisma.discoveredToken.create({
      data: {
        chain: CHAIN,
        venue: "pons",
        tokenAddress: TOKEN_ADDRESS,
        deployer: "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead",
        poolAddress: "0xf00df00df00df00df00df00df00df00df00df00d",
        quoteAddress: QUOTE_ADDRESS,
        supply: "1000000000000000000000000000",
        initialBuyAmount: "10000000000000000",
        isToken0: true,
        poolFee: 10_000,
        sourceHeight: 9_019_252n,
        sourceHash: "0xhash-9019252",
        sourceTxHash: "0x" + "cd".repeat(32),
        sourceIndex: 0,
      },
    });

    const bucketStart = new Date("2026-01-01T00:00:00.000Z");
    await prisma.marketCandle.create({
      data: {
        chain: CHAIN,
        venue: "pons",
        tokenAddress: TOKEN_ADDRESS,
        quoteAddress: QUOTE_ADDRESS,
        resolution: "H1",
        bucketStart,
        // Deliberately a value that would render in scientific notation via
        // Prisma Decimal#toString() (Phase 7B.4 regression) — proves the
        // HTTP layer uses #toFixed() for candle fields too.
        open: "123456789012345678901234.123456789012345678",
        high: "123456789012345678901234.123456789012345678",
        low: "0.000000000000000001",
        close: "1",
        volumeToken: "999999999999999999999999999999999999999999999999999999999999.999999999999999999",
        volumeQuote: "1",
        volumeUsd: null,
        tradeCount: 3,
        uniqueTraders: 2,
        status: "FINAL",
        firstSourceHeight: 9_019_252n,
        lastSourceHeight: 9_019_253n,
        revision: 1,
      },
    });
  });
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("returns real candle history with decimal-safe (non-exponential) serialization", async () => {
    const app = buildApp(prisma);
    const res = await request(app).get(`/api/v1/tokens/robinhood/${TOKEN_ADDRESS}/candles?resolution=1h`);
    expect(res.status).toBe(200);
    expect(res.body.chain).toBe("robinhood");
    expect(res.body.tokenAddress).toBe(TOKEN_ADDRESS);
    expect(res.body.resolution).toBe("1h");
    expect(res.body.candles).toHaveLength(1);
    const candle = res.body.candles[0];
    expect(candle.open).not.toMatch(/e/i);
    expect(candle.open).toBe("123456789012345678901234.123456789012345678");
    expect(candle.volumeToken).not.toMatch(/e/i);
    expect(candle.low).toBe("0.000000000000000001");
    expect(candle.status).toBe("final");
    expect(typeof candle.startTime).toBe("number");
    expect(res.body.pricingBasis.length).toBeGreaterThan(0);
    expect(res.body.uniqueTraderSemantics.length).toBeGreaterThan(0);
    expect(res.body.usd.available).toBe(false);
  });

  it("rejects an invalid resolution with the standard error envelope", async () => {
    const app = buildApp(prisma);
    const res = await request(app).get(`/api/v1/tokens/robinhood/${TOKEN_ADDRESS}/candles?resolution=3m`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("BAD_REQUEST");
    expect(res.body.error.requestId).toBeTruthy();
  });

  it("rejects an invalid time range (from after to)", async () => {
    const app = buildApp(prisma);
    const res = await request(app).get(`/api/v1/tokens/robinhood/${TOKEN_ADDRESS}/candles?resolution=1h&from=2000&to=1000`);
    expect(res.status).toBe(400);
  });

  it("rejects a malformed token address", async () => {
    const app = buildApp(prisma);
    const res = await request(app).get(`/api/v1/tokens/robinhood/not-an-address/candles?resolution=1h`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_ADDRESS");
  });

  it("returns 404 for an undiscovered token", async () => {
    const app = buildApp(prisma);
    const res = await request(app).get(`/api/v1/tokens/robinhood/0x000000000000000000000000000000000000dead/candles?resolution=1h`);
    expect(res.status).toBe(404);
  });

  it("returns an empty, legitimate result for a resolution/time range with genuinely no candles", async () => {
    const app = buildApp(prisma);
    const res = await request(app).get(`/api/v1/tokens/robinhood/${TOKEN_ADDRESS}/candles?resolution=1s`);
    expect(res.status).toBe(200);
    expect(res.body.candles).toEqual([]);
  });

  it("paginates deterministically via cursor, ascending by bucketStart", async () => {
    // Seed two more buckets to exercise pagination.
    await prisma.marketCandle.create({
      data: {
        chain: CHAIN,
        venue: "pons",
        tokenAddress: TOKEN_ADDRESS,
        quoteAddress: QUOTE_ADDRESS,
        resolution: "H1",
        bucketStart: new Date("2026-01-01T01:00:00.000Z"),
        open: "1",
        high: "1",
        low: "1",
        close: "1",
        volumeToken: "1",
        volumeQuote: "1",
        tradeCount: 1,
        uniqueTraders: 1,
        status: "PROVISIONAL",
        firstSourceHeight: 9_019_254n,
        lastSourceHeight: 9_019_254n,
        revision: 1,
      },
    });

    const app = buildApp(prisma);
    const firstPage = await request(app).get(`/api/v1/tokens/robinhood/${TOKEN_ADDRESS}/candles?resolution=1h&limit=1`);
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.candles).toHaveLength(1);
    expect(firstPage.body.nextCursor).not.toBeNull();

    const secondPage = await request(app).get(`/api/v1/tokens/robinhood/${TOKEN_ADDRESS}/candles?resolution=1h&limit=1&cursor=${firstPage.body.nextCursor}`);
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.candles).toHaveLength(1);
    expect(secondPage.body.candles[0].startTime).toBeGreaterThan(firstPage.body.candles[0].startTime);

    await prisma.marketCandle.deleteMany({ where: { chain: CHAIN, tokenAddress: TOKEN_ADDRESS, bucketStart: new Date("2026-01-01T01:00:00.000Z") } });
  });

  it("is documented in the shared OpenAPI generator", () => {
    const doc = generateOpenApiDocument();
    expect(doc.paths?.["/api/v1/tokens/robinhood/{tokenAddress}/candles"]).toBeTruthy();
  });
});
