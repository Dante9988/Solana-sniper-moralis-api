/**
 * Phase 7D.4 §3 — GET /api/v1/tokens/robinhood/:tokenAddress/market
 *
 * Results are shared for a few seconds per token (the terminal polls, and each request may value
 * many trades); concurrent requests join the one in flight. `observedAt` says when it was computed.
 */

import type { PrismaClient } from "@prisma/client";
import { Router } from "express";

import type { ApiConfig } from "../config";
import { MARKET_DATA_API_VERSION } from "../contracts/marketData";
import { AuthenticateDeps, createAuthenticateUnlessPublicReads } from "../middleware/authenticate";
import { createRateLimiter, createRateLimiterStore, rateLimitKey } from "../middleware/rateLimit";
import { validateRobinhoodAddress } from "../middleware/validateRobinhoodAddress";
import { loadRobinhoodChainConfig } from "../../pons/config";
import { FailoverChainClient } from "../../pons/failoverChainClient";
import { fetchTokenMarketData, type MarketDataOutcome } from "../../pons/market/marketDataService";
import { ChainlinkQuoteUsdRateProvider } from "../../pons/usd/chainlinkQuoteUsdRateProvider";

export const MARKET_DATA_CACHE_MS = 10_000;

export type MarketDataEngine = (tokenAddress: string) => Promise<MarketDataOutcome | { status: "NOT_CONFIGURED"; detail: string }>;

export function createMarketDataEngine(db: PrismaClient, env: NodeJS.ProcessEnv = process.env): MarketDataEngine {
  let wiring: { chainClient: FailoverChainClient; usd: ChainlinkQuoteUsdRateProvider } | null = null;
  const cache = new Map<string, { at: number; value: Promise<MarketDataOutcome> }>();
  return async (tokenAddress) => {
    if (!wiring) {
      try {
        const chainClient = new FailoverChainClient({ config: loadRobinhoodChainConfig(env), env });
        wiring = { chainClient, usd: new ChainlinkQuoteUsdRateProvider({ chainClient }) };
      } catch (error) {
        return { status: "NOT_CONFIGURED", detail: (error as Error).message };
      }
    }
    const key = tokenAddress.toLowerCase();
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < MARKET_DATA_CACHE_MS) return hit.value;
    const value = fetchTokenMarketData({ db, chainClient: wiring.chainClient, usd: wiring.usd }, key);
    cache.set(key, { at: Date.now(), value });
    value.catch(() => cache.delete(key));
    return value;
  };
}

export function createMarketDataRouter(db: PrismaClient, config: ApiConfig, deps: AuthenticateDeps, engine: MarketDataEngine = createMarketDataEngine(db)): Router {
  const router = Router();
  const readAuth = createAuthenticateUnlessPublicReads(config, deps);
  const limiter = createRateLimiter({ windowMs: 60_000, max: config.rateLimitPerMinute, keyFn: rateLimitKey, store: createRateLimiterStore(config.rateLimit) });

  router.get("/tokens/robinhood/:tokenAddress/market", readAuth, limiter, validateRobinhoodAddress, async (req, res, next) => {
    try {
      const outcome = await engine(req.normalizedTokenAddress!);
      if (outcome.status === "AVAILABLE") {
        res.json({ apiVersion: MARKET_DATA_API_VERSION, status: "AVAILABLE", market: outcome.market });
      } else if (outcome.status === "UNKNOWN_TOKEN") {
        res.json({ apiVersion: MARKET_DATA_API_VERSION, status: "UNAVAILABLE", reason: "UNKNOWN_TOKEN", detail: "This token has not been discovered by OnlyPump." });
      } else if (outcome.status === "NOT_CONFIGURED") {
        res.json({ apiVersion: MARKET_DATA_API_VERSION, status: "UNAVAILABLE", reason: "DATABASE_ONLY_DEPLOYMENT", detail: "Market data needs chain access, which this deployment does not have." });
      } else {
        res.json({ apiVersion: MARKET_DATA_API_VERSION, status: "UNAVAILABLE", reason: outcome.reason, detail: outcome.detail });
      }
    } catch (err) {
      next(err);
    }
  });
  // Phase 7D.4 §1 — what discovery exists, so the UI labels unsupported chains and providers
  // instead of rendering an empty result that looks like "no tokens".
  router.get("/discovery/chains", readAuth, limiter, (_req, res) => {
    res.json({
      chains: [
        {
          chain: "robinhood",
          discovery: "AVAILABLE",
          providers: [{ id: "pons", label: "PONS", status: "AVAILABLE", reason: null }],
          reason: null,
        },
        {
          chain: "solana",
          discovery: "UNAVAILABLE",
          providers: [
            { id: "pumpfun", label: "Pump.fun", status: "UNAVAILABLE", reason: "Solana launch discovery is not connected in this deployment." },
            { id: "launchlab", label: "LaunchLab", status: "UNAVAILABLE", reason: "Not integrated." },
            { id: "bonkfun", label: "Bonk.fun", status: "UNAVAILABLE", reason: "Not integrated." },
          ],
          reason: "Solana launch discovery is not connected in this deployment.",
        },
      ],
    });
  });

  return router;
}
