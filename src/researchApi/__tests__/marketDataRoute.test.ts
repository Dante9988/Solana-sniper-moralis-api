import { PrismaClient } from "@prisma/client";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { loadApiConfig } from "../config";
import { TokenMarketDataResponseSchema } from "../contracts/marketData";
import { createMarketDataRouter, type MarketDataEngine } from "../routes/marketData";

/** Phase 7D.4 §3 — the market data HTTP contract, with an injected engine (no RPC, no DB). */

const TOKEN = "0x7f2fb18365b35b44eeee2ab4dbcdec58713a8831";

function appWith(engine: MarketDataEngine) {
  process.env.API_PUBLIC_READS = "true";
  const app = express();
  app.use((req, _res, next) => {
    (req as { requestId?: string }).requestId = "test";
    next();
  });
  app.use("/api/v1", createMarketDataRouter({} as PrismaClient, loadApiConfig(), {} as never, engine));
  return app;
}

describe("GET /api/v1/tokens/robinhood/:tokenAddress/market", () => {
  it("returns market data matching the published contract, with no circulating market cap", async () => {
    const engine: MarketDataEngine = async () => ({
      status: "AVAILABLE",
      market: {
        token: { address: TOKEN, symbol: "FLAMES", name: "Flames", decimals: 18, lifecycle: "BONDING" },
        quoteAsset: { address: "0x0000000000000000000000000000000000000000", symbol: "ETH", decimals: 18, identified: true, usdFeed: "ETH / USD" },
        price: { native: "0.00000001464", lastTradeAt: "2026-09-12T08:30:59.000Z", usd: "0.0000367", usdBasis: "last traded price × ETH / USD now", usdUnavailableReason: null },
        valuation: { totalSupply: "1000000000", fdvNative: "14.64", fdvUsd: "36705.08", basis: "TOTAL_SUPPLY_x_LAST_TRADE_PRICE", circulatingSupply: null, circulatingSupplyReason: "not indexed" },
        coverage: { from: "2026-09-12T08:17:32.000Z", to: "2026-09-12T08:31:01.000Z", truncated: false, notes: [] },
        windows: [{ window: "5m", from: "a", to: "b", coverage: "NONE", trades: null, buys: null, sells: null, volumeQuote: null, volumeUsd: null, tradesValuedUsd: null, priceChangePct: null }],
        recentTrades: [],
        observedAt: "2026-09-15T02:00:00.000Z",
      },
    });
    const res = await request(appWith(engine)).get(`/api/v1/tokens/robinhood/${TOKEN}/market`);
    expect(res.status).toBe(200);
    expect(TokenMarketDataResponseSchema.safeParse(res.body).success).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(/marketCap/i);
  });

  it("answers an unknown token and a chain-less deployment with 200 and a reason, not an error", async () => {
    const unknown = await request(appWith(async () => ({ status: "UNKNOWN_TOKEN" }))).get(`/api/v1/tokens/robinhood/${TOKEN}/market`);
    expect(unknown.body).toMatchObject({ status: "UNAVAILABLE", reason: "UNKNOWN_TOKEN" });
    const noChain = await request(appWith(async () => ({ status: "NOT_CONFIGURED", detail: "ROBINHOOD_RPC_HTTPS missing" }))).get(`/api/v1/tokens/robinhood/${TOKEN}/market`);
    expect(noChain.body).toMatchObject({ status: "UNAVAILABLE", reason: "DATABASE_ONLY_DEPLOYMENT" });
    expect(JSON.stringify(noChain.body)).not.toContain("ROBINHOOD_RPC_HTTPS");
  });

  it("rejects a malformed address before touching the engine", async () => {
    let called = false;
    const res = await request(appWith(async () => { called = true; return { status: "UNKNOWN_TOKEN" }; })).get(`/api/v1/tokens/robinhood/not-an-address/market`);
    expect(res.status).toBe(400);
    expect(called).toBe(false);
  });
});
