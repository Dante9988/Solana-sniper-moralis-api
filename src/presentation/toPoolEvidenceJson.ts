/**
 * Phase 7D.3 §5 — projection from the BigInt domain object to the HTTP shape.
 *
 * Pure and total: one function, no I/O, so the "every large value becomes a decimal
 * string" rule is testable in isolation. The domain object holds BigInts precisely because
 * `sqrtPriceX96` and `liquidity` exceed Number.MAX_SAFE_INTEGER; letting one reach
 * `res.json` as a number would either throw or silently lose precision.
 */

import type { PoolEvidence } from "../pons/v4PoolState";
import type { MissingReason } from "../pons/v4PoolState";
import { POOL_EVIDENCE_API_VERSION, type PoolEvidenceResponse } from "../researchApi/contracts/poolEvidence";

/** Currency0 is native ETH for every Pons V2 pool (pairToken is 0x0 — verified on-chain). */
const NATIVE_ZERO = "0x0000000000000000000000000000000000000000";

export function nativeSymbolFor(currency0: string): string {
  return currency0.toLowerCase() === NATIVE_ZERO ? "ETH" : "WETH";
}

export function toPoolEvidenceJson(evidence: PoolEvidence): PoolEvidenceResponse {
  return {
    apiVersion: POOL_EVIDENCE_API_VERSION,
    status: "AVAILABLE",
    evidence: {
      poolId: evidence.poolId,
      poolKey: {
        currency0: evidence.poolKey.currency0,
        currency1: evidence.poolKey.currency1,
        fee: evidence.poolKey.fee,
        tickSpacing: evidence.poolKey.tickSpacing,
        hooks: evidence.poolKey.hooks,
      },
      protocol: evidence.protocol,
      slot0: {
        sqrtPriceX96: evidence.slot0.sqrtPriceX96.toString(),
        tick: evidence.slot0.tick,
        protocolFee: evidence.slot0.protocolFee,
        lpFee: evidence.slot0.lpFee,
      },
      liquidity: evidence.liquidity.toString(),
      priceC1PerC0X18: evidence.priceC1PerC0X18.toString(),
      priceC0PerC1X18: evidence.priceC0PerC1X18.toString(),
      nativeSymbol: nativeSymbolFor(evidence.poolKey.currency0),
      lpFeeHundredthsBip: evidence.lpFeeHundredthsBip,
      isDynamicFee: evidence.isDynamicFee,
      creatorTaxBps: evidence.creatorTaxBps,
      observedAtBlock: evidence.observedAtBlock,
      calculationVersion: evidence.calculationVersion,
      executionCaveat: evidence.executionCaveat,
    },
  };
}

/**
 * Stable, safe public messages — one per reason code (Phase 7D.3.1 §1).
 *
 * Provider errors are verbose and leaky: viem's text carries the request URL (which holds
 * the API key), the encoded calldata, and the contract call shape. Even with URLs
 * redacted, forwarding that to a browser publishes internal structure and changes wording
 * whenever a provider or library is upgraded, so clients cannot depend on it.
 *
 * The machine-readable `reason` is the contract; this is the human sentence. Raw provider
 * text stays server-side, where it is useful for operators.
 */
const PUBLIC_DETAIL: Record<MissingReason, string> = {
  NOT_GRADUATED: "This token has not graduated to a Uniswap V4 pool yet.",
  POOL_NOT_INITIALIZED: "The pool exists but has not been initialized with a price.",
  NO_LIQUIDITY: "The pool holds no in-range liquidity.",
  UNSUPPORTED_VENUE: "This token was not launched through a venue whose pool state we can read.",
  RPC_UNAVAILABLE: "Chain data is temporarily unavailable. This is a connectivity problem, not a fact about the token.",
};

export function publicDetailFor(reason: MissingReason): string {
  return PUBLIC_DETAIL[reason] ?? PUBLIC_DETAIL.RPC_UNAVAILABLE;
}

/**
 * @param internalDetail Raw diagnostic text. NEVER placed in the response — pass it to a
 *                       logger if you need it; it is accepted here only so call sites do
 *                       not have to remember to drop it.
 */
export function toPoolEvidenceUnavailableJson(
  reason: MissingReason,
  internalDetail?: string
): PoolEvidenceResponse {
  void internalDetail;
  return {
    apiVersion: POOL_EVIDENCE_API_VERSION,
    status: "UNAVAILABLE",
    reason,
    detail: publicDetailFor(reason),
  };
}
