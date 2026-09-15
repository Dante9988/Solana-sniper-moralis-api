/**
 * Phase 7B.4 §4.7 — `/api/v1/tokens/robinhood` read routes.
 *
 * Pure Prisma reads over DiscoveredToken/ChainTrade. No write path here —
 * ingestion is the listeners' job (discoveryListener.ts/tradeListener.ts),
 * never an HTTP request. Mirrors tokens.ts's structure exactly (auth,
 * rate limiting, error envelope, validateMint-style param validation).
 */

import { DiscoveredToken, ChainTrade, PrismaClient, Prisma, type TokenMarketSnapshot } from "@prisma/client";
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
import { createPoolEvidenceProvider, type PoolEvidenceProvider } from "../poolEvidenceProvider";
import { toPoolEvidenceJson, toPoolEvidenceUnavailableJson } from "../../presentation/toPoolEvidenceJson";
import { enqueueTokenLogos, logoStatuses, logoUrlFor, type ImageStatus } from "../../media/tokenImageCache";
import { logger } from "../lib/logger";
import { lookupQuoteAsset } from "../../pons/usd/chainlinkQuoteUsdRateProvider";
import { formatScaled } from "../../pons/market/marketSnapshot";

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

function quoteAssetRef(address: string) {
  const asset = lookupQuoteAsset(address);
  return asset
    ? { identified: true, symbol: asset.symbol, name: asset.name, decimals: asset.decimals, kind: asset.kind as "native" | "wrapped-native" | "stablecoin" | "stock-token", usdFeed: asset.feed?.name ?? null }
    : { identified: false, symbol: null, name: null, decimals: null, kind: null, usdFeed: null };
}

const TEN = 10n;

/** Phase 7D.4 — the live snapshot in whole units. Never a bare Decimal.toString() (exponent form). */
export function serializeMarket(s: TokenMarketSnapshot | null | undefined) {
  if (!s) return null;
  const big = (d: Prisma.Decimal | null) => (d === null ? null : BigInt(d.toFixed(0)));
  const whole = (raw: bigint | null, decimals: number | null) => (raw === null || decimals === null ? null : formatScaled(raw, decimals));
  const priceX36 = big(s.priceQuoteX36);
  const priceQuote =
    priceX36 === null || s.tokenDecimals === null || s.quoteDecimals === null
      ? null
      : formatScaled((priceX36 * TEN ** BigInt(s.tokenDecimals)) / TEN ** BigInt(s.quoteDecimals), 36);
  const ok = s.status === "OK";
  return {
    status: s.status as "PENDING" | "OK" | "FAILED" | "UNSUPPORTED",
    reason: s.status === "OK" ? null : s.status === "PENDING" ? "not read yet" : s.lastError,
    venue: (s.venue as "PONS_V2_BONDING_CURVE" | "UNISWAP_V4_POOL" | null) ?? null,
    blockNumber: s.blockNumber?.toString() ?? null,
    asOf: s.blockTimestamp?.toISOString() ?? null,
    priceQuote: ok ? priceQuote : null,
    priceUsd: ok ? decimalToString(s.priceUsd) : null,
    marketCapQuote: ok ? whole(big(s.marketCapQuote), s.quoteDecimals) : null,
    marketCapUsd: ok ? decimalToString(s.marketCapUsd) : null,
    liquidityQuote: ok ? whole(big(s.liquidityQuote), s.quoteDecimals) : null,
    liquidityUsd: ok ? decimalToString(s.liquidityUsd) : null,
    liquidityBasis: !ok ? null : s.venue === "UNISWAP_V4_POOL" ? ("POOL_FULL_RANGE_EQUIVALENT" as const) : ("CURVE_REAL_QUOTE" as const),
    bondingProgressPct: ok && s.bondingProgressBps !== null ? s.bondingProgressBps / 100 : null,
    quoteRaised: ok ? whole(big(s.quoteRaised), s.quoteDecimals) : null,
    graduationThreshold: ok ? whole(big(s.graduationThreshold), s.quoteDecimals) : null,
    readyToGraduate: ok && s.readyToGraduate,
    marketCapChange1hUsd: ok ? decimalToString(s.marketCapChange1hUsd) : null,
    marketCapChange1hPct: ok ? decimalToString(s.marketCapChange1hPct) : null,
    usdSource: ok ? s.usdRateSource : null,
  };
}

