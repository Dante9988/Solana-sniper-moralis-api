import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createCoinGeckoClient, type Fetcher } from "../../markets/coingecko";
import { loadApiConfig } from "../config";
import { MarketListResponseSchema } from "../contracts/markets";
import { createMarketsRouter } from "../routes/markets";

// A real Robinhood stock token from the official registry (CRM, Salesforce).
const CRM = "0xd95b44124e475743a7589e68f3d74008a5536d44";
const fetcher: Fetcher = async (url) => ({
  ok: true,
  status: 200,
  json: async () =>
    url.includes("/coins/list")
      ? [{ id: "salesforce-robinhood-tokenized-stock", platforms: { robinhood: CRM } }, { id: "fake-stock", platforms: { robinhood: "0x1111111111111111111111111111111111111111" } }]
      : [
          { id: "salesforce-robinhood-tokenized-stock", symbol: "crm", name: "Salesforce", image: null, current_price: 250.5, market_cap: 1000000, market_cap_rank: 1200, fully_diluted_valuation: null, total_volume: 5000, circulating_supply: 4000, last_updated: null },
          { id: "fake-stock", symbol: "fake", name: "Fake", image: null, current_price: 1, market_cap: 10, market_cap_rank: null, fully_diluted_valuation: null, total_volume: 1, circulating_supply: 1, last_updated: null },
        ],
});

function app() {
  const a = express();
  a.use((req, _res, next) => {
    (req as { requestId?: string }).requestId = "t";
    next();
  });
  a.use("/api/v1", createMarketsRouter(loadApiConfig({ API_PUBLIC_READS: "true" } as NodeJS.ProcessEnv), { supabaseVerifier: null }, createCoinGeckoClient({ fetcher })));
  return a;
}

describe("GET /markets/:segment (Phase 7D.4)", () => {
  it("returns the published shape with attribution, and marks only official Robinhood tokens", async () => {
    const res = await request(app()).get("/api/v1/markets/stocks?perPage=10").expect(200);
    const body = MarketListResponseSchema.parse(res.body);
    expect(body.source.attribution).toBe("Price data by CoinGecko");
    expect(body.rows[0]).toMatchObject({ symbol: "CRM", officialRobinhoodToken: true, robinhoodChainAddress: CRM });
    expect(body.rows[1]).toMatchObject({ symbol: "FAKE", officialRobinhoodToken: false, chainlinkFeed: null });
  });

  it("rejects unknown segments and out-of-range pages", async () => {
    await request(app()).get("/api/v1/markets/nfts").expect(400);
    await request(app()).get("/api/v1/markets/crypto?page=0").expect(400);
  });
});
