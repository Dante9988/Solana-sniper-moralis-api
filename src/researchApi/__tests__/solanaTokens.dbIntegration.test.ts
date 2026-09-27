/**
 * Phase 7E.4.4 — Solana discovery over real HTTP and real Postgres.
 *
 * The Solana token is a real mainnet transaction (the Pump.fun create + dev buy + completion fixture)
 * written through the real ingestion path, `persistPumpfunBatch` — not a hand-inserted row — so what
 * these routes serve is exactly what the worker produces. A Robinhood row sits beside it so the
 * chain-neutral list can be checked for leakage in both directions.
 *
 *   SOLANA_RUN_DB_TESTS=true DATABASE_URL=postgresql://…/ci_… npx vitest run src/researchApi/__tests__/solanaTokens.dbIntegration.test.ts
 */

import fs from "fs";
import path from "path";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { RawTransactionLike } from "../../pump/eventWalker";
import { decodePumpfunTransaction } from "../../solana/pumpfunDecode";
import { persistPumpfunBatch } from "../../solana/pumpfunPersistence";
import { refreshSolanaMarketActivity } from "../../solana/solanaMarketActivity";
import { loadApiConfig } from "../config";
import { createApiServer } from "../server";

const RUN_DB_TESTS = process.env.SOLANA_RUN_DB_TESTS === "true";

const FIXTURES = path.join(__dirname, "../../pump/__tests__/fixtures/mainnet");
const MINT = "bKU4TGmXxaMmcjL2htnSKfRT9Voig9KmPvo8Scupump";
const RH_TOKEN = "0xfeedfeedfeedfeedfeedfeedfeedfeedfeed7e44";
const SLOT = 444127554;

function buildApp(db: PrismaClient) {
  return createApiServer(db, loadApiConfig({ API_PUBLIC_READS: "true" } as NodeJS.ProcessEnv), {});
}

