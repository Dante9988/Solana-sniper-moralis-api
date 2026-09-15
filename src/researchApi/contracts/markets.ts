/** Phase 7D.4 — ranked market lists (Crypto, Stocks). Prices are CoinGecko's, attributed on every response. */
import { z } from "./zodOpenApi";

const Dec = z.string().nullable();

export const MarketSegmentParamSchema = z.object({ segment: z.enum(["crypto", "stocks"]) });
export const MarketListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(40).optional().default(1),
  perPage: z.coerce.number().int().min(10).max(100).optional().default(50),
});

export const MarketRowSchema = z
  .object({
    rank: z.number().int(),
    marketCapRank: z.number().int().nullable(),
    id: z.string(),
    symbol: z.string(),
    name: z.string(),
    imageUrl: z.string().nullable(),
    priceUsd: Dec,
    marketCapUsd: Dec,
    fdvUsd: Dec,
    volume24hUsd: Dec,
    change1hPct: Dec,
    change24hPct: Dec,
    change7dPct: Dec,
    circulatingSupply: Dec,
    lastUpdated: z.string().nullable(),
    robinhoodChainAddress: z.string().nullable(),
    /** True only when the Robinhood Chain address is on Robinhood's official token list (never CoinGecko alone). */
    officialRobinhoodToken: z.boolean(),
    chainlinkFeed: z.string().nullable(),
    coingeckoUrl: z.string(),
  })
  .openapi("MarketRow");

export const MarketListResponseSchema = z
  .object({
    status: z.enum(["AVAILABLE", "UNAVAILABLE"]),
    segment: z.enum(["crypto", "stocks"]),
    page: z.number().int(),
    perPage: z.number().int(),
    rows: z.array(MarketRowSchema),
    fetchedAt: z.string().nullable(),
    stale: z.boolean(),
    reason: z.string().nullable(),
    source: z.object({ name: z.literal("CoinGecko"), url: z.string(), attribution: z.string() }),
  })
  .openapi("MarketListResponse");
