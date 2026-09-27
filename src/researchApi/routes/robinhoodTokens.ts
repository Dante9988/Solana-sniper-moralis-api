/**
 * Phase 7B.4 §4.7 — `/api/v1/tokens/robinhood` read routes.
 *
 * Pure Prisma reads over DiscoveredToken/ChainTrade. No write path here —
 * ingestion is the listeners' job (discoveryListener.ts/tradeListener.ts),
 * never an HTTP request. Mirrors tokens.ts's structure exactly (auth,
 * rate limiting, error envelope, validateMint-style param validation).
 */

import { PrismaClient } from "@prisma/client";
import { createBackfillRunner, type BackfillResult, type BackfillRunner } from "../../pons/backfill/tokenTradeBackfill";
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
import { loadCandleHealthThresholds, CandleHealthThresholds } from "../../candles/config";
import { NullQuoteUsdRateProvider } from "../../candles/usdPricing";
import { listTokens, serializeTokens, serializeTrade, TokenListError } from "../tokenCatalog";
import { sendCandles } from "../candleResponse";
import { createPoolEvidenceProvider, type PoolEvidenceProvider } from "../poolEvidenceProvider";
import { toPoolEvidenceJson, toPoolEvidenceUnavailableJson } from "../../presentation/toPoolEvidenceJson";

// Phase 7E.4.4 — serialization and the discovery query moved to ../tokenCatalog (shared by every
// chain); re-exported so existing importers keep working.
export { serializeMarket } from "../tokenCatalog";

const PRICING_BASIS =
  "Normalized (decimal-adjusted) execution price = normalized quote amount / normalized token amount, using each token's verified on-chain decimals() (never assumed) — see ARCHITECTURE.md §21.4.";
