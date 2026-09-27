/**
 * Phase 7E.4.4 — Solana discovery routes, and the chain-neutral token list.
 *
 *   GET /api/v1/tokens?chain=robinhood|solana|all     one query across chains (tokenCatalog.ts)
 *   GET /api/v1/tokens/solana                          the same list, chain=solana
 *   GET /api/v1/tokens/solana/status                   Solana ingestion health
 *   GET /api/v1/tokens/solana/:mint                    token + its latest canonical trades
 *   GET /api/v1/tokens/solana/:mint/market             the terminal's market data (same shape as Robinhood's)
 *   GET /api/v1/tokens/solana/:mint/candles            the same candle contract as Robinhood's
 *
 * Solana rows are never served through a route named `robinhood` (§1). Every route here reads
 * PostgreSQL only; ingestion is the Solana worker's job, never an HTTP request's.
 *
 * Mints are validated by the existing Solana resolver and used EXACTLY as written: base58 is
 * case-sensitive, and a lowercased mint is a different (invalid) key (§14).
 */

import type { PrismaClient } from "@prisma/client";
import { Router } from "express";

import { loadCandleHealthThresholds, type CandleHealthThresholds } from "../../candles/config";
import { computeSourceHealth, type SourceHealthDetail } from "../../pons/sourceHealth";
import { PUMPFUN_CHECKPOINT_SOURCE } from "../../solana/pumpfunIngestionEngine";
import { fetchSolanaTokenMarketData, SOLANA_USD_UNAVAILABLE } from "../../solana/solanaMarketDataService";
import { sendCandles } from "../candleResponse";
import type { ApiConfig } from "../config";
import { sendError } from "../contracts/errors";
import { MARKET_DATA_API_VERSION } from "../contracts/marketData";
import { RobinhoodTradeListQuerySchema, TokenListQuerySchema, RobinhoodTokenListQuerySchema } from "../contracts/robinhoodTokens";
import { AuthenticateDeps, createAuthenticateUnlessPublicReads } from "../middleware/authenticate";
import { createRateLimiter, createRateLimiterStore, rateLimitKey } from "../middleware/rateLimit";
import { validateMint } from "../middleware/validateMint";
import { listTokens, serializeMarket, serializeTokens, serializeTrade, TokenListError, type CatalogChain } from "../tokenCatalog";

const SOLANA_PRICING_BASIS =
  "Normalized execution price = quote amount / token amount, each scaled by its mint's on-chain decimals (read at discovery, never assumed). Quoted in SOL; no USD conversion.";

/**
 * Solana ingestion thresholds. The worker commits progress many times a second while Pump.fun is
 * trading (~56 successful tx/s measured 2026-09-26), so a minute without a commit means it stopped.
 * Block lag is not used: the checkpoint's observed height is the FINALIZED slot, which trails the
 * confirmed slot it has processed by design.
 */
export const SOLANA_HEALTH_THRESHOLDS = { healthStaleMs: 60_000, healthErrorWindowMs: 60_000, healthLaggingBlocks: Number.MAX_SAFE_INTEGER };

export function solanaIngestionHealth(db: PrismaClient, now: Date = new Date()): Promise<SourceHealthDetail> {
  return computeSourceHealth(db, PUMPFUN_CHECKPOINT_SOURCE, SOLANA_HEALTH_THRESHOLDS, now);
}

function readRouter(config: ApiConfig, deps: AuthenticateDeps) {
  const router = Router();
  const readAuth = createAuthenticateUnlessPublicReads(config, deps);
  const limiter = createRateLimiter({ windowMs: 60_000, max: config.rateLimitPerMinute, keyFn: rateLimitKey, store: createRateLimiterStore(config.rateLimit) });
  return { router, readAuth, limiter };
}

/** `GET /api/v1/tokens` — mounted on the exact path, before the generic `/tokens/:mint/*` router. */
export function createTokenCatalogRouter(db: PrismaClient, config: ApiConfig, deps: AuthenticateDeps): Router {
  const { router, readAuth, limiter } = readRouter(config, deps);
  router.get("/tokens", readAuth, limiter, async (req, res, next) => {
    try {
      const parsed = TokenListQuerySchema.safeParse(req.query);
      if (!parsed.success) return sendError(res, "BAD_REQUEST", "invalid query parameters", req.requestId);
      const { chain, ...filters } = parsed.data;
      const chains: CatalogChain[] = chain === "all" ? ["robinhood", "solana"] : [chain];
      res.json(await listTokens(db, chains, filters));
    } catch (err) {
      if (err instanceof TokenListError) return sendError(res, "BAD_REQUEST", err.message, req.requestId);
      next(err);
    }
  });
  return router;
}