describe.skipIf(!RUN_DB_TESTS)("Solana discovery routes — real Postgres + real HTTP", () => {
  const prisma = new PrismaClient();
  const app = buildApp(prisma);

  async function cleanup() {
    for (const [chain, address] of [["solana", MINT], ["robinhood", RH_TOKEN]] as const) {
      await prisma.chainTrade.deleteMany({ where: { chain, tokenAddress: address } });
      await prisma.discoveredToken.deleteMany({ where: { chain, tokenAddress: address } });
      await prisma.tokenMarketSnapshot.deleteMany({ where: { chain, tokenAddress: address } });
    }
    await prisma.pumpLifecycleEvent.deleteMany({ where: { mint: MINT } });
    await prisma.tokenLifecycleState.deleteMany({ where: { mint: MINT } });
  }

  beforeAll(async () => {
    await cleanup();
    const tx = JSON.parse(fs.readFileSync(path.join(FIXTURES, "pump_create_and_dev_buy_with_completion.json"), "utf8")).result as RawTransactionLike;
    // A recent block time, so the trade falls inside the 1h activity window.
    const blockTime = Math.floor(Date.now() / 1000) - 60;
    const batch = decodePumpfunTransaction({
      tx,
      block: { slot: SLOT, blockhash: "TestBlockhash1111111111111111111111111111111", blockTime },
      observedAt: new Date().toISOString(),
      confidence: "provisional",
      decimals: new Map([[MINT, 6], ["11111111111111111111111111111111", 9]]),
    });
    await persistPumpfunBatch({ db: prisma, batch, source: "live stream" });
    await prisma.discoveredToken.create({
      data: {
        chain: "robinhood", venue: "pons_v2", tokenAddress: RH_TOKEN, deployer: "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead",
        quoteAddress: "0x0bd7d308f8e1639fab988df18a8011f41eacad73", supply: "1000000000000000000000000000", initialBuyAmount: "0",
        sourceHeight: 1n, sourceHash: "0xhash", sourceTxHash: "0x" + "cd".repeat(32), sourceIndex: 1,
        // Older than the Solana row, so "newest first" across chains has a checkable order.
        observedAt: new Date(Date.now() - 3_600_000),
      },
    });
    await refreshSolanaMarketActivity(prisma);
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("serves the Solana token on the Solana route with its mint's case intact, in SOL, with no USD", async () => {
    const res = await request(app).get("/api/v1/tokens/solana").expect(200);
    const row = res.body.tokens.find((t: { tokenAddress: string }) => t.tokenAddress === MINT);
    expect(row).toBeDefined();
    expect(row.chain).toBe("solana");
    expect(row.launchpad).toBe("pumpfun");
    // CompleteEvent in the same transaction: the curve sold out — but no pool is proven yet.
    expect(row.lifecycle.phase).toBe("bonding_complete");
    expect(row.graduated).toBe(false);
    expect(row.quoteAsset.symbol).toBe("SOL");
    expect(row.market.venue).toBe("PUMPFUN_BONDING_CURVE");
    expect(row.market.bondingProgressPct).toBe(100);
    expect(row.market.liquidityQuote).toBe("85.005359057");
    expect(row.market.marketCapUsd).toBeNull();
    expect(row.market.liquidityUsd).toBeNull();
    expect(row.market.trades1h).toBe(1);
    expect(row.market.volume1hQuote).toBe("85.005359057");
    // Age comes from the launch's own block time, not from when OnlyPump indexed it.
    expect(Date.parse(row.launchedAt)).toBeLessThan(Date.now());
    expect(row.launchedAt).not.toBe(row.observedAt);
    expect(res.body.tokens.every((t: { chain: string }) => t.chain === "solana")).toBe(true);
  });

  it("never leaks Solana rows onto the Robinhood route", async () => {
    const res = await request(app).get("/api/v1/tokens/robinhood?limit=100").expect(200);
    expect(res.body.tokens.some((t: { tokenAddress: string }) => t.tokenAddress === MINT)).toBe(false);
    expect(res.body.tokens.every((t: { chain: string }) => t.chain === "robinhood")).toBe(true);
  });

  it("chain=all is both chains in one server-side newest-first order", async () => {
    const res = await request(app).get("/api/v1/tokens?chain=all&limit=100").expect(200);
    expect(res.body.chains).toEqual(["robinhood", "solana"]);
    expect(res.body.excludedChains).toEqual([]);
    const addresses = res.body.tokens.map((t: { tokenAddress: string }) => t.tokenAddress);
    expect(addresses).toContain(MINT);
    expect(addresses).toContain(RH_TOKEN);
    const times = res.body.tokens.map((t: { observedAt: string }) => Date.parse(t.observedAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("says so, instead of mixing, when a request needs USD or Trending", async () => {
    const trending = await request(app).get("/api/v1/tokens?chain=all&lifecycle=trending").expect(200);
    expect(trending.body.chains).toEqual(["robinhood"]);
    expect(trending.body.excludedChains[0].chain).toBe("solana");
    expect(trending.body.trending).toBeDefined();

    const solanaTrending = await request(app).get("/api/v1/tokens?chain=solana&lifecycle=trending").expect(200);
    expect(solanaTrending.body.tokens).toEqual([]);
    expect(solanaTrending.body.trending.available).toBe(false);
    expect(solanaTrending.body.excludedChains[0].reason).toMatch(/Trending/);

    const usd = await request(app).get("/api/v1/tokens?chain=all&fdvMin=1").expect(200);
    expect(usd.body.excludedChains.map((e: { chain: string }) => e.chain)).toEqual(["solana"]);
    expect(usd.body.tokens.some((t: { chain: string }) => t.chain === "solana")).toBe(false);

    // Within Solana alone, a value ordering is SOL against SOL and is allowed.
    const solByCap = await request(app).get("/api/v1/tokens?chain=solana&sort=marketCap").expect(200);
    expect(solByCap.body.excludedChains).toEqual([]);
    expect(solByCap.body.tokens.map((t: { tokenAddress: string }) => t.tokenAddress)).toContain(MINT);
  });

  it("finds a token by its full mint — exactly, and not by a lowercased copy", async () => {
    const hit = await request(app).get(`/api/v1/tokens?chain=all&q=${MINT}`).expect(200);
    expect(hit.body.tokens.map((t: { tokenAddress: string }) => t.tokenAddress)).toEqual([MINT]);
    const miss = await request(app).get(`/api/v1/tokens?chain=all&q=${MINT.toLowerCase()}`).expect(200);
    expect(miss.body.tokens).toEqual([]);
  });

  it("puts a bonding-complete token under Almost bonded, never under Graduated", async () => {
    const almost = await request(app).get("/api/v1/tokens?chain=solana&lifecycle=almost-bonded").expect(200);
    expect(almost.body.tokens.map((t: { tokenAddress: string }) => t.tokenAddress)).toContain(MINT);
    const graduated = await request(app).get("/api/v1/tokens?chain=solana&lifecycle=graduated").expect(200);
    expect(graduated.body.tokens.map((t: { tokenAddress: string }) => t.tokenAddress)).not.toContain(MINT);
  });

  it("serves token detail, terminal market data and candles for the mint", async () => {
    const detail = await request(app).get(`/api/v1/tokens/solana/${MINT}`).expect(200);
    expect(detail.body.token.tokenDecimals).toBe(6);
    expect(detail.body.trades).toHaveLength(1);
    expect(detail.body.trades[0].chain).toBe("solana");

    const market = await request(app).get(`/api/v1/tokens/solana/${MINT}/market`).expect(200);
    expect(market.body.status).toBe("AVAILABLE");
    expect(market.body.market.quoteAsset.symbol).toBe("SOL");
    expect(market.body.market.price.native).not.toBeNull();
    expect(market.body.market.price.usd).toBeNull();
    expect(market.body.market.price.usdUnavailableReason).toMatch(/SOL\/USD/);
    expect(market.body.market.recentTrades[0].tokenAmount).toBe("793100000");
    expect(market.body.market.recentTrades[0].venue).toBe("BONDING_CURVE");
    expect(market.body.market.live.venue).toBe("PUMPFUN_BONDING_CURVE");

    const candles = await request(app).get(`/api/v1/tokens/solana/${MINT}/candles?resolution=1m`).expect(200);
    expect(candles.body.chain).toBe("solana");
    expect(candles.body.tokenAddress).toBe(MINT);
    expect(candles.body.usd.available).toBe(false);
  });

  it("404s a lowercased mint rather than case-folding it onto the real one", async () => {
    const res = await request(app).get(`/api/v1/tokens/solana/${MINT.toLowerCase()}`);
    expect([400, 404]).toContain(res.status);
  });

  it("reports Solana discovery from measured ingestion health", async () => {
    const res = await request(app).get("/api/v1/discovery/chains").expect(200);
    const solana = res.body.chains.find((c: { chain: string }) => c.chain === "solana");
    // No worker has committed in this database, but a token is indexed: DEGRADED, not "live".
    expect(solana.discovery).toBe("DEGRADED");
    expect(solana.providers.find((p: { id: string }) => p.id === "launchlab").status).toBe("IN_DEVELOPMENT");
  });
});
