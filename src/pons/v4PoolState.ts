/**
 * Phase 7D.3 §5 — Uniswap V4 pool evidence for graduated Pons V2 tokens.
 *
 * Pure decoding and math. No RPC, no I/O, so every rule here is directly testable against
 * the raw fixtures in `__fixtures__/v4PoolState.json`.
 *
 * Sources (see docs/phase-7d3-pool-evidence-research.md for the full matrix, accessed
 * 2026-09-12):
 *   - PoolKey field order/types  — Uniswap/v4-core src/types/PoolKey.sol
 *   - PoolId = keccak256(key)    — Uniswap/v4-core src/types/PoolId.sol
 *   - POOLS_SLOT / LIQUIDITY_OFFSET / slot0 bit layout
 *                                — Uniswap/v4-core src/libraries/StateLibrary.sol
 *
 * Two protocol facts drive the honesty rules below, both verified on-chain:
 *
 *   1. The Pons MemeHook does NOT implement beforeSwap, so core pool math genuinely
 *      describes the pool. Price and liquidity read here are real pool state.
 *   2. It DOES implement afterSwap with a returns-delta permission, and each launch
 *      carries `creatorTaxBps`. A seller therefore receives less than raw pool output.
 *      Nothing in this file may be presented as executable proceeds — see
 *      `PoolEvidence.executionCaveat`.
 *
 * Everything is BigInt. No float ever touches a price or an amount.
 */

import { keccak256, encodeAbiParameters, encodePacked, toHex } from "viem";

/** Bump when any decoding or derivation rule below changes. Stored with each observation. */
export const POOL_EVIDENCE_CALCULATION_VERSION = "v4-pons-1";

/** StateLibrary.sol: `bytes32 public constant POOLS_SLOT = bytes32(uint256(6));` */
const POOLS_SLOT = 6n;
/** StateLibrary.sol: `uint256 public constant LIQUIDITY_OFFSET = 3;` */
const LIQUIDITY_OFFSET = 3n;

/** LPFeeLibrary's dynamic-fee marker. A pool with this set has no fixed LP fee. */
const DYNAMIC_FEE_FLAG = 0x800000;

export interface PoolKey {
  /** Lower address, sorted numerically. */
  currency0: `0x${string}`;
  /** Higher address, sorted numerically. */
  currency1: `0x${string}`;
  fee: number;
  tickSpacing: number;
  hooks: `0x${string}`;
}

export interface Slot0 {
  sqrtPriceX96: bigint;
  tick: number;
  protocolFee: number;
  lpFee: number;
}

/** Why evidence is absent. Never silently omitted — §5 requires a reason code. */
export type MissingReason =
  | "POOL_NOT_INITIALIZED"
  | "NOT_GRADUATED"
  | "NO_LIQUIDITY"
  | "UNSUPPORTED_VENUE"
  | "RPC_UNAVAILABLE";

export interface PoolEvidence {
  poolId: `0x${string}`;
  poolKey: PoolKey;
  protocol: "uniswap-v4";
  /** Raw slot0 fields, exactly as stored on chain. */
  slot0: Slot0;
  /** Active in-range liquidity (uint128). */
  liquidity: bigint;
  /**
   * currency1 per currency0, scaled by 1e18. For Pons V2, currency0 is native ETH and
   * currency1 is the launched token, so this is "tokens per ETH".
   */
  priceC1PerC0X18: bigint;
  /** The inverse: native currency per whole token, scaled by 1e18. */
  priceC0PerC1X18: bigint;
  /** Fixed LP fee in hundredths of a bip, or null when the pool uses a dynamic fee. */
  lpFeeHundredthsBip: number | null;
  isDynamicFee: boolean;
  /** Basis points the hook takes after the swap. Not applied to any figure here. */
  creatorTaxBps: number | null;
  observedAtBlock: string;
  calculationVersion: string;
  /**
   * Why these numbers are not an executable quote. Always present for this venue, because
   * the afterSwap delta means realized proceeds differ from raw pool output.
   */
  executionCaveat: string;
}

/** Numerically sorted currency pair, as PoolKey requires. */
export function sortCurrencies(a: string, b: string): [`0x${string}`, `0x${string}`] {
  const lower = a.toLowerCase() as `0x${string}`;
  const upper = b.toLowerCase() as `0x${string}`;
  return BigInt(lower) < BigInt(upper) ? [lower, upper] : [upper, lower];
}

export function buildPoolKey(params: {
  tokenAddress: string;
  pairToken: string;
  poolFee: number;
  tickSpacing: number;
  hooks: string;
}): PoolKey {
  const [currency0, currency1] = sortCurrencies(params.pairToken, params.tokenAddress);
  return {
    currency0,
    currency1,
    fee: params.poolFee,
    tickSpacing: params.tickSpacing,
    hooks: params.hooks.toLowerCase() as `0x${string}`,
  };
}

/**
 * PoolId = keccak256 over the 5-slot PoolKey (v4-core PoolId.sol hashes 0xa0 bytes of
 * memory, which is the ABI encoding of the five fields).
 *
 * Verified 3/3 against poolIds this repo persisted from on-chain PoolGraduated events.
 */
export function poolIdFor(key: PoolKey): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]
    )
  );
}

