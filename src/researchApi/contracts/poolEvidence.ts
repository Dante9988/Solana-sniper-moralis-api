/**
 * Phase 7D.3 §5 — `GET /api/v1/tokens/robinhood/:tokenAddress/pool` contract.
 *
 * Two rules shape this schema:
 *
 * 1. **Decimal-safe.** `sqrtPriceX96`, `liquidity` and the scaled prices all exceed
 *    Number.MAX_SAFE_INTEGER. They are strings here, as every other amount in this API is
 *    (phase7b4.txt §5) — a JS number would silently lose precision.
 *
 * 2. **Unavailable is a first-class result, not an error.** A pre-graduation token has no
 *    V4 pool; that is a fact about the token, not a failure. The response always carries
 *    `status`, and when it is UNAVAILABLE it carries a machine-readable `reason` so the UI
 *    can say "Awaiting liquidity" rather than rendering a blank or a zero.
 */

import { z } from "./zodOpenApi";

export const POOL_EVIDENCE_API_VERSION = 1 as const;

export const PoolEvidenceMissingReasonSchema = z
  .enum(["POOL_NOT_INITIALIZED", "NOT_GRADUATED", "NO_LIQUIDITY", "UNSUPPORTED_VENUE", "RPC_UNAVAILABLE"])
  .openapi("PoolEvidenceMissingReason");

export const PoolKeySchema = z
  .object({
    currency0: z.string().openapi({ description: "Lower-sorted currency. Native ETH (0x0) for Pons V2." }),
    currency1: z.string().openapi({ description: "Higher-sorted currency — the launched token for Pons V2." }),
    fee: z.number().int().openapi({ description: "Fixed LP fee in hundredths of a bip, or the dynamic-fee marker." }),
    tickSpacing: z.number().int(),
    hooks: z.string(),
  })
  .openapi("PoolKey");

export const Slot0Schema = z
  .object({
    sqrtPriceX96: z.string().openapi({ description: "Decimal string — exceeds Number.MAX_SAFE_INTEGER." }),
    tick: z.number().int(),
    protocolFee: z.number().int(),
    lpFee: z.number().int(),
  })
  .openapi("PoolSlot0");

export const PoolEvidenceSchema = z
  .object({
    poolId: z.string(),
    poolKey: PoolKeySchema,
    protocol: z.literal("uniswap-v4"),
    slot0: Slot0Schema,
    liquidity: z.string().openapi({ description: "Active in-range liquidity (uint128), decimal string." }),
    priceC1PerC0X18: z
      .string()
      .openapi({ description: "currency1 per currency0, scaled by 1e18. Decimal string." }),
    priceC0PerC1X18: z
      .string()
      .openapi({ description: "currency0 per currency1, scaled by 1e18 — native per whole token." }),
    nativeSymbol: z.string().openapi({ description: "Symbol for currency0, e.g. ETH.", example: "ETH" }),
    lpFeeHundredthsBip: z
      .number()
      .int()
      .nullable()
      .openapi({ description: "Null when the pool uses a dynamic fee. 0 is a real zero fee, not unknown." }),
    isDynamicFee: z.boolean(),
    creatorTaxBps: z
      .number()
      .int()
      .nullable()
      .openapi({ description: "Basis points the hook takes AFTER the swap. Not applied to any figure here." }),
    observedAtBlock: z.string(),
    calculationVersion: z.string(),
    executionCaveat: z.string().openapi({
      description:
        "Why these numbers are not an executable quote. Always present for this venue — the Pons hook takes an after-swap delta, so realized proceeds are below raw pool output.",
    }),
    // USD is deliberately absent. No trustworthy conversion exists for this chain, and
    // phase7d3.txt forbids fabricating one.
  })
  .openapi("PoolEvidence");

export const PoolEvidenceResponseSchema = z
  .discriminatedUnion("status", [
    z.object({
      apiVersion: z.literal(POOL_EVIDENCE_API_VERSION),
      status: z.literal("AVAILABLE"),
      evidence: PoolEvidenceSchema,
    }),
    z.object({
      apiVersion: z.literal(POOL_EVIDENCE_API_VERSION),
      status: z.literal("UNAVAILABLE"),
      reason: PoolEvidenceMissingReasonSchema,
      detail: z.string(),
    }),
  ])
  .openapi("PoolEvidenceResponse");

export type PoolEvidenceResponse = z.infer<typeof PoolEvidenceResponseSchema>;
