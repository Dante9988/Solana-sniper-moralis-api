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
import { CandleQuerySchema } from "../contracts/candles";
import { computeIngestionHealth } from "../../pons/sourceHealth";
import { loadPonsHealthThresholds, PonsHealthThresholds } from "../../pons/config";
import { computeCandleHealth, CandleHealthStatus } from "../../candles/health";
import { loadCandleHealthThresholds, CandleHealthThresholds } from "../../candles/config";
import { resolutionIdToDb, CandleResolutionId } from "../../candles/resolutions";
import { NullQuoteUsdRateProvider } from "../../candles/usdPricing";

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

const PRICING_BASIS =
  "Normalized (decimal-adjusted) execution price = normalized quote amount / normalized token amount, using each token's verified on-chain decimals() (never assumed) — see ARCHITECTURE.md §21.4.";
const UNIQUE_TRADER_SEMANTICS =
  "Distinct observed ChainTrade.trader values in this bucket — the swap recipient/router-facing address, not a verified ultimate economic trader. See ARCHITECTURE.md §21.7.";

function toFreshness(candleStatus: CandleHealthStatus, sourceStatus: string): string {
  // Freshness reflects the worse of candle-aggregation health and
  // upstream Pons ingestion health — a live candle worker over a degraded
  // trade feed is not genuinely "live" data.
  const rank: Record<string, number> = { LIVE: 0, LAGGING: 1, DEGRADED: 2, REORG_RECOVERY: 3, UNAVAILABLE: 4 };
  const worst = rank[candleStatus] >= rank[sourceStatus] ? candleStatus : (sourceStatus as CandleHealthStatus);
  switch (worst) {
    case "LIVE":
      return "live";
    case "LAGGING":
      return "lagging";
    case "DEGRADED":
      return "degraded";
    case "REORG_RECOVERY":
      return "reorg_recovery";
    default:
      return "unavailable";
  }
}

export function createRobinhoodTokensRouter(
  db: PrismaClient,
  config: ApiConfig,
  deps: AuthenticateDeps,
  healthThresholds: PonsHealthThresholds = loadPonsHealthThresholds(),
  candleHealthThresholds: CandleHealthThresholds = loadCandleHealthThresholds()
): Router {
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

  // Phase 7B.5B §12 — GET /api/v1/tokens/robinhood/:tokenAddress/candles.
  // Reads PostgreSQL only (MarketCandle) — never Robinhood RPC inline to
  // serve a chart request. Registered after "/:tokenAddress" is harmless
  // (different path depth — no Express route-order ambiguity), but placed
  // here to keep it visually next to the route it extends.
  router.get("/:tokenAddress/candles", readAuth, readLimiter, validateRobinhoodAddress, async (req, res, next) => {
    try {
      const parsed = CandleQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        sendError(res, "BAD_REQUEST", "invalid query parameters", req.requestId);
        return;
      }
      const { resolution, from, to, limit, cursor } = parsed.data;
      if (from !== undefined && to !== undefined && from > to) {
        sendError(res, "BAD_REQUEST", "'from' must not be after 'to'", req.requestId);
        return;
      }

      const tokenAddress = req.normalizedTokenAddress!;
      const token = await db.discoveredToken.findUnique({ where: { chain_tokenAddress: { chain: "robinhood", tokenAddress } } });
      if (!token || token.canonicalStatus !== "CANONICAL") {
        sendError(res, "NOT_FOUND", "token has not been discovered", req.requestId);
        return;
      }

      const resolutionDb = resolutionIdToDb(resolution as CandleResolutionId);
      const effectiveFrom = cursor !== undefined ? Math.max(cursor, from ?? 0) : from;

      const rows = await db.marketCandle.findMany({
        where: {
          chain: "robinhood",
          tokenAddress,
          resolution: resolutionDb,
          bucketStart: {
            ...(effectiveFrom !== undefined ? { gte: new Date(effectiveFrom * 1000) } : {}),
            ...(to !== undefined ? { lt: new Date(to * 1000) } : {}),
          },
        },
        // Ascending by bucketStart — a documented, deterministic order
        // suitable for chart rendering and cursor-forward backfill merging
        // (phase7b5b.txt §12: "Return chart history in a documented order
        // suitable for deterministic merging/backfill").
        orderBy: { bucketStart: "asc" },
        take: limit + 1,
      });

      const truncated = rows.length > limit;
      const page = truncated ? rows.slice(0, limit) : rows;
      const nextCursor = truncated ? Math.floor(page[page.length - 1].bucketStart.getTime() / 1000) + 1 : null;

      const [candleHealth, sourceHealth] = await Promise.all([
        computeCandleHealth(db, "robinhood", candleHealthThresholds),
        computeIngestionHealth(db, healthThresholds),
      ]);

      res.json({
        chain: "robinhood",
        venue: token.venue,
        tokenAddress,
        quoteAddress: token.quoteAddress,
        resolution,
        candles: page.map((c) => ({
          startTime: Math.floor(c.bucketStart.getTime() / 1000),
          open: c.open.toFixed(),
          high: c.high.toFixed(),
          low: c.low.toFixed(),
          close: c.close.toFixed(),
          volumeToken: c.volumeToken.toFixed(),
          volumeQuote: c.volumeQuote.toFixed(),
          volumeUsd: c.volumeUsd ? c.volumeUsd.toFixed() : null,
          trades: c.tradeCount,
          uniqueTraders: c.uniqueTraders,
          status: c.status === "FINAL" ? "final" : "provisional",
          updatedAt: c.updatedAt.toISOString(),
        })),
        nextCursor,
        observedAt: new Date().toISOString(),
        freshness: toFreshness(candleHealth.status, sourceHealth.status),
        pricingBasis: PRICING_BASIS,
        uniqueTraderSemantics: UNIQUE_TRADER_SEMANTICS,
        usd: {
          available: page.some((c) => c.volumeUsd !== null),
          provider: null,
          note: `USD pricing is not available in this environment — ${new NullQuoteUsdRateProvider().name}.`,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
