/**
 * Phase 7E.4 §5/§6/§9 — Trending over the real route and real PostgreSQL.
 *
 * Two properties are pinned here that unit tests cannot reach:
 *
 *   §9  the screener filters and the ranking happen in ONE statement, so ranking is always
 *       inside the filtered universe. The anti-pattern — rank the world, then filter — would
 *       silently return fewer than `limit` rows, or the wrong rows entirely, and this proves
 *       it is not happening.
 *   §3  a shell cannot reach default Trending however busy it looks, because only ELIGIBLE
 *       tokens carry a score.
 *
 *   EXECUTIONS_RUN_DB_TESTS=true DATABASE_URL=postgresql://…/ci_7e1_test npx vitest run --no-file-parallelism src/researchApi/__tests__/trendingRoute.dbIntegration.test.ts
 */

import { PrismaClient } from "@prisma/client";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadApiConfig } from "../config";
import { createRobinhoodTokensRouter } from "../routes/robinhoodTokens";

const RUN = process.env.EXECUTIONS_RUN_DB_TESTS === "true";
const CHAIN = "robinhood";
const PREFIX = "0x7e4";

/** Each fixture is a token plus the snapshot that decides whether it may be promoted. */
interface Fixture {
  suffix: string;
  symbol: string;
  valuation: number;
  liquidity: number;
  score: number | null;
  classification: string;
  reasons?: string[];
}

const FIXTURES: Fixture[] = [
  // Genuinely active and liquid — these are the ones Trending is for.
  { suffix: "a1", symbol: "BIGCAP", valuation: 2_000_000, liquidity: 400_000, score: 0.9, classification: "ELIGIBLE" },
  { suffix: "a2", symbol: "MIDCAP", valuation: 450_000, liquidity: 75_000, score: 0.6, classification: "ELIGIBLE" },
  { suffix: "a3", symbol: "SMALLCAP", valuation: 40_000, liquidity: 12_000, score: 0.3, classification: "ELIGIBLE" },
  // The chain's median token: a valuation with a rounding error of liquidity behind it.
  { suffix: "b1", symbol: "SHELL", valuation: 4_500, liquidity: 7, score: null, classification: "HIGH_RISK", reasons: ["LIQUIDITY_RATIO_SEVERE"] },
  // Tradable but below a promotion bar.
  { suffix: "b2", symbol: "THIN", valuation: 9_000, liquidity: 3_000, score: null, classification: "CAUTION", reasons: ["VALUATION_BELOW_FLOOR"] },
];

const address = (suffix: string) => `${PREFIX}${suffix}`.padEnd(42, "0");

