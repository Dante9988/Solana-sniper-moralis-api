/**
 * Phase 7D.4 §3 — token market data contract. Human-readable decimal strings (already scaled by the
 * relevant decimals), because this feeds display; raw base units stay in quotes and trades.
 */

import { z } from "./zodOpenApi";

export const MARKET_DATA_API_VERSION = 1 as const;

const Decimal = z.string().regex(/^-?\d+(\.\d+)?$/).openapi({ description: "Decimal string, already scaled by decimals.", example: "0.000000014640145702" });

const WindowSchema = z
  .object({
    window: z.enum(["5m", "15m", "30m", "1h", "24h"]),
    from: z.string(),
    to: z.string(),
    coverage: z.enum(["COMPLETE", "PARTIAL", "NONE"]).openapi({ description: "COMPLETE: ingestion covers the whole window, so zero means no activity. PARTIAL: observed values only. NONE: not covered; all values null." }),
    trades: z.number().int().nullable(),
    buys: z.number().int().nullable(),
    sells: z.number().int().nullable(),
    volumeQuote: Decimal.nullable().openapi({ description: "Sum of trader-side quote amounts; each trade counted once." }),
    volumeUsd: Decimal.nullable().openapi({ description: "Sum of per-trade USD at each trade's time; null unless every trade in the window was valued." }),
    tradesValuedUsd: z.number().int().nullable(),
    priceChangePct: Decimal.nullable().openapi({ description: "Latest price vs the last price at or before the window start; null without a baseline." }),
  })
  .openapi("MarketWindow");

const RecentTradeSchema = z
  .object({
    side: z.enum(["buy", "sell"]),
    tokenAmount: Decimal,
    quoteAmount: Decimal,
    price: Decimal.nullable(),
    usd: Decimal.nullable(),
    trader: z.string(),
    txHash: z.string(),
    logIndex: z.number().int(),
    block: z.string(),
    timestamp: z.string(),
    venue: z.enum(["BONDING_CURVE", "UNISWAP_V4"]),
  })
  .openapi("MarketRecentTrade");

export const TokenMarketDataSchema = z
  .object({
    token: z.object({ address: z.string(), symbol: z.string().nullable(), name: z.string().nullable(), decimals: z.number().int(), lifecycle: z.enum(["BONDING", "GRADUATED"]) }),
    quoteAsset: z.object({
      address: z.string(),
      symbol: z.string().nullable().openapi({ description: "Only set when the address is on an official registry; never inferred from the token's own symbol()." }),
      decimals: z.number().int(),
      identified: z.boolean(),
      usdFeed: z.string().nullable(),
    }),
    price: z.object({ native: Decimal.nullable(), lastTradeAt: z.string().nullable(), usd: Decimal.nullable(), usdBasis: z.string().nullable(), usdUnavailableReason: z.string().nullable() }),
    valuation: z.object({
      totalSupply: Decimal.nullable(),
      fdvNative: Decimal.nullable(),
      fdvUsd: Decimal.nullable(),
      basis: z.literal("TOTAL_SUPPLY_x_LAST_TRADE_PRICE"),
      circulatingSupply: z.null(),
      circulatingSupplyReason: z.string(),
    }),
    coverage: z.object({ from: z.string().nullable(), to: z.string().nullable(), truncated: z.boolean(), notes: z.array(z.string()) }),
    windows: z.array(WindowSchema),
    recentTrades: z.array(RecentTradeSchema),
    observedAt: z.string(),
  })
  .openapi("TokenMarketData");

export const TokenMarketDataResponseSchema = z
  .discriminatedUnion("status", [
    z.object({ apiVersion: z.literal(MARKET_DATA_API_VERSION), status: z.literal("AVAILABLE"), market: TokenMarketDataSchema }),
    z.object({ apiVersion: z.literal(MARKET_DATA_API_VERSION), status: z.literal("UNAVAILABLE"), reason: z.enum(["UNKNOWN_TOKEN", "DECIMALS_UNAVAILABLE", "DECIMALS_CONFLICT", "DATABASE_ONLY_DEPLOYMENT"]), detail: z.string() }),
  ])
  .openapi("TokenMarketDataResponse");
