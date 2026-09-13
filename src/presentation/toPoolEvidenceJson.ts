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

export function toPoolEvidenceUnavailableJson(reason: MissingReason, detail: string): PoolEvidenceResponse {
  return { apiVersion: POOL_EVIDENCE_API_VERSION, status: "UNAVAILABLE", reason, detail };
}