function serializeToken(row: DiscoveredToken, logoStatus: ImageStatus = row.logoUrl ? "PENDING" : "NONE", market: TokenMarketSnapshot | null = null) {
  return {
    chain: row.chain,
    venue: row.venue,
    tokenAddress: row.tokenAddress,
    deployer: row.deployer,
    poolAddress: row.poolAddress,
    curveAddress: row.curveAddress,
    quoteAddress: row.quoteAddress,
    quoteAsset: quoteAssetRef(row.quoteAddress),
    // Phase 7D §1 — name()/symbol() are guaranteed by the ERC-20 standard
    // and enrich alongside supply; logo/description/socials are decoded
    // from the launch transaction itself (never contract storage — see
    // abiV2.ts) and may legitimately be unavailable (richMetadataStatus)
    // for a launch routed through an unverified intermediary.
    name: row.name,
    symbol: row.symbol,
    // The launcher's own URL, kept for provenance. Clients must render `logo.url` instead:
    // it is served from OnlyPump's origin, byte-verified, and never contacts a third party.
    logoUrl: row.logoUrl,
    logo: {
      url: row.logoUrl ? logoUrlFor(row.tokenAddress) : null,
      status: logoStatus,
    },
    description: row.description,
    socials: {
      website: row.socialWebsite,
      twitter: row.socialTwitter,
      telegram: row.socialTelegram,
      discord: row.socialDiscord,
      farcaster: row.socialFarcaster,
    },
    richMetadataStatus: row.richMetadataStatus,
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
    // Phase 7D §2 — event-sourced V2 graduation (never polled — see
    // graduationPairedPrincipal/graduationThreshold above for V1's
    // poll-only equivalents, which stay null for V2 rows).
    graduationPositionId: decimalToString(row.graduationPositionId),
    graduationTokenAmount: decimalToString(row.graduationTokenAmount),
    graduationPairTokenAmount: decimalToString(row.graduationPairTokenAmount),
    poolId: row.poolId,
    market: serializeMarket(market),
  };
}

async function snapshotsFor(db: PrismaClient, addresses: string[]): Promise<Map<string, TokenMarketSnapshot>> {
  if (addresses.length === 0) return new Map();
  try {
    const rows = await db.tokenMarketSnapshot.findMany({ where: { chain: "robinhood", tokenAddress: { in: addresses.map((a) => a.toLowerCase()) } } });
    return new Map(rows.map((r) => [r.tokenAddress, r]));
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "market snapshots unavailable");
    return new Map();
  }
}