describe.skipIf(!RUN)("Trending route — real PostgreSQL", () => {
  const db = new PrismaClient();
  let app: express.Express;

  beforeAll(() => {
    const config = loadApiConfig({ API_PUBLIC_READS: "true" } as NodeJS.ProcessEnv);
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as { requestId?: string }).requestId = "test";
      next();
    });
    app.use("/api/v1/tokens/robinhood", createRobinhoodTokensRouter(db, config, { supabaseVerifier: null }));
  });

  async function cleanup() {
    await db.tokenMarketSnapshot.deleteMany({ where: { tokenAddress: { startsWith: PREFIX } } });
    await db.discoveredToken.deleteMany({ where: { tokenAddress: { startsWith: PREFIX } } });
  }

  beforeEach(async () => {
    await cleanup();
    const now = new Date();
    for (const f of FIXTURES) {
      const tokenAddress = address(f.suffix);
      await db.discoveredToken.create({
        data: {
          chain: CHAIN, venue: "pons_v2", tokenAddress, deployer: address("dep"), quoteAddress: "0x" + "0".repeat(40),
          symbol: f.symbol, name: f.symbol, initialBuyAmount: "0", canonicalStatus: "CANONICAL", graduated: true,
          tokenDecimals: 18, quoteDecimals: 18,
          sourceHeight: 1n, sourceHash: `0x${"1".repeat(64)}`, sourceTxHash: `0x${"2".repeat(64)}`, sourceIndex: 0,
        },
      });
      await db.tokenMarketSnapshot.create({
        data: {
          chain: CHAIN, tokenAddress, venue: "pons_v2", status: "OK",
          blockNumber: 1n, blockTimestamp: now, quoteAddress: "0x" + "0".repeat(40), quoteDecimals: 18, tokenDecimals: 18,
          marketCapUsd: String(f.valuation), liquidityUsd: String(f.liquidity),
          trendingScore: f.score === null ? null : String(f.score),
          riskClassification: f.classification, riskReasons: f.reasons ?? [],
          liquidityRatioBps: Math.round((f.liquidity / f.valuation) * 10_000),
          valuationBasis: "FDV",
          trendingComputedAt: now, volume1hUsd: String(f.valuation / 10), trades1h: 50, traders1h: 20,
        },
      });
    }
  });

  afterAll(async () => {
    await cleanup();
    await db.$disconnect();
  });

  const symbolsOf = (body: { tokens?: { symbol: string | null }[] }) => (body.tokens ?? []).map((t) => t.symbol);

  it("promotes only ELIGIBLE tokens, ranked by score", async () => {
    const res = await request(app).get("/api/v1/tokens/robinhood?lifecycle=trending&limit=20");
    expect(res.status).toBe(200);
    expect(symbolsOf(res.body)).toEqual(["BIGCAP", "MIDCAP", "SMALLCAP"]);
  });

  it("keeps a $4.5K shell with $7 of liquidity out, however it is sorted", async () => {
    for (const query of ["lifecycle=trending", "lifecycle=trending&sort=trending", "sort=trending"]) {
      const res = await request(app).get(`/api/v1/tokens/robinhood?${query}&limit=20`);
      expect(symbolsOf(res.body), query).not.toContain("SHELL");
      expect(symbolsOf(res.body), query).not.toContain("THIN");
    }
  });

  it("returns the evidence behind a classification rather than a safe flag", async () => {
    const res = await request(app).get("/api/v1/tokens/robinhood?limit=50");
    const shell = (res.body.tokens ?? []).find((t: { symbol: string }) => t.symbol === "SHELL");
    expect(shell).toBeTruthy();
    // The snapshot-derived fields live on `market`, alongside the numbers they qualify.
    expect(shell.market.riskClassification).toBe("HIGH_RISK");
    expect(shell.market.riskReasons).toContain("LIQUIDITY_RATIO_SEVERE");
    // $7 against a $4,500 valuation is 15.56 bps, rounded.
    expect(shell.market.liquidityRatioBps).toBe(16);
    // FDV, because only total supply is known on this chain.
    expect(shell.market.valuationBasis).toBe("FDV");
    expect(shell.market).not.toHaveProperty("safe");
  });

  // --- §9: filters constrain the universe BEFORE ranking -------------------------------

  it("ranks inside the filtered universe, not the global one", async () => {
    // BIGCAP outranks everything. Filtering it out must promote MIDCAP to first place —
    // not return an empty first page because the global winner was removed afterwards.
    const res = await request(app).get("/api/v1/tokens/robinhood?lifecycle=trending&fdvMax=500000&limit=20");
    expect(symbolsOf(res.body)).toEqual(["MIDCAP", "SMALLCAP"]);
  });

  it("applies a liquidity filter before ranking", async () => {
    const res = await request(app).get("/api/v1/tokens/robinhood?lifecycle=trending&liquidityMin=50000&limit=20");
    expect(symbolsOf(res.body)).toEqual(["BIGCAP", "MIDCAP"]);
  });

  it("returns a full page of the filtered set rather than a filtered page of the global set", async () => {
    // With limit=2 over a filtered universe of 2, both must come back. If the route ranked
    // globally and filtered after, BIGCAP would consume a slot and only MIDCAP would remain.
    const res = await request(app).get("/api/v1/tokens/robinhood?lifecycle=trending&fdvMax=500000&limit=2");
    expect(symbolsOf(res.body)).toEqual(["MIDCAP", "SMALLCAP"]);
  });

  it("intersects several filters before ranking", async () => {
    const res = await request(app).get("/api/v1/tokens/robinhood?lifecycle=trending&fdvMin=30000&fdvMax=500000&liquidityMin=10000&limit=20");
    expect(symbolsOf(res.body)).toEqual(["MIDCAP", "SMALLCAP"]);
  });

  it("reports an empty filtered universe as empty, not as the global ranking", async () => {
    const res = await request(app).get("/api/v1/tokens/robinhood?lifecycle=trending&liquidityMin=99999999&limit=20");
    expect(symbolsOf(res.body)).toEqual([]);
  });

  it("drops a token out of Trending as soon as it loses its score", async () => {
    await db.tokenMarketSnapshot.updateMany({ where: { tokenAddress: address("a1") }, data: { trendingScore: null } });
    const res = await request(app).get("/api/v1/tokens/robinhood?lifecycle=trending&limit=20");
    // §11 — a historic winner cannot stay pinned once it stops scoring.
    expect(symbolsOf(res.body)).toEqual(["MIDCAP", "SMALLCAP"]);
  });

  it("drops a token that is no longer ELIGIBLE even if its score survives", async () => {
    await db.tokenMarketSnapshot.updateMany({
      where: { tokenAddress: address("a1") },
      data: { riskClassification: "HIGH_RISK", riskReasons: ["NO_LIQUIDITY"] },
    });
    const res = await request(app).get("/api/v1/tokens/robinhood?lifecycle=trending&limit=20");
    expect(symbolsOf(res.body)).not.toContain("BIGCAP");
  });
});
