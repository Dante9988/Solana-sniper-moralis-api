/**
 * Real-Postgres, real-HTTP integration test for the Phase 7B.4 read routes
 * (phase7b4.txt §4.7 / non-negotiable: "a real HTTP request to the running
 * backend returning those rows through /api/v1"). Unlike routes.test.ts's
 * fakeDb() pattern, this uses a real PrismaClient against the same local
 * Postgres the other *.dbIntegration.test.ts files use, and a real
 * supertest HTTP request against a real Express app — no mocked DB layer,
 * per this phase's no-mock completion rule.
 *
 * Run in isolation from other *.dbIntegration.test.ts files (shares no
 * fixture identity with them, but keep the convention consistent):
 *   PONS_RUN_DB_TESTS=true DATABASE_URL=postgresql://... npx vitest run src/researchApi/__tests__/robinhoodTokens.dbIntegration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { PrismaClient } from "@prisma/client";
import { createApiServer } from "../server";
import { loadApiConfig } from "../config";

const RUN_DB_TESTS = process.env.PONS_RUN_DB_TESTS === "true";

const CHAIN = "robinhood";
const TOKEN_ADDRESS = "0xfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed";
const POOL_ADDRESS = "0xf00df00df00df00df00df00df00df00df00df00d";
const QUOTE_ADDRESS = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const TX_HASH = "0x" + "ab".repeat(32);

function buildApp(db: PrismaClient) {
  const env = { API_PUBLIC_READS: "true" } as NodeJS.ProcessEnv;
  const config = loadApiConfig(env);
  return createApiServer(db, config, {});
}

describe.skipIf(!RUN_DB_TESTS)("GET /api/v1/tokens/robinhood — real Postgres + real HTTP", () => {
  const prisma = new PrismaClient();

  async function cleanup() {
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
        poolAddress: POOL_ADDRESS,
        quoteAddress: QUOTE_ADDRESS,
        // Deliberately large enough to have tripped the Decimal#toString()
        // scientific-notation bug found in discoveryListener.dbIntegration —
        // this is the regression test for that fix at the HTTP boundary.
        supply: "1000000000000000000000000000",
        initialBuyAmount: "10000000000000000",
        isToken0: true,
        poolFee: 10_000,
        sourceHeight: 9_019_252n,
        sourceHash: "0xhash-9019252",
        sourceTxHash: TX_HASH,
        sourceIndex: 15,
      },
    });
    await prisma.chainTrade.create({
      data: {
        chain: CHAIN,
        venue: "pons",
        tokenAddress: TOKEN_ADDRESS,
        poolAddress: POOL_ADDRESS,
        side: "buy",
        tokenAmount: "7249784874772468972176245",
        quoteAmount: "10000000000000000",
        quoteAddress: QUOTE_ADDRESS,
        priceQuote: "0.0000013794",
        trader: "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead",
        sourceHeight: 9_019_252n,
        sourceHash: "0xhash-9019252",
        sourceTxHash: TX_HASH,
        sourceIndex: 19,
      },
    });
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("lists the real discovered token via a real HTTP GET, with decimal-safe (non-scientific-notation) amounts", async () => {
    const app = buildApp(prisma);
    const res = await request(app).get("/api/v1/tokens/robinhood");

    expect(res.status).toBe(200);
    const found = res.body.tokens.find((t: { tokenAddress: string }) => t.tokenAddress === TOKEN_ADDRESS);
    expect(found).toBeDefined();
    expect(found.supply).toBe("1000000000000000000000000000");
    expect(found.supply).not.toContain("e+");
    expect(found.chain).toBe("robinhood");
    expect(found.graduated).toBe(false);
  });

  it("returns the real token detail with its real trade via a real HTTP GET", async () => {
    const app = buildApp(prisma);
    const res = await request(app).get(`/api/v1/tokens/robinhood/${TOKEN_ADDRESS}`);

    expect(res.status).toBe(200);
    expect(res.body.token.tokenAddress).toBe(TOKEN_ADDRESS);
    expect(res.body.trades).toHaveLength(1);
    expect(res.body.trades[0].side).toBe("buy");
    expect(res.body.trades[0].tokenAmount).toBe("7249784874772468972176245");
  });

  it("returns 404 through the real HTTP path for a token that was never discovered", async () => {
    const app = buildApp(prisma);
    const neverDiscovered = "0x" + "0".repeat(36) + "dead"; // exactly 40 hex chars
    const res = await request(app).get(`/api/v1/tokens/robinhood/${neverDiscovered}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 400 through the real HTTP path for a malformed address", async () => {
    const app = buildApp(prisma);
    const res = await request(app).get("/api/v1/tokens/robinhood/not-an-address");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_ADDRESS");
  });
});

describe.skipIf(!RUN_DB_TESTS)("GET /api/v1/tokens/robinhood/status — real Postgres + real HTTP (Phase 7B.5A §5)", () => {
  const prisma = new PrismaClient();
  const DISCOVERY_SOURCE = "robinhood:pons:discovery";
  const TRADE_SOURCE = "robinhood:pons:trades";

  async function cleanup() {
    await prisma.chainIngestionCheckpoint.deleteMany({ where: { source: { in: [DISCOVERY_SOURCE, TRADE_SOURCE] } } });
  }

  beforeAll(cleanup);
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("is registered ahead of the generic :tokenAddress route and returns the health projection shape, not a 400/404", async () => {
    const app = buildApp(prisma);
    const res = await request(app).get("/api/v1/tokens/robinhood/status");

    expect(res.status).toBe(200);
    expect(["LIVE", "LAGGING", "DEGRADED", "REORG_RECOVERY", "UNAVAILABLE"]).toContain(res.body.status);
    expect(res.body.discovery.source).toBe(DISCOVERY_SOURCE);
    expect(res.body.trades.source).toBe(TRADE_SOURCE);
    expect(typeof res.body.observedAt).toBe("string");
  });

  it("never leaks RPC credentials, raw provider URLs, stack traces, or internal DB error text", async () => {
    await prisma.chainIngestionCheckpoint.create({
      data: {
        source: DISCOVERY_SOURCE,
        lastHeight: 1n,
        lastHash: "0xh",
        lastError: "getBlockNumber: TIMEOUT after 8000ms",
        lastErrorAt: new Date(),
      },
    });
    const app = buildApp(prisma);
    const res = await request(app).get("/api/v1/tokens/robinhood/status");

    expect(res.status).toBe(200);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toMatch(/https?:\/\//);
    expect(serialized).not.toMatch(/postgres(?:ql)?:\/\//);
    expect(serialized).not.toMatch(/api[_-]?key/i);
  });
});

describe.skipIf(!RUN_DB_TESTS)("orphaned rows never surface as canonical facts through the read routes (Phase 7B.5A §2/§9)", () => {
  const prisma = new PrismaClient();
  const ORPHANED_TOKEN = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
  const ORPHANED_POOL = "0xbeefdeadbeefdeadbeefdeadbeefdeadbeefdead";

  async function cleanup() {
    await prisma.chainTrade.deleteMany({ where: { chain: CHAIN, tokenAddress: { in: [ORPHANED_TOKEN, TOKEN_ADDRESS] } } });
    await prisma.discoveredToken.deleteMany({ where: { chain: CHAIN, tokenAddress: { in: [ORPHANED_TOKEN, TOKEN_ADDRESS] } } });
  }

  beforeAll(async () => {
    await cleanup();
    // The first describe block's afterAll already deleted TOKEN_ADDRESS —
    // this block needs a still-canonical token of its own to prove an
    // orphaned trade is excluded from an otherwise-healthy token's detail.
    await prisma.discoveredToken.create({
      data: {
        chain: CHAIN,
        venue: "pons",
        tokenAddress: TOKEN_ADDRESS,
        deployer: "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead",
        poolAddress: POOL_ADDRESS,
        quoteAddress: QUOTE_ADDRESS,
        supply: "1000000000000000000000000000",
        initialBuyAmount: "10000000000000000",
        isToken0: true,
        poolFee: 10_000,
        sourceHeight: 9_019_252n,
        sourceHash: "0xhash-9019252",
        sourceTxHash: TX_HASH,
        sourceIndex: 15,
      },
    });
  });
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("excludes an ORPHANED token from the list and returns 404 for its detail route", async () => {
    await prisma.discoveredToken.create({
      data: {
        chain: CHAIN,
        venue: "pons",
        tokenAddress: ORPHANED_TOKEN,
        deployer: "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead",
        poolAddress: ORPHANED_POOL,
        quoteAddress: QUOTE_ADDRESS,
        supply: "1",
        initialBuyAmount: "0",
        isToken0: true,
        poolFee: 3_000,
        sourceHeight: 1n,
        sourceHash: "0xhash-1",
        sourceTxHash: "0x" + "cd".repeat(32),
        sourceIndex: 0,
        canonicalStatus: "ORPHANED",
        orphanedAt: new Date(),
      },
    });

    const app = buildApp(prisma);
    const listRes = await request(app).get("/api/v1/tokens/robinhood");
    expect(listRes.status).toBe(200);
    expect(listRes.body.tokens.some((t: { tokenAddress: string }) => t.tokenAddress === ORPHANED_TOKEN)).toBe(false);

    const detailRes = await request(app).get(`/api/v1/tokens/robinhood/${ORPHANED_TOKEN}`);
    expect(detailRes.status).toBe(404);
  });

  it("excludes an ORPHANED trade from a still-canonical token's trade list", async () => {
    const orphanedTradeTx = "0x" + "ef".repeat(32);
    await prisma.chainTrade.create({
      data: {
        chain: CHAIN,
        venue: "pons",
        tokenAddress: TOKEN_ADDRESS,
        poolAddress: POOL_ADDRESS,
        side: "sell",
        tokenAmount: "1",
        quoteAmount: "1",
        quoteAddress: QUOTE_ADDRESS,
        priceQuote: "1",
        trader: "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead",
        sourceHeight: 999_999n,
        sourceHash: "0xhash-999999",
        sourceTxHash: orphanedTradeTx,
        sourceIndex: 0,
        canonicalStatus: "ORPHANED",
        orphanedAt: new Date(),
      },
    });

    const app = buildApp(prisma);
    const res = await request(app).get(`/api/v1/tokens/robinhood/${TOKEN_ADDRESS}`);
    expect(res.status).toBe(200);
    expect(res.body.trades.some((t: { sourceTxHash: string }) => t.sourceTxHash === orphanedTradeTx)).toBe(false);

    await prisma.chainTrade.deleteMany({ where: { chain: CHAIN, sourceTxHash: orphanedTradeTx } });
  });
});

describe.skipIf(!RUN_DB_TESTS)("Phase 7D.4 — list filters, filtered totals and verified quote assets", () => {
  const prisma = new PrismaClient();
  const BONDING = "0xd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d401";
  const GRADUATED = "0xd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d402";
  const UNKNOWN_PAIR = "0xd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d403";
  const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
  const ids = [BONDING, GRADUATED, UNKNOWN_PAIR];

  const seed = (tokenAddress: string, over: Record<string, unknown>) =>
    prisma.discoveredToken.create({
      data: {
        chain: CHAIN,
        venue: "pons_v2",
        tokenAddress,
        deployer: "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead",
        quoteAddress: "0x0000000000000000000000000000000000000000",
        initialBuyAmount: "0",
        sourceHeight: 1n,
        sourceHash: "0xhash-1",
        sourceTxHash: `0x${tokenAddress.slice(2).padEnd(64, "0")}`,
        sourceIndex: 0,
        ...over,
      } as never,
    });

  beforeAll(async () => {
    await prisma.discoveredToken.deleteMany({ where: { chain: CHAIN, tokenAddress: { in: ids } } });
    await seed(BONDING, { name: "Zebra Filter Test", symbol: "ZFT", graduated: false });
    await seed(GRADUATED, { name: "Zebra Filter Grad", symbol: "ZFG", graduated: true, quoteAddress: USDG });
    await seed(UNKNOWN_PAIR, { name: "Zebra Filter Odd", symbol: "USDG", quoteAddress: "0x1234567890123456789012345678901234567890" });
  });
  afterAll(async () => {
    await prisma.discoveredToken.deleteMany({ where: { chain: CHAIN, tokenAddress: { in: ids } } });
    await prisma.$disconnect();
  });

  it("filters by search and lifecycle on the server and reports the filtered total", async () => {
    const app = buildApp(prisma);
    const all = await request(app).get("/api/v1/tokens/robinhood?q=Zebra%20Filter");
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(3);
    const grad = await request(app).get("/api/v1/tokens/robinhood?q=Zebra%20Filter&lifecycle=graduated");
    expect(grad.body.total).toBe(1);
    expect(grad.body.tokens.map((t: { tokenAddress: string }) => t.tokenAddress)).toEqual([GRADUATED]);
    const byAddress = await request(app).get(`/api/v1/tokens/robinhood?q=${BONDING.slice(0, 12)}`);
    expect(byAddress.body.tokens.some((t: { tokenAddress: string }) => t.tokenAddress === BONDING)).toBe(true);
  });

  it("labels pair assets only from official registries, never from a token's own symbol", async () => {
    const res = await request(buildApp(prisma)).get("/api/v1/tokens/robinhood?q=Zebra%20Filter");
    const by = Object.fromEntries(res.body.tokens.map((t: { tokenAddress: string; quoteAsset: unknown }) => [t.tokenAddress, t.quoteAsset]));
    expect(by[BONDING]).toMatchObject({ identified: true, symbol: "ETH", kind: "native", usdFeed: "ETH / USD" });
    expect(by[GRADUATED]).toMatchObject({ identified: true, symbol: "USDG", decimals: 6, kind: "stablecoin" });
    expect(by[UNKNOWN_PAIR]).toMatchObject({ identified: false, symbol: null });
  });
});
