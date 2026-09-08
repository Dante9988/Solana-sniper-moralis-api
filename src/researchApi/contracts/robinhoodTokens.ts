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

/** Phase 7D §1 — Pons V2 metadata socials, decoded from the launch transaction itself (never contract storage — see abiV2.ts). Any field may be an empty string if the launcher left it blank; the whole object is null-valued (all fields null) when richMetadataStatus is "UNAVAILABLE". */
export const TokenSocialsSchema = z
  .object({
    website: z.string().nullable(),
    twitter: z.string().nullable(),
    telegram: z.string().nullable(),
    discord: z.string().nullable(),
    farcaster: z.string().nullable(),
  })
  .openapi("TokenSocials");

export const DiscoveredTokenSchema = z
  .object({
    chain: z.literal("robinhood"),
    venue: z.string(),
    tokenAddress: z.string(),
    deployer: z.string(),
    poolAddress: z.string().nullable(),
    /** Phase 7D §3 — Pons V2's bonding-curve contract address (pre-graduation). Null for V1/other venues. */
    curveAddress: z.string().nullable(),
    quoteAddress: z.string(),
    /** Standard ERC-20 name()/symbol() — same enrichment tick as supply. Null while enrichment is PENDING. */
    name: z.string().nullable(),
    symbol: z.string().nullable(),
    logoUrl: z.string().nullable(),
    description: z.string().nullable(),
    socials: TokenSocialsSchema,
    /** "FOUND" | "UNAVAILABLE" | null (V1 tokens, which have no metadata pipeline yet) — a one-shot outcome, never retried once set (see discoveryV2Listener.ts). */
    richMetadataStatus: z.enum(["FOUND", "UNAVAILABLE"]).nullable(),
    /** Null while enrichment (Phase 7B.5A §4/§9) is still PENDING — never a fabricated default. */
    supply: z.string().nullable(),
    /** COMPLETE once getLaunchedToken() enrichment has succeeded; PENDING while it is retried on later discovery ticks. */
    enrichmentStatus: z.enum(["COMPLETE", "PENDING"]),
    initialBuyAmount: z.string(),
    sourceHeight: z.string(),
    sourceHash: z.string(),
    sourceTxHash: z.string(),
    sourceIndex: z.number().int(),
    observedAt: z.string(),
    graduated: z.boolean(),
    /** V1 only (polled graduationStatus()) — stay null for Pons V2 rows. */
    graduationPairedPrincipal: z.string().nullable(),
    graduationThreshold: z.string().nullable(),
    graduationCheckedAt: z.string().nullable(),
    /** Phase 7D §2 — Pons V2's event-sourced graduation (PoolGraduated), never polled. Null until it fires. */
    graduationPositionId: z.string().nullable(),
    graduationTokenAmount: z.string().nullable(),
    graduationPairTokenAmount: z.string().nullable(),
    /** The Uniswap V4 PoolId, captured from the Initialize log accompanying graduation. Null until then. */
    poolId: z.string().nullable(),
  })
  .openapi("DiscoveredToken");

export const ChainTradeSchema = z
  .object({
    chain: z.literal("robinhood"),
    venue: z.string(),
    tokenAddress: z.string(),
    poolAddress: z.string().nullable(),
    /** Phase 7D §2 — set instead of poolAddress for Uniswap V4 trades (no discrete per-pool contract — singleton PoolManager keyed by PoolId). */
    poolId: z.string().nullable(),
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

/** Phase 7B.5A §5 — backend-owned ingestion source-health projection (src/pons/sourceHealth.ts). Never exposes RPC credentials, raw provider URLs, stack traces, or internal database errors — see that module's redaction discipline. */
export const IngestionHealthStatusSchema = z.enum(["LIVE", "LAGGING", "DEGRADED", "REORG_RECOVERY", "UNAVAILABLE"]);

export const SourceHealthDetailSchema = z
  .object({
    source: z.string(),
    status: IngestionHealthStatusSchema,
    lastHeight: z.string().nullable(),
    lastObservedChainHeight: z.string().nullable(),
    blocksBehind: z.string().nullable(),
    lastPollAt: z.string().nullable(),
    lastSuccessAt: z.string().nullable(),
    secondsSinceLastSuccess: z.number().int().nullable(),
    lastError: z.string().nullable(),
    lastErrorAt: z.string().nullable(),
    unresolvedReorg: z.boolean(),
  })
  .openapi("SourceHealthDetail");

export const RobinhoodStatusResponseSchema = z
  .object({
    status: IngestionHealthStatusSchema,
    discovery: SourceHealthDetailSchema,
    trades: SourceHealthDetailSchema,
    observedAt: z.string(),
  })
  .openapi("RobinhoodStatusResponse");