function serializeTrade(row: ChainTrade) {
  return {
    chain: row.chain,
    venue: row.venue,
    tokenAddress: row.tokenAddress,
    poolAddress: row.poolAddress,
    poolId: row.poolId,
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

/**
 * Logo status is decoration: a cache failure must never fail a token read. Enqueueing is
 * fire-and-forget for the same reason.
 */
async function logoStatusesSafely(db: PrismaClient, rows: DiscoveredToken[]): Promise<Map<string, ImageStatus>> {
  const tokens = rows.map((r) => ({ tokenAddress: r.tokenAddress, logoUrl: r.logoUrl }));
  enqueueTokenLogos(db, tokens).catch((err) => logger.warn({ err: (err as Error).message }, "[token-images] enqueue failed"));
  try {
    return await logoStatuses(db, tokens);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "[token-images] status lookup failed");
    return new Map();
  }
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
  candleHealthThresholds: CandleHealthThresholds = loadCandleHealthThresholds(),
  // Injectable so route tests never touch a real RPC.
  poolEvidenceProvider: PoolEvidenceProvider = createPoolEvidenceProvider()
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
      const { limit, cursor, lifecycle, q } = parsed.data;
      const sort = parsed.data.sort ?? (lifecycle === "almost-bonded" ? "progress" : lifecycle === "trending" ? "change1h" : "new");

      // Phase 7D.4 — filters and orderings over the token and its live snapshot, in one query.
      const conds: Prisma.Sql[] = [Prisma.sql`d.chain = 'robinhood'`, Prisma.sql`d."canonicalStatus" = 'CANONICAL'`];
      if (lifecycle === "graduated") conds.push(Prisma.sql`d.graduated = true`);
      if (lifecycle === "bonding") conds.push(Prisma.sql`d.graduated = false`);
      if (lifecycle === "almost-bonded") conds.push(Prisma.sql`d.graduated = false AND s.status = 'OK' AND s.graduated = false AND s."bondingProgressBps" > 0`);
      if (lifecycle === "trending") conds.push(Prisma.sql`s.status = 'OK' AND s."marketCapChange1hUsd" > 0`);
      if (q) {
        if (/^0x[0-9a-fA-F]{2,40}$/.test(q)) conds.push(Prisma.sql`d."tokenAddress" LIKE ${q.toLowerCase() + "%"}`);
        else conds.push(Prisma.sql`(d.name ILIKE ${"%" + q.replace(/[\\%_]/g, "\\$&") + "%"} OR d.symbol ILIKE ${"%" + q.replace(/[\\%_]/g, "\\$&") + "%"})`);
      }
      const where = Prisma.join(conds, " AND ");
      const order = {
        new: Prisma.sql`d."observedAt" DESC, d."tokenAddress" DESC`,
        marketCap: Prisma.sql`s."marketCapUsd" DESC NULLS LAST, d."observedAt" DESC`,
        liquidity: Prisma.sql`s."liquidityUsd" DESC NULLS LAST, d."observedAt" DESC`,
        progress: Prisma.sql`s."bondingProgressBps" DESC NULLS LAST, s."quoteRaised" DESC NULLS LAST, d."observedAt" DESC`,
        change1h: Prisma.sql`s."marketCapChange1hUsd" DESC NULLS LAST, d."observedAt" DESC`,
      }[sort];
      // "new" pages by time so rows discovered meanwhile don't shift pages; other orders page by offset.
      let offset = 0;
      if (cursor) {
        if (sort === "new") {
          const at = cursor.startsWith("t:") ? cursor.slice(2) : cursor;
          if (Number.isNaN(Date.parse(at))) return sendError(res, "BAD_REQUEST", "invalid cursor", req.requestId);
          conds.push(Prisma.sql`d."observedAt" < ${new Date(at)}`);
        } else {
          const m = /^o:(\d{1,6})$/.exec(cursor);
          if (!m) return sendError(res, "BAD_REQUEST", "invalid cursor", req.requestId);
          offset = Number(m[1]);
        }
      }
      const from = Prisma.sql`FROM "DiscoveredToken" d LEFT JOIN "TokenMarketSnapshot" s ON s.chain = d.chain AND s."tokenAddress" = d."tokenAddress"`;
      const [ids, counted] = await Promise.all([
        db.$queryRaw<Array<{ tokenAddress: string; observedAt: Date }>>`SELECT d."tokenAddress", d."observedAt" ${from} WHERE ${Prisma.join(conds, " AND ")} ORDER BY ${order} OFFSET ${offset} LIMIT ${limit}`,
        db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n ${from} WHERE ${where}`,
      ]);
      const total = Number(counted[0]?.n ?? 0);
      const found = await db.discoveredToken.findMany({ where: { chain: "robinhood", tokenAddress: { in: ids.map((r) => r.tokenAddress) } } });
      const byAddress = new Map(found.map((r) => [r.tokenAddress, r]));
      const rows = ids.map((r) => byAddress.get(r.tokenAddress)).filter((r): r is DiscoveredToken => Boolean(r));

      const last = ids[ids.length - 1];
      const nextCursor = ids.length < limit || !last ? null : sort === "new" ? `t:${last.observedAt.toISOString()}` : `o:${offset + ids.length}`;
      const [statuses, snapshots] = await Promise.all([logoStatusesSafely(db, rows), snapshotsFor(db, rows.map((r) => r.tokenAddress))]);

      res.json({
        tokens: rows.map((row) => serializeToken(row, statuses.get(row.tokenAddress.toLowerCase()), snapshots.get(row.tokenAddress.toLowerCase()) ?? null)),
        nextCursor,
        total,
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

      const [statuses, snapshots] = await Promise.all([logoStatusesSafely(db, [token]), snapshotsFor(db, [token.tokenAddress])]);
      res.json({
        token: serializeToken(token, statuses.get(token.tokenAddress.toLowerCase()), snapshots.get(token.tokenAddress.toLowerCase()) ?? null),
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
