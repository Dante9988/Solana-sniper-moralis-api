/**
 * Phase 7B.5B §12 / 7E.4.4 — the candle response, shared by every chain's `/:token/candles` route.
 *
 * Moved out of routes/robinhoodTokens.ts unchanged so Solana serves its candles through exactly the
 * same history/pagination contract the chart already consumes (§11: one `CandleDataGateway`, not a
 * second chart). What varies by chain is passed in: which ingestion stream decides freshness, and
 * what to say about USD.
 *
 * Reads PostgreSQL only (MarketCandle) — never an RPC inline to serve a chart request.
 */

import type { PrismaClient } from "@prisma/client";
import type { Request, Response } from "express";

import { computeCandleHealth, type CandleHealthStatus } from "../candles/health";
import type { CandleHealthThresholds } from "../candles/config";
import { resolutionIdToDb, type CandleResolutionId } from "../candles/resolutions";
import { CandleQuerySchema } from "./contracts/candles";
import { sendError } from "./contracts/errors";

const UNIQUE_TRADER_SEMANTICS =
  "Distinct observed ChainTrade.trader values in this bucket — the swap recipient/router-facing address, not a verified ultimate economic trader. See ARCHITECTURE.md §21.7.";

function toFreshness(candleStatus: CandleHealthStatus, sourceStatus: string): string {
  // Freshness reflects the worse of candle-aggregation health and upstream ingestion health — a live
  // candle worker over a degraded trade feed is not genuinely "live" data.
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

export interface SendCandlesOptions {
  readonly chain: "robinhood" | "solana";
  /** Exactly as stored: lowercase for EVM, base58 as written for Solana. */
  readonly tokenAddress: string;
  readonly candleHealthThresholds: CandleHealthThresholds;
  readonly sourceStatus: () => Promise<string>;
  readonly pricingBasis: string;
  readonly usdNote: string;
}

export async function sendCandles(db: PrismaClient, req: Request, res: Response, options: SendCandlesOptions): Promise<void> {
  const { chain, tokenAddress } = options;
  const parsed = CandleQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    sendError(res, "BAD_REQUEST", "invalid query parameters", req.requestId);
    return;
  }
  const { resolution, from, to, limit, cursor, direction } = parsed.data;
  if (from !== undefined && to !== undefined && from > to) {
    sendError(res, "BAD_REQUEST", "'from' must not be after 'to'", req.requestId);
    return;
  }

  const token = await db.discoveredToken.findUnique({ where: { chain_tokenAddress: { chain, tokenAddress } } });
  if (!token || token.canonicalStatus !== "CANONICAL") {
    sendError(res, "NOT_FOUND", "token has not been discovered", req.requestId);
    return;
  }

  /**
   * Phase 7D.6.3 — asking for a token's candles is watching it. The watched-token loop refreshes
   * these every couple of seconds; everything else waits for the fleet pass. Best-effort on purpose:
   * a failure here costs freshness, never the response.
   */
  void db.candleWatch
    .upsert({
      where: { chain_tokenAddress: { chain, tokenAddress } },
      create: { chain, tokenAddress, lastSeenAt: new Date() },
      update: { lastSeenAt: new Date() },
    })
    .catch(() => undefined);

  const resolutionDb = resolutionIdToDb(resolution as CandleResolutionId);
  const effectiveFrom = cursor !== undefined && direction === "forward" ? Math.max(cursor, from ?? 0) : from;
  const effectiveTo = cursor !== undefined && direction === "backward" ? Math.min(cursor, to ?? Infinity) : to;
  const snapshotStartedAt = new Date().toISOString();

  const rows = await db.marketCandle.findMany({
    where: {
      chain,
      tokenAddress,
      resolution: resolutionDb,
      bucketStart: {
        ...(effectiveFrom !== undefined ? { gte: new Date(effectiveFrom * 1000) } : {}),
        ...(effectiveTo !== undefined ? { lt: new Date(effectiveTo * 1000) } : {}),
      },
    },
    // Ascending by bucketStart — a documented, deterministic order suitable for chart rendering and
    // cursor-forward backfill merging.
    orderBy: { bucketStart: direction === "backward" ? "desc" : "asc" },
    take: limit + 1,
  });

  const truncated = rows.length > limit;
  const selected = truncated ? rows.slice(0, limit) : rows;
  const page = direction === "backward" ? selected.reverse() : selected;
  const nextCursor = truncated
    ? direction === "backward"
      ? Math.floor(page[0].bucketStart.getTime() / 1000)
      : Math.floor(page[page.length - 1].bucketStart.getTime() / 1000) + 1
    : null;

  const [candleHealth, sourceStatus] = await Promise.all([computeCandleHealth(db, chain, options.candleHealthThresholds), options.sourceStatus()]);

  res.json({
    chain,
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
    observedAt: snapshotStartedAt,
    freshness: toFreshness(candleHealth.status, sourceStatus),
    pricingBasis: options.pricingBasis,
    uniqueTraderSemantics: UNIQUE_TRADER_SEMANTICS,
    usd: {
      available: page.some((c) => c.volumeUsd !== null),
      provider: null,
      note: options.usdNote,
    },
  });
}
