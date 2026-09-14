/**
 * Phase 7D.3.2 §5 — quote, simulation and paper-position contracts.
 *
 * Three different claims, three different shapes, and the names say which is which:
 *   Quote        — an estimate at one block (`status: QUOTED`)
 *   Simulation   — the real route run at that block from a synthetic account
 *   PaperPosition — a user's saved fill; `fillBasis` records which of the above backs it
 *
 * Amounts are decimal strings in base units, always. `decimals` travels with every amount
 * so no client ever assumes 18.
 */

import { z } from "./zodOpenApi";

export const PAPER_TRADING_API_VERSION = 1 as const;

const DecimalString = z.string().regex(/^\d+$/).openapi({ description: "Non-negative integer in base units, as a decimal string.", example: "10000000000000000" });

const BlockRefSchema = z
  .object({
    number: DecimalString,
    hash: z.string().openapi({ example: "0x6554d2c6d1a1b2f99b9782f9d4157c125b6d051129d859df0fdb4395751d4d25" }),
    timestamp: DecimalString.openapi({ description: "Block timestamp, Unix seconds." }),
  })
  .openapi("PinnedBlockRef");

const LimitationSchema = z.object({ code: z.string(), message: z.string() }).openapi("EvidenceLimitation");

const SourceReferenceSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["official-docs", "official-repo", "verified-contract", "fork-execution"]),
    ref: z.string(),
    version: z.string(),
    accessed: z.string(),
    reliedOn: z.string(),
  })
  .openapi("SourceReference");

const AssetAmountSchema = z
  .object({
    currency: z.string().openapi({ description: "Token address; 0x000…000 is native ETH." }),
    symbol: z.string().nullable(),
    decimals: z.number().int(),
    amount: DecimalString,
  })
  .openapi("AssetAmount");

const FeeLineSchema = z
  .object({
    kind: z.enum(["CURVE_PROTOCOL_FEE", "CURVE_CREATOR_TAX", "HOOK_FEE", "HOOK_CREATOR_TAX"]),
    bps: z.number().int(),
    currency: z.string(),
    chargedOn: z.enum(["INPUT", "OUTPUT"]),
    amount: z.object({
      min: DecimalString,
      max: DecimalString,
      exact: z.boolean().openapi({ description: "False when integer rounding leaves the split known only to within a range (at most 1 base unit)." }),
    }),
  })
  .openapi("QuoteFeeLine");

const PoolKeySchema = z
  .object({ currency0: z.string(), currency1: z.string(), fee: z.number().int(), tickSpacing: z.number().int(), hooks: z.string() })
  .openapi("QuotePoolKey");

export const VenueSchema = z.enum(["PONS_V2_BONDING_CURVE", "PONS_V2_UNISWAP_V4"]).openapi("QuoteVenue");

export const PonsQuoteSchema = z
  .object({
    chain: z.literal("robinhood"),
    chainId: z.number().int(),
    tokenAddress: z.string(),
    side: z.enum(["buy", "sell"]),
    venue: VenueSchema,
    method: z.enum(["CURVE_FORMULA_AT_PINNED_BLOCK", "V4_QUOTER_ETH_CALL"]),
    input: AssetAmountSchema,
    output: AssetAmountSchema.extend({
      expected: DecimalString.openapi({ description: "Expected output, already net of every fee." }),
      minimum: DecimalString.openapi({ description: "Expected output reduced by the slippage tolerance. A transaction below it reverts." }),
    }),
    spent: DecimalString.openapi({ description: "Input the venue keeps. Below input.amount only for a clamped curve buy." }),
    refund: DecimalString,
    slippageBps: z.number().int(),
    fees: z.array(FeeLineSchema),
    priceImpact: z.object({
      allInBps: z.number().int().openapi({ description: "Shortfall versus the pre-trade price, fees included." }),
      poolOnlyBps: z.number().int().nullable().openapi({ description: "Pool price movement alone, excluding hook fees. Null for curve quotes." }),
      spotOutPerInX36: DecimalString.openapi({ description: "Pre-trade spot, output base units per input base unit, scaled by 1e36." }),
    }),
    block: BlockRefSchema,
    quotedAt: z.string(),
    expiresAt: z.string(),
    calculationVersion: z.string(),
    policyVersion: z.string(),
    venueState: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("curve"),
        curve: z.string(),
        quoteReserve: DecimalString.openapi({ description: "Virtual + real quote reserve that prices curve trades. Not an ETH balance." }),
        tokenReserve: DecimalString,
        sellableTokens: DecimalString,
        graduationThreshold: DecimalString,
        trackedQuote: DecimalString.openapi({ description: "Real quote asset the curve holds from trading." }),
      }),
      z.object({
        kind: z.literal("pool"),
        poolId: z.string(),
        poolKey: PoolKeySchema,
        sqrtPriceX96: DecimalString,
        tick: z.number().int(),
        activeLiquidityRaw: DecimalString.openapi({
          description: "Uniswap V4 active liquidity L. An advanced protocol parameter — not ETH reserves, not dollars, not available sell proceeds.",
        }),
        quoter: z.string(),
        quoterGasEstimate: DecimalString,
      }),
    ]),
    warnings: z.array(LimitationSchema),
    limitations: z.array(LimitationSchema),
    sourceReferences: z.array(SourceReferenceSchema),
  })
  .openapi("PonsQuote");

