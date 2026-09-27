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
import { serializeMarket } from "./robinhoodTokens";
import { ChainlinkQuoteUsdRateProvider } from "../../pons/usd/chainlinkQuoteUsdRateProvider";
import { solanaIngestionHealth } from "./solanaTokens";

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
        // The live snapshot is additive: failing to read it must not fail trade-derived market data.
        const snapshot = await Promise.resolve()
          .then(() => db.tokenMarketSnapshot.findUnique({ where: { chain_tokenAddress: { chain: "robinhood", tokenAddress: req.normalizedTokenAddress!.toLowerCase() } } }))
          .catch(() => null);
        res.json({ apiVersion: MARKET_DATA_API_VERSION, status: "AVAILABLE", market: { ...outcome.market, live: serializeMarket(snapshot) } });
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
  // Phase 7E.4.4 — Solana's entry is measured, not declared: it follows the Pump.fun worker's own
  // checkpoint, so a stopped worker shows up here as DEGRADED/UNAVAILABLE rather than "live".
  router.get("/discovery/chains", readAuth, limiter, async (_req, res, next) => {
    try {
      res.json({
        chains: [
          {
            chain: "robinhood",
            discovery: "AVAILABLE",
            providers: [{ id: "pons", label: "PONS", status: "AVAILABLE", reason: null }],
            reason: null,
          },
          await solanaDiscoveryCapability(db),
        ],
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

const LAUNCHLAB_BUILDING = "Raydium LaunchLab is being integrated; its tokens are not indexed yet.";

/**
 * Phase 7E.4.4 — Solana discovery capability, from the Pump.fun worker's measured health.
 *
 * Pump.fun and PumpSwap are one worker (PumpSwap follows each graduated token's pool), so they share
 * a status. A stopped worker with tokens already indexed is DEGRADED — those tokens are real and
 * still served, but nothing new is arriving — and UNAVAILABLE only when nothing was ever indexed.
 */
export async function solanaDiscoveryCapability(db: PrismaClient, now: Date = new Date()) {
  const [health, indexed] = await Promise.all([
    solanaIngestionHealth(db, now),
    db.discoveredToken.count({ where: { chain: "solana", canonicalStatus: "CANONICAL" }, take: 1 }).catch(() => 0),
  ]);
  const live = health.status === "LIVE" || health.status === "LAGGING";
  const status = live ? "AVAILABLE" : indexed > 0 ? "DEGRADED" : "UNAVAILABLE";
  const reason = live
    ? null
    : health.lastSuccessAt
      ? `Solana ingestion last committed ${health.secondsSinceLastSuccess ?? "?"}s ago and is not running now; already-indexed tokens are still shown, new ones will not appear.`
      : "Solana ingestion is not running in this deployment.";
  return {
    chain: "solana" as const,
    discovery: status,
    providers: [
      { id: "pumpfun", label: "Pump.fun", status, reason },
      { id: "pumpswap", label: "PumpSwap", status, reason: reason ?? "Graduated Pump.fun tokens keep trading here; each token is followed through its own pool." },
      { id: "launchlab", label: "LaunchLab", status: "IN_DEVELOPMENT" as const, reason: LAUNCHLAB_BUILDING },
      { id: "bonkfun", label: "Bonk.fun", status: "UNAVAILABLE" as const, reason: "Not integrated." },
    ],
    reason,
    lastIngestedAt: health.lastSuccessAt,
  };
}
