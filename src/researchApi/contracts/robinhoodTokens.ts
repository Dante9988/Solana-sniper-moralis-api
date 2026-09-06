/**
 * Phase 7B.4 §4.7 — GET /api/v1/tokens/robinhood contracts. Every amount is
 * a decimal-safe string (never a JS number) — see phase7b4.txt §5 and this
 * repo's own DiscoveredToken/ChainTrade Decimal columns.
 */

import { z } from "./zodOpenApi";

export const RobinhoodTokenAddressParamSchema = z
  .object({
    tokenAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).openapi({ example: "0x055650555Be80649397084Cd3f8a09b4350e8612" }),
  })
  .openapi("RobinhoodTokenAddressParam");

export const DiscoveredTokenSchema = z
  .object({
    chain: z.literal("robinhood"),
    venue: z.string(),
    tokenAddress: z.string(),
    deployer: z.string(),
    poolAddress: z.string().nullable(),
    quoteAddress: z.string(),
    supply: z.string(),
    initialBuyAmount: z.string(),
    sourceHeight: z.string(),
    sourceHash: z.string(),
    sourceTxHash: z.string(),
    sourceIndex: z.number().int(),
    observedAt: z.string(),
    graduated: z.boolean(),
    graduationPairedPrincipal: z.string().nullable(),
    graduationThreshold: z.string().nullable(),
    graduationCheckedAt: z.string().nullable(),
  })
  .openapi("DiscoveredToken");

export const ChainTradeSchema = z
  .object({
    chain: z.literal("robinhood"),
    venue: z.string(),
    tokenAddress: z.string(),
    poolAddress: z.string().nullable(),
    side: z.enum(["buy", "sell"]),
    tokenAmount: z.string(),
    quoteAmount: z.string(),
    quoteAddress: z.string(),
    priceQuote: z.string(),
    trader: z.string(),
    sourceHeight: z.string(),
    sourceHash: z.string(),
    sourceTxHash: z.string(),
    sourceIndex: z.number().int(),
    observedAt: z.string(),
  })
  .openapi("ChainTrade");

export const RobinhoodTokenListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  cursor: z.string().datetime().optional(),
});

export const RobinhoodTokenListResponseSchema = z
  .object({
    tokens: z.array(DiscoveredTokenSchema),
    nextCursor: z.string().nullable(),
    observedAt: z.string(),
  })
  .openapi("RobinhoodTokenListResponse");

export const RobinhoodTradeListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});

export const RobinhoodTokenDetailResponseSchema = z
  .object({
    token: DiscoveredTokenSchema,
    trades: z.array(ChainTradeSchema),
    observedAt: z.string(),
  })
  .openapi("RobinhoodTokenDetailResponse");