export const QuoteRequestSchema = z
  .object({
    side: z.enum(["buy", "sell"]),
    amount: DecimalString.openapi({ description: "Exact input in the input asset's base units (pair asset for buys, token for sells)." }),
    slippageBps: z.number().int().min(1).max(5_000),
  })
  .openapi("QuoteRequest");

const Unavailable = z.object({
  apiVersion: z.literal(PAPER_TRADING_API_VERSION),
  status: z.literal("UNAVAILABLE"),
  reason: z.string(),
  detail: z.string(),
  retryable: z.literal(true),
});

export const QuoteResponseSchema = z
  .discriminatedUnion("status", [
    z.object({ apiVersion: z.literal(PAPER_TRADING_API_VERSION), status: z.literal("QUOTED"), snapshotId: z.string(), quote: PonsQuoteSchema }),
    z.object({
      apiVersion: z.literal(PAPER_TRADING_API_VERSION),
      status: z.literal("UNSUPPORTED"),
      snapshotId: z.string(),
      reason: z.string(),
      detail: z.string(),
      venue: VenueSchema.nullable(),
      block: BlockRefSchema.nullable(),
    }),
    Unavailable,
  ])
  .openapi("QuoteResponse");

export const SimulationRequestSchema = z.object({ quoteId: z.string().uuid() }).openapi("SimulationRequest");

export const SimulationSchema = z
  .object({
    status: z.enum(["SIMULATED", "REVERTED"]),
    block: BlockRefSchema,
    simulatedAt: z.string(),
    method: z.literal("ETH_CALL_STATE_OVERRIDE"),
    route: z.object({ kind: z.enum(["UNIVERSAL_ROUTER", "BONDING_CURVE"]), target: z.string() }),
    account: z.string().openapi({ description: "Synthetic account the route ran from. Not your wallet." }),
    simulator: z.object({ sourceSha256: z.string(), runtimeCodeHash: z.string() }),
    inputBalanceOverride: z.object({ currency: z.string(), slot: z.string().nullable() }),
    result: z.object({
      success: z.boolean(),
      spent: DecimalString,
      received: DecimalString,
      gasUsed: DecimalString,
      expectedOut: DecimalString,
      minimumOut: DecimalString,
      matchesQuote: z.boolean(),
      revert: z.object({ selector: z.string(), data: z.string(), meaning: z.string().nullable() }).nullable(),
    }),
    calculationVersion: z.string(),
    limitations: z.array(LimitationSchema),
  })
  .openapi("RouteSimulation");

export const SimulationResponseSchema = z
  .discriminatedUnion("status", [
    z.object({ apiVersion: z.literal(PAPER_TRADING_API_VERSION), status: z.literal("SIMULATED"), snapshotId: z.string(), quoteId: z.string(), simulation: SimulationSchema }),
    z.object({ apiVersion: z.literal(PAPER_TRADING_API_VERSION), status: z.literal("REVERTED"), snapshotId: z.string(), quoteId: z.string(), simulation: SimulationSchema }),
    z.object({
      apiVersion: z.literal(PAPER_TRADING_API_VERSION),
      status: z.literal("UNSUPPORTED"),
      snapshotId: z.string(),
      quoteId: z.string(),
      reason: z.string(),
      detail: z.string(),
    }),
    Unavailable,
  ])
  .openapi("SimulationResponse");

export const EvidenceSnapshotSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["QUOTE", "SIMULATION"]),
    status: z.string(),
    chain: z.string(),
    tokenAddress: z.string(),
    side: z.string(),
    parentId: z.string().nullable(),
    block: BlockRefSchema.nullable(),
    observedAt: z.string(),
    expiresAt: z.string().nullable(),
    calculationVersion: z.string().nullable(),
    policyVersion: z.string(),
    payloadSha256: z.string(),
    payload: z.record(z.string(), z.unknown()),
    sourceReferences: z.array(SourceReferenceSchema),
    missingEvidence: z.array(z.object({ code: z.string(), detail: z.string() })),
    createdAt: z.string(),
  })
  .openapi("EvidenceSnapshot");

export const EvidenceSnapshotParamSchema = z.object({ snapshotId: z.string().uuid() }).openapi("EvidenceSnapshotParam");

export const CreatePaperPositionRequestSchema = z
  .object({
    quoteId: z.string().uuid(),
    simulationId: z.string().uuid().nullable().openapi({ description: "A successful simulation of the same quote. Omit to save a quote-based fill." }),
  })
  .openapi("CreatePaperPositionRequest");

