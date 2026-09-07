/**
 * Phase 7B.5B §12/§13 — `GET /api/v1/tokens/robinhood/:tokenAddress/candles`
 * contracts. Preserves the frontend's existing chart concepts (startTime,
 * open/high/low/close, volumeToken/volumeQuote/volumeUsd, trades,
 * uniqueTraders, status, updatedAt — only-pump-me's candle.ts) but never
 * reuses its Solana-specific `mint`/`pump|pumpswap` vocabulary for Robinhood
 * (phase7b5b.txt §13) — this is chain/venue-explicit instead.
 */

import { z } from "./zodOpenApi";
import { CANDLE_RESOLUTIONS } from "../../candles/resolutions";

export const CandleResolutionSchema = z.enum(CANDLE_RESOLUTIONS as [string, ...string[]]).openapi("CandleResolution");

export const CandleQuerySchema = z.object({
  resolution: CandleResolutionSchema,
  /** Unix seconds, inclusive lower bound on bucketStart. */
  from: z.coerce.number().int().nonnegative().optional(),
  /** Unix seconds, exclusive upper bound on bucketStart. */
  to: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional().default(500),
  /** Opaque cursor from a previous response's nextCursor — the bucketStart (unix seconds) to resume strictly after, ascending. */
  cursor: z.coerce.number().int().nonnegative().optional(),
});

export const CandleSchema = z
  .object({
    /** Unix seconds — the deterministic UTC bucket boundary, never a Date/ISO string (matches the existing frontend Candle.startTime contract). */
    startTime: z.number().int(),
    open: z.string(),
    high: z.string(),
    low: z.string(),
    close: z.string(),
    volumeToken: z.string(),
    volumeQuote: z.string(),
    volumeUsd: z.string().nullable(),
    trades: z.number().int(),
    /** Distinct observed swap recipients (ChainTrade.trader) — not verified ultimate economic trader attribution (phase7b5b.txt §6). See uniqueTraderSemantics on the parent response. */
    uniqueTraders: z.number().int(),
    status: z.enum(["provisional", "final"]),
    updatedAt: z.string(),
  })
  .openapi("Candle");

export const CandleFreshnessSchema = z.enum(["live", "lagging", "degraded", "reorg_recovery", "unavailable"]).openapi("CandleFreshness");

export const CandleHistoryResponseSchema = z
  .object({
    chain: z.literal("robinhood"),
    venue: z.string(),
    tokenAddress: z.string(),
    quoteAddress: z.string(),
    resolution: CandleResolutionSchema,
    candles: z.array(CandleSchema),
    /** Ascending by startTime — see this route's docs for the exact merge/backfill order guarantee. */
    nextCursor: z.number().int().nullable(),
    observedAt: z.string(),
    freshness: CandleFreshnessSchema,
    /** Human-readable description of what open/high/low/close actually are — never silently assumed by a client. */
    pricingBasis: z.string(),
    uniqueTraderSemantics: z.string(),
    usd: z.object({
      available: z.boolean(),
      provider: z.string().nullable(),
      note: z.string(),
    }),
  })
  .openapi("CandleHistoryResponse");