export function createSolanaTokensRouter(
  db: PrismaClient,
  config: ApiConfig,
  deps: AuthenticateDeps,
  candleHealthThresholds: CandleHealthThresholds = loadCandleHealthThresholds()
): Router {
  const { router, readAuth, limiter } = readRouter(config, deps);

  // Registered before "/:mint", which would otherwise swallow "status" as a (malformed) mint.
  router.get("/status", readAuth, limiter, async (_req, res, next) => {
    try {
      const pumpfun = await solanaIngestionHealth(db);
      res.json({ status: pumpfun.status, streams: [pumpfun], observedAt: new Date().toISOString() });
    } catch (err) {
      next(err);
    }
  });

  router.get("/", readAuth, limiter, async (req, res, next) => {
    try {
      const parsed = RobinhoodTokenListQuerySchema.safeParse(req.query);
      if (!parsed.success) return sendError(res, "BAD_REQUEST", "invalid query parameters", req.requestId);
      res.json(await listTokens(db, ["solana"], parsed.data));
    } catch (err) {
      if (err instanceof TokenListError) return sendError(res, "BAD_REQUEST", err.message, req.requestId);
      next(err);
    }
  });

  router.get("/:mint", readAuth, limiter, validateMint, async (req, res, next) => {
    try {
      const parsed = RobinhoodTradeListQuerySchema.safeParse(req.query);
      if (!parsed.success) return sendError(res, "BAD_REQUEST", "invalid query parameters", req.requestId);
      const mint = req.normalizedMint!;
      const token = await db.discoveredToken.findUnique({ where: { chain_tokenAddress: { chain: "solana", tokenAddress: mint } } });
      if (!token || token.canonicalStatus !== "CANONICAL") return sendError(res, "NOT_FOUND", "token has not been discovered", req.requestId);
      const trades = await db.chainTrade.findMany({
        where: { chain: "solana", tokenAddress: mint, canonicalStatus: "CANONICAL" },
        orderBy: [{ sourceHeight: "desc" }, { sourceIndex: "desc" }],
        take: parsed.data.limit,
      });
      const [serialized] = await serializeTokens(db, [token]);
      res.json({ token: serialized, trades: trades.map(serializeTrade), observedAt: new Date().toISOString() });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:mint/market", readAuth, limiter, validateMint, async (req, res, next) => {
    try {
      const mint = req.normalizedMint!;
      const outcome = await fetchSolanaTokenMarketData(db, mint);
      if (outcome.status === "AVAILABLE") {
        // The live snapshot is additive: failing to read it must not fail trade-derived market data.
        const snapshot = await db.tokenMarketSnapshot.findUnique({ where: { chain_tokenAddress: { chain: "solana", tokenAddress: mint } } }).catch(() => null);
        res.json({ apiVersion: MARKET_DATA_API_VERSION, status: "AVAILABLE", market: { ...outcome.market, live: serializeMarket(snapshot) } });
      } else if (outcome.status === "UNKNOWN_TOKEN") {
        res.json({ apiVersion: MARKET_DATA_API_VERSION, status: "UNAVAILABLE", reason: "UNKNOWN_TOKEN", detail: "This token has not been discovered by OnlyPump." });
      } else {
        res.json({ apiVersion: MARKET_DATA_API_VERSION, status: "UNAVAILABLE", reason: outcome.reason, detail: outcome.detail });
      }
    } catch (err) {
      next(err);
    }
  });

  router.get("/:mint/candles", readAuth, limiter, validateMint, async (req, res, next) => {
    try {
      await sendCandles(db, req, res, {
        chain: "solana",
        tokenAddress: req.normalizedMint!,
        candleHealthThresholds,
        sourceStatus: async () => (await solanaIngestionHealth(db)).status,
        pricingBasis: SOLANA_PRICING_BASIS,
        usdNote: SOLANA_USD_UNAVAILABLE,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