export const PaperPositionSchema = z
  .object({
    id: z.string(),
    chain: z.string(),
    tokenAddress: z.string(),
    side: z.enum(["buy", "sell"]),
    venue: VenueSchema,
    fillBasis: z.enum(["EXECUTION_SIMULATION", "QUOTE"]),
    input: AssetAmountSchema,
    output: AssetAmountSchema,
    minimumOutput: DecimalString,
    createdAt: z.string(),
    quote: EvidenceSnapshotSchema,
    simulation: EvidenceSnapshotSchema.nullable(),
    paper: z.literal(true).openapi({ description: "Always true. Nothing here was signed or broadcast." }),
  })
  .openapi("PaperPosition");

export const PaperPositionResponseSchema = z
  .object({ apiVersion: z.literal(PAPER_TRADING_API_VERSION), created: z.boolean(), position: PaperPositionSchema })
  .openapi("PaperPositionResponse");

export const PaperPositionListResponseSchema = z
  .object({ apiVersion: z.literal(PAPER_TRADING_API_VERSION), positions: z.array(PaperPositionSchema), observedAt: z.string() })
  .openapi("PaperPositionListResponse");

// --- Market evidence (Phase 7D.3.2 §4) ---

const DepthRowSchema = z
  .object({
    side: z.enum(["buy", "sell"]),
    amountIn: DecimalString,
    expectedOut: DecimalString.nullable(),
    allInImpactBps: z.number().int().nullable(),
    unavailableReason: z.string().nullable(),
  })
  .openapi("MarketDepthRow");

export const MarketEvidenceSchema = z
  .object({
    chain: z.literal("robinhood"),
    tokenAddress: z.string(),
    phase: z.object({ code: z.enum(["BONDING_CURVE", "GRADUATION_IN_PROGRESS", "UNISWAP_V4_POOL", "RESCUED"]), onChainValue: z.number().int() }),
    venue: VenueSchema,
    block: BlockRefSchema,
    observedAt: z.string().openapi({ description: "When the chain was read. Responses may be shared for a few seconds; this never changes on a cached copy." }),
    calculationVersion: z.string(),
    token: z.object({ symbol: z.string().nullable(), decimals: z.number().int() }),
    pairAsset: z.object({ currency: z.string(), symbol: z.string().nullable(), decimals: z.number().int() }),
    spotPrice: z.object({
      pairBaseUnitsPerWholeTokenX36: DecimalString.openapi({ description: "Pair-asset base units per one whole token, scaled by 1e36. Divide by 1e36 × 10^pairAsset.decimals for pair-asset units." }),
      method: z.enum(["CURVE_RESERVES", "POOL_SQRT_PRICE"]),
    }),
    fees: z.array(z.object({ kind: z.enum(["CURVE_PROTOCOL_FEE", "CURVE_CREATOR_TAX", "HOOK_FEE", "HOOK_CREATOR_TAX"]), bps: z.number().int(), source: z.string() })),
    curve: z
      .object({
        address: z.string(),
        realQuoteHeld: DecimalString.openapi({ description: "Quote asset the curve actually holds from trading (excludes virtual reserve and pending fees)." }),
        graduationThreshold: DecimalString,
        graduationProgressBps: z.number().int(),
        sellableTokens: DecimalString,
        snipeWindowOpen: z.boolean(),
      })
      .nullable(),
    depth: z.object({
      method: z.enum(["CURVE_FORMULA_AT_PINNED_BLOCK", "V4_QUOTER_ETH_CALL"]),
      referenceReserve: DecimalString.openapi({ description: "Pair-side reserve the reference sizes (0.1%, 1%, 5%) are taken from." }),
      rows: z.array(DepthRowSchema),
    }),
    advanced: z.object({
      poolId: z.string().nullable(),
      poolKey: PoolKeySchema.nullable(),
      sqrtPriceX96: DecimalString.nullable(),
      tick: z.number().int().nullable(),
      activeLiquidityRaw: DecimalString.nullable().openapi({ description: "Uniswap V4 active liquidity L. Advanced protocol parameter — never ETH reserves, USD or sell proceeds." }),
      lpFeeHundredthsBip: z.number().int().nullable(),
      curveQuoteReserveIncludingVirtual: DecimalString.nullable(),
      curveTokenReserve: DecimalString.nullable(),
    }),
    usd: z.object({ available: z.literal(false), reason: z.string() }),
    missingEvidence: z.array(z.object({ code: z.string(), detail: z.string() })),
    limitations: z.array(LimitationSchema),
    sourceReferences: z.array(SourceReferenceSchema),
  })
  .openapi("MarketEvidence");

export const MarketEvidenceResponseSchema = z
  .discriminatedUnion("status", [
    z.object({ apiVersion: z.literal(PAPER_TRADING_API_VERSION), status: z.literal("AVAILABLE"), evidence: MarketEvidenceSchema }),
    z.object({
      apiVersion: z.literal(PAPER_TRADING_API_VERSION),
      status: z.literal("UNSUPPORTED"),
      reason: z.enum(["UNKNOWN_TOKEN", "PROTOCOL_MISMATCH", "GRADUATION_IN_PROGRESS", "RESCUED", "POOL_REGISTRATION_INCONSISTENT"]),
      detail: z.string(),
      block: BlockRefSchema.nullable(),
    }),
    Unavailable,
  ])
  .openapi("MarketEvidenceResponse");