/** StateLibrary._getPoolStateSlot: keccak256(abi.encodePacked(poolId, POOLS_SLOT)). */
export function poolStateSlot(poolId: `0x${string}`): `0x${string}` {
  return keccak256(encodePacked(["bytes32", "bytes32"], [poolId, toHex(POOLS_SLOT, { size: 32 })]));
}

/** The slot holding active liquidity: stateSlot + LIQUIDITY_OFFSET. */
export function liquiditySlot(stateSlot: `0x${string}`): `0x${string}` {
  return toHex(BigInt(stateSlot) + LIQUIDITY_OFFSET, { size: 32 });
}

/**
 * Unpack the slot0 word, following StateLibrary's assembly exactly:
 *   sqrtPriceX96 = data & (2^160 - 1)
 *   tick         = signextend(2, data >> 160)   // int24
 *   protocolFee  = (data >> 184) & 0xFFFFFF
 *   lpFee        = (data >> 208) & 0xFFFFFF
 */
export function decodeSlot0(word: `0x${string}` | bigint): Slot0 {
  const data = typeof word === "bigint" ? word : BigInt(word);
  const sqrtPriceX96 = data & ((1n << 160n) - 1n);
  const rawTick = (data >> 160n) & 0xffffffn;
  // int24 sign extension: values at or above 2^23 are negative.
  const tick = rawTick >= 0x800000n ? rawTick - 0x1000000n : rawTick;
  return {
    sqrtPriceX96,
    tick: Number(tick),
    protocolFee: Number((data >> 184n) & 0xffffffn),
    lpFee: Number((data >> 208n) & 0xffffffn),
  };
}

/** Active liquidity is the low 128 bits of its word. */
export function decodeLiquidity(word: `0x${string}` | bigint): bigint {
  const data = typeof word === "bigint" ? word : BigInt(word);
  return data & ((1n << 128n) - 1n);
}

const Q96 = 1n << 96n;
const Q192 = 1n << 192n;
const X18 = 10n ** 18n;

/**
 * price(currency1 per currency0) = (sqrtPriceX96 / 2^96)^2, scaled by 1e18.
 *
 * Computed entirely in integer space — multiply before shifting — so no float rounding
 * enters a price. Cross-checked against 1.0001^tick to within 1e-4 on live pools, which
 * is tick-grid resolution.
 */
export function priceC1PerC0X18(sqrtPriceX96: bigint): bigint {
  return (sqrtPriceX96 * sqrtPriceX96 * X18) / Q192;
}

/**
 * The inverse price, currency0 per currency1, scaled by 1e18.
 * Derived from sqrtPriceX96 directly rather than by inverting the scaled value above,
 * which would compound truncation.
 */
export function priceC0PerC1X18(sqrtPriceX96: bigint): bigint {
  if (sqrtPriceX96 === 0n) return 0n;
  return (Q192 * X18) / (sqrtPriceX96 * sqrtPriceX96);
}

export function isDynamicFee(fee: number): boolean {
  return (fee & DYNAMIC_FEE_FLAG) !== 0;
}

/**
 * The caveat attached to every observation for this venue.
 *
 * Kept as data rather than a UI string so the API, the terminal and any AI evidence
 * snapshot all carry the same sentence, and none of them can quietly drop it.
 */
export function executionCaveatFor(creatorTaxBps: number | null): string {
  const tax = creatorTaxBps === null ? "a creator tax" : `a ${(creatorTaxBps / 100).toFixed(2)}% creator tax`;
  return (
    `Pool state only. The Pons hook takes ${tax} after the swap (afterSwap returns-delta), ` +
    `so realized proceeds are below raw pool output. This is not an executable quote.`
  );
}

/**
 * Assemble evidence from already-fetched raw words.
 *
 * Fails closed: an uninitialized pool (sqrtPriceX96 == 0) yields a reason code rather than
 * a zero price, because "price 0" and "no pool" are very different claims.
 */
export function buildPoolEvidence(params: {
  poolKey: PoolKey;
  poolId: `0x${string}`;
  slot0Word: `0x${string}`;
  liquidityWord: `0x${string}`;
  creatorTaxBps: number | null;
  observedAtBlock: string;
}): { ok: true; evidence: PoolEvidence } | { ok: false; reason: MissingReason } {
  const slot0 = decodeSlot0(params.slot0Word);
  if (slot0.sqrtPriceX96 === 0n) {
    return { ok: false, reason: "POOL_NOT_INITIALIZED" };
  }

  const liquidity = decodeLiquidity(params.liquidityWord);
  const dynamic = isDynamicFee(params.poolKey.fee);

  return {
    ok: true,
    evidence: {
      poolId: params.poolId,
      poolKey: params.poolKey,
      protocol: "uniswap-v4",
      slot0,
      liquidity,
      priceC1PerC0X18: priceC1PerC0X18(slot0.sqrtPriceX96),
      priceC0PerC1X18: priceC0PerC1X18(slot0.sqrtPriceX96),
      lpFeeHundredthsBip: dynamic ? null : slot0.lpFee,
      isDynamicFee: dynamic,
      creatorTaxBps: params.creatorTaxBps,
      observedAtBlock: params.observedAtBlock,
      calculationVersion: POOL_EVIDENCE_CALCULATION_VERSION,
      executionCaveat: executionCaveatFor(params.creatorTaxBps),
    },
  };
}
