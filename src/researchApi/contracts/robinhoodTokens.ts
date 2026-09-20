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

/**
 * Phase 7D.4 — live market state read from contract state at one pinned block (see
 * src/pons/market/marketSnapshot.ts). Quote amounts are whole-unit decimal strings; USD values are
 * null unless a verified Chainlink rate existed at that block.
 */
export const TokenMarketSchema = z
  .object({
    status: z.enum(["PENDING", "OK", "FAILED", "UNSUPPORTED"]),
    reason: z.string().nullable(),
    venue: z.enum(["PONS_V2_BONDING_CURVE", "UNISWAP_V4_POOL"]).nullable(),
    blockNumber: z.string().nullable(),
    asOf: z.string().nullable().openapi({ description: "Timestamp of the block the values were read at." }),
    priceQuote: z.string().nullable().openapi({ description: "Whole quote units per whole token (spot)." }),
    priceUsd: z.string().nullable(),
    marketCapQuote: z.string().nullable().openapi({ description: "Total supply × spot price, in whole quote units." }),
    marketCapUsd: z.string().nullable(),
    liquidityQuote: z.string().nullable(),
    liquidityUsd: z.string().nullable(),
    liquidityBasis: z.enum(["CURVE_REAL_QUOTE", "POOL_FULL_RANGE_EQUIVALENT"]).nullable(),
    bondingProgressPct: z.number().nullable().openapi({ description: "Share of the curve's sellable allocation bought out (graduation triggers at 100)." }),
    quoteRaised: z.string().nullable(),
    graduationThreshold: z.string().nullable(),
    readyToGraduate: z.boolean(),
    marketCapChange1hUsd: z.string().nullable(),
    marketCapChange1hPct: z.string().nullable(),
    /** Trade-volume windows from indexed trades; null until computed while indexing covers the present. */
    volume5mUsd: z.string().nullable(),
    volume1hUsd: z.string().nullable(),
    volumeBaselineHourlyUsd: z.string().nullable().openapi({ description: "Average hourly USD volume over the six hours before the last hour." }),
    volumeSurge: z.string().nullable().openapi({ description: "Last-hour volume ÷ that baseline (baseline floored at $50)." }),
    trades1h: z.number().int().nullable(),
    buys1h: z.number().int().nullable(),
    sells1h: z.number().int().nullable(),
    traders1h: z.number().int().nullable(),
    trendingScore: z.string().nullable(),
    usdSource: z.string().nullable(),
  })
  .openapi("TokenMarket");

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
    /** Phase 7D.4 — the pair asset, identified only from official address registries (never from its own symbol()). */
    quoteAsset: z
      .object({
        identified: z.boolean(),
        symbol: z.string().nullable(),
        name: z.string().nullable(),
        decimals: z.number().int().nullable(),
        kind: z.enum(["native", "wrapped-native", "stablecoin", "stock-token"]).nullable(),
        usdFeed: z.string().nullable(),
      })
      .openapi("QuoteAssetRef"),
    /** Standard ERC-20 name()/symbol() — same enrichment tick as supply. Null while enrichment is PENDING. */
    name: z.string().nullable(),
    symbol: z.string().nullable(),
    /** The launcher-supplied URL, for provenance only. Never render it directly. */
    logoUrl: z.string().nullable(),
    /** Phase 7D.3.2 §6 — the logo as served from OnlyPump's origin. Render `url` only when `status` is READY. */
    logo: z
      .object({
        url: z.string().nullable().openapi({ description: "Relative to the API origin. Null when the token has no logo." }),
        status: z.enum(["NONE", "PENDING", "READY", "FAILED", "REJECTED"]),
      })
      .openapi("TokenLogo"),
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
    /** Phase 7D.4 — null until the first snapshot is queued. */
    market: TokenMarketSchema.nullable(),
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
  /** Opaque: pass back `nextCursor` unchanged. */
  cursor: z.string().max(64).optional(),
  /**
   * Phase 7D.4 — server-side filters, so counts and pages describe the filtered set.
   * `almost-bonded`: still bonding, some of the allocation sold, ordered by progress.
   * `trending`: a trade-volume surge over the last hour (see `trending` in the response), strongest first.
   */
  lifecycle: z.enum(["all", "bonding", "graduated", "almost-bonded", "trending"]).optional().default("all"),
  /** Defaults: `new` (all/bonding/graduated), `progress` (almost-bonded), `trending` (trending). */
  sort: z.enum(["new", "marketCap", "liquidity", "progress", "change1h", "volume1h", "trending"]).optional(),
  q: z.string().trim().max(64).optional(),
});

export const RobinhoodTokenListResponseSchema = z
  .object({
    tokens: z.array(DiscoveredTokenSchema),
    nextCursor: z.string().nullable(),
    /** Phase 7D.4 — rows matching the filters (canonical only), for honest result counts. */
    total: z.number().int(),
    /** Phase 7D.4 — present for lifecycle=trending: whether indexed trades cover the present, and why not. */
    trending: z
      .object({
        available: z.boolean(),
        basis: z.literal("TRADE_VOLUME"),
        indexedUntil: z.string().nullable(),
        lagSeconds: z.number().int().nullable(),
        reason: z.string().nullable(),
        computedAt: z.string(),
      })
      .optional(),
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
    /** Kept for clients written against Phase 7B.5A; both also appear in `streams`. */
    discovery: SourceHealthDetailSchema,
    trades: SourceHealthDetailSchema,
    /** Phase 7D.5 — every ingestion stream, including the pons_v2 ones the product runs on. */
    streams: z.array(SourceHealthDetailSchema),
    /** Phase 7D.5 — the live observation session; `id` is null in `resume` mode. */
    session: z.object({
      mode: z.string(),
      id: z.string().nullable(),
      startBlock: z.string().nullable(),
      startTimestamp: z.string().nullable(),
    }),
    observedAt: z.string(),
  })
  .openapi("RobinhoodStatusResponse");

/** Phase 7D.4 — which chains have discovery in this deployment, so clients never imply a missing one. */
export const DiscoveryChainsResponseSchema = z
  .object({
    chains: z.array(
      z.object({
        chain: z.enum(["robinhood", "solana"]),
        discovery: z.enum(["AVAILABLE", "UNAVAILABLE"]),
        providers: z.array(z.object({ id: z.string(), label: z.string(), status: z.enum(["AVAILABLE", "UNAVAILABLE"]), reason: z.string().nullable() })),
        reason: z.string().nullable(),
      })
    ),
  })
  .openapi("DiscoveryChainsResponse");
