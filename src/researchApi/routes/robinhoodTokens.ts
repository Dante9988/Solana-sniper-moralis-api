/**
 * Phase 7B.4 §4.7 — `/api/v1/tokens/robinhood` read routes.
 *
 * Pure Prisma reads over DiscoveredToken/ChainTrade. No write path here —
 * ingestion is the listeners' job (discoveryListener.ts/tradeListener.ts),
 * never an HTTP request. Mirrors tokens.ts's structure exactly (auth,
 * rate limiting, error envelope, validateMint-style param validation).
 */

import { DiscoveredToken, ChainTrade, PrismaClient, Prisma } from "@prisma/client";
import { Router } from "express";
import { ApiConfig } from "../config";
import { AuthenticateDeps, createAuthenticateUnlessPublicReads } from "../middleware/authenticate";
import { sendError } from "../contracts/errors";
import { createRateLimiter, createRateLimiterStore, rateLimitKey } from "../middleware/rateLimit";
import { validateRobinhoodAddress } from "../middleware/validateRobinhoodAddress";
import {
  RobinhoodTokenListQuerySchema,
  RobinhoodTradeListQuerySchema,
} from "../contracts/robinhoodTokens";
import { computeIngestionHealth } from "../../pons/sourceHealth";
import { loadPonsHealthThresholds, PonsHealthThresholds } from "../../pons/config";

/**
 * Prisma.Decimal#toString() renders large integers in scientific notation
 * (e.g. "1e+27") — confirmed empirically by
 * discoveryListener.dbIntegration.test.ts. #toFixed() with no argument is
 * the correct method for a full, non-exponential decimal-safe digit
 * string. Every Decimal crossing into JSON in this file must go through
 * this helper, never a bare .toString().
 */
function decimalToString(value: Prisma.Decimal | null): string | null {
  return value === null ? null : value.toFixed();
}

function serializeToken(row: DiscoveredToken) {
  return {
    chain: row.chain,
    venue: row.venue,
    tokenAddress: row.tokenAddress,
    deployer: row.deployer,
    poolAddress: row.poolAddress,
    quoteAddress: row.quoteAddress,
    // Phase 7B.5A §4/§9 — null while enrichment is still PENDING (batched,
    // bounded-concurrency getLaunchedToken() retried on later discovery
    // ticks). Never a fabricated default.
    supply: decimalToString(row.supply),
    enrichmentStatus: row.enrichmentStatus,
    initialBuyAmount: decimalToString(row.initialBuyAmount)!,
    sourceHeight: row.sourceHeight.toString(),
    sourceHash: row.sourceHash,
    sourceTxHash: row.sourceTxHash,
    sourceIndex: row.sourceIndex,
    observedAt: row.observedAt.toISOString(),
    graduated: row.graduated,
    graduationPairedPrincipal: decimalToString(row.graduationPairedPrincipal),
    graduationThreshold: decimalToString(row.graduationThreshold),
    graduationCheckedAt: row.graduationCheckedAt?.toISOString() ?? null,
  };
}

function serializeTrade(row: ChainTrade) {
  return {
    chain: row.chain,
    venue: row.venue,
    tokenAddress: row.tokenAddress,
    poolAddress: row.poolAddress,
    side: row.side,
    tokenAmount: decimalToString(row.tokenAmount)!,
    quoteAmount: decimalToString(row.quoteAmount)!,
    quoteAddress: row.quoteAddress,
    priceQuote: decimalToString(row.priceQuote)!,
    trader: row.trader,
    sourceHeight: row.sourceHeight.toString(),
    sourceHash: row.sourceHash,
    sourceTxHash: row.sourceTxHash,
    sourceIndex: row.sourceIndex,
    observedAt: row.observedAt.toISOString(),
  };
}

export function createRobinhoodTokensRouter(db: PrismaClient, config: ApiConfig, deps: AuthenticateDeps, healthThresholds: PonsHealthThresholds = loadPonsHealthThresholds()): Router {
  const router = Router();
  const readAuth = createAuthenticateUnlessPublicReads(config, deps);
  const store = createRateLimiterStore(config.rateLimit);
  const readLimiter = createRateLimiter({ windowMs: 60_000, max: config.rateLimitPerMinute, keyFn: rateLimitKey, store });

  // Phase 7B.5A §5 — registered before "/:tokenAddress" (same reasoning as
  // this router being mounted before the generic /:mint router in
  // server.ts): Express matches routes in registration order, and
  // "/status" would otherwise be swallowed by the ":tokenAddress" param
  // route and rejected as a malformed address.
  router.get("/status", readAuth, readLimiter, async (req, res, next) => {
    try {
      const health = await computeIngestionHealth(db, healthThresholds);
      res.json(health);
    } catch (err) {
      next(err);
    }
  });

  router.get("/", readAuth, readLimiter, async (req, res, next) => {
    try {
      const parsed = RobinhoodTokenListQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        sendError(res, "BAD_REQUEST", "invalid query parameters", req.requestId);
        return;
      }
      const { limit, cursor } = parsed.data;

      const rows = await db.discoveredToken.findMany({
        where: {
          chain: "robinhood",
          // Phase 7B.5A §2/§9 — a row reorg recovery marked ORPHANED is no
          // longer a canonical fact; API consumers must never mistake it
          // for one (phase7b5a.txt §2, requirement 118).
          canonicalStatus: "CANONICAL",
          ...(cursor ? { observedAt: { lt: new Date(cursor) } } : {}),
        },
        orderBy: { observedAt: "desc" },
        take: limit,
      });

      const nextCursor = rows.length === limit ? rows[rows.length - 1].observedAt.toISOString() : null;

      res.json({
        tokens: rows.map(serializeToken),
        nextCursor,
        observedAt: new Date().toISOString(),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:tokenAddress", readAuth, readLimiter, validateRobinhoodAddress, async (req, res, next) => {
    try {
      const parsed = RobinhoodTradeListQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        sendError(res, "BAD_REQUEST", "invalid query parameters", req.requestId);
        return;
      }
      const { limit } = parsed.data;

      const token = await db.discoveredToken.findUnique({
        where: { chain_tokenAddress: { chain: "robinhood", tokenAddress: req.normalizedTokenAddress! } },
      });
      if (!token || token.canonicalStatus !== "CANONICAL") {
        sendError(res, "NOT_FOUND", "token has not been discovered", req.requestId);
        return;
      }

      const trades = await db.chainTrade.findMany({
        where: { chain: "robinhood", tokenAddress: req.normalizedTokenAddress!, canonicalStatus: "CANONICAL" },
        orderBy: { sourceHeight: "desc" },
        take: limit,
      });

      res.json({
        token: serializeToken(token),
        trades: trades.map(serializeTrade),
        observedAt: new Date().toISOString(),
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
