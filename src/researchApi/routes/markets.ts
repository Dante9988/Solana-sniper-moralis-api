/**
 * Phase 7D.4 — GET /markets/:segment (crypto | stocks). Public-read rules; no chain access needed.
 */
import { Router } from "express";

import { createCoinGeckoClient, type CoinGeckoClient } from "../../markets/coingecko";
import { lookupQuoteAsset } from "../../pons/usd/chainlinkQuoteUsdRateProvider";
import type { ApiConfig } from "../config";
import { sendError } from "../contracts/errors";
import { MarketListQuerySchema, MarketSegmentParamSchema } from "../contracts/markets";
import { AuthenticateDeps, createAuthenticateUnlessPublicReads } from "../middleware/authenticate";
import { createRateLimiter, createRateLimiterStore, rateLimitKey } from "../middleware/rateLimit";

const SOURCE = { name: "CoinGecko" as const, url: "https://www.coingecko.com", attribution: "Price data by CoinGecko" };

export function createMarketsRouter(config: ApiConfig, deps: AuthenticateDeps, client: CoinGeckoClient = createCoinGeckoClient({ apiKey: process.env.COINGECKO_DEMO_API_KEY?.trim() || undefined })): Router {
  const router = Router();
  const readAuth = createAuthenticateUnlessPublicReads(config, deps);
  const limiter = createRateLimiter({ windowMs: 60_000, max: config.rateLimitPerMinute, keyFn: rateLimitKey, store: createRateLimiterStore(config.rateLimit) });

  router.get("/markets/:segment", readAuth, limiter, async (req, res, next) => {
    try {
      const params = MarketSegmentParamSchema.safeParse(req.params);
      const query = MarketListQuerySchema.safeParse(req.query);
      if (!params.success || !query.success) return sendError(res, "BAD_REQUEST", "segment must be crypto or stocks; page 1–40; perPage 10–100", req.requestId);
      const list = await client.list(params.data.segment, query.data.page, query.data.perPage);
      res.json({
        ...list,
        rows: list.rows.map((row) => {
          const official = row.robinhoodChainAddress ? lookupQuoteAsset(row.robinhoodChainAddress) : null;
          return { ...row, officialRobinhoodToken: Boolean(official), chainlinkFeed: official?.feed?.name ?? null };
        }),
        source: SOURCE,
      });
    } catch (err) {
      next(err);
    }
  });
  return router;
}