export function createRobinhoodTokensRouter(
  db: PrismaClient,
  config: ApiConfig,
  deps: AuthenticateDeps,
  healthThresholds: PonsHealthThresholds = loadPonsHealthThresholds(),
  candleHealthThresholds: CandleHealthThresholds = loadCandleHealthThresholds(),
  // Injectable so route tests never touch a real RPC.
  poolEvidenceProvider: PoolEvidenceProvider = createPoolEvidenceProvider(),
  // Phase 7D.5 — injectable so route tests never reach an RPC endpoint.
  backfillRunner: BackfillRunner = createBackfillRunner(db)
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
      res.json(await listTokens(db, ["robinhood"], parsed.data));
    } catch (err) {
      if (err instanceof TokenListError) return sendError(res, "BAD_REQUEST", err.message, req.requestId);
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

      const [serialized] = await serializeTokens(db, [token]);
      res.json({
        token: serialized,
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
  /**
   * Phase 7D.3 §5 — live Uniswap V4 pool evidence for a graduated Pons V2 token.
   *
   * Separate from "/:tokenAddress" on purpose: that route is a pure database read and
   * must keep working in a deployment with no chain access, whereas this one needs an
   * RPC. Keeping them apart means an RPC outage degrades one panel instead of the whole
   * token page.
   *
   * Always 200. "This token has no V4 pool yet" is a fact about the token, not an HTTP
   * error, so the payload carries status + reason and the UI renders an honest state.
   */
  router.get("/:tokenAddress/pool", readAuth, readLimiter, validateRobinhoodAddress, async (req, res, next) => {
    try {
      const result = await poolEvidenceProvider.fetch(req.params.tokenAddress);
      if (result.status === "AVAILABLE") {
        res.json(toPoolEvidenceJson(result.evidence));
        return;
      }
      res.json(toPoolEvidenceUnavailableJson(result.reason, result.detail));
    } catch (err) {
      next(err);
    }
  });

  /**
   * Phase 7D.5 — fetch ONE token's trade history on demand.
   *
   * Chain-wide trade ingestion is an indexer workload; a chart is not. This is the
   * address-filtered query a node answers from an index — measured 2026-09-20, a token
   * with 5.1M blocks of history returned all 9,781 of its trades in 11 requests and 7.0s.
   *
   * Idempotent and bounded: a completed token returns immediately, a partial run resumes,
   * and a run that hits its deadline says so instead of hanging the request.
   */
  const backfillLimiter = createRateLimiter({ windowMs: 60_000, max: 10, keyFn: rateLimitKey, store });
  router.post("/:tokenAddress/history", readAuth, backfillLimiter, validateRobinhoodAddress, async (req, res, next) => {
    try {
      const result = await backfillRunner(req.params.tokenAddress);
      res.json(toBackfillJson(result));
    } catch (err) {
      next(err);
    }
  });

  router.get("/:tokenAddress/history", readAuth, readLimiter, validateRobinhoodAddress, async (req, res, next) => {
    try {
      const row = await db.tokenTradeBackfill.findUnique({
        where: { chain_tokenAddress: { chain: "robinhood", tokenAddress: req.params.tokenAddress.toLowerCase() } },
      });
      if (!row) {
        res.json({
          tokenAddress: req.params.tokenAddress.toLowerCase(),
          status: "NOT_STARTED",
          fromBlock: null,
          toBlock: null,
          cursor: null,
          tradesWritten: 0,
          logsScanned: 0,
          requests: 0,
          elapsedMs: null,
          stoppedReason: null,
          coveredVenues: [],
          uncoveredVenues: [],
        });
        return;
      }
      const token = await db.discoveredToken.findUnique({
        where: { chain_tokenAddress: { chain: "robinhood", tokenAddress: row.tokenAddress } }, select: { graduated: true },
      });
      const curveCovered = row.cursor >= row.toBlock;
      const poolCovered = row.poolCursor !== null && row.poolCursor >= row.toBlock;
      const coveredVenues = [...(curveCovered ? ["PONS_V2_BONDING_CURVE"] : []), ...(token?.graduated && poolCovered ? ["UNISWAP_V4_POOL"] : [])];
      const uncoveredVenues = [...(!curveCovered ? ["PONS_V2_BONDING_CURVE"] : []), ...(token?.graduated && !poolCovered ? ["UNISWAP_V4_POOL"] : [])];
      const unverified = row.status === "COMPLETE" && uncoveredVenues.length > 0;
      res.json({
        tokenAddress: row.tokenAddress,
        status: unverified ? "PARTIAL" : row.status,
        fromBlock: row.fromBlock.toString(),
        toBlock: row.toBlock.toString(),
        cursor: row.cursor.toString(),
        tradesWritten: row.tradesWritten,
        logsScanned: row.logsScanned,
        requests: row.requests,
        elapsedMs: null,
        stoppedReason: row.stoppedReason ?? row.lastError ?? (unverified ? "Historical pool coverage has no persisted checkpoint; resume to verify." : null),
        coveredVenues,
        uncoveredVenues,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:tokenAddress/candles", readAuth, readLimiter, validateRobinhoodAddress, async (req, res, next) => {
    try {
      await sendCandles(db, req, res, {
        chain: "robinhood",
        tokenAddress: req.normalizedTokenAddress!,
        candleHealthThresholds,
        sourceStatus: async () => (await computeIngestionHealth(db, healthThresholds)).status,
        pricingBasis: PRICING_BASIS,
        usdNote: `USD pricing is not available in this environment — ${new NullQuoteUsdRateProvider().name}.`,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

function toBackfillJson(r: BackfillResult) {
  return {
    tokenAddress: r.tokenAddress,
    status: r.status,
    fromBlock: r.fromBlock.toString(),
    toBlock: r.toBlock.toString(),
    cursor: r.cursor.toString(),
    tradesWritten: r.tradesWritten,
    logsScanned: r.logsScanned,
    requests: r.requests,
    elapsedMs: r.elapsedMs,
    stoppedReason: r.stoppedReason,
    coveredVenues: [...r.coveredVenues],
    uncoveredVenues: [...r.uncoveredVenues],
  };
}
