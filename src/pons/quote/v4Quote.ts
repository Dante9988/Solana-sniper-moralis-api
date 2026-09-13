/**
 * Phase 7D.3.2 §2/§5 — pure helpers around the official V4Quoter for graduated Pons pools.
 *
 * The number a user relies on (`expectedOut`) comes from the deployed V4Quoter, never from
 * here. This file only derives what the quoter does not return, and each derivation is
 * pinned to fork evidence (src/pons/__fixtures__/forkEvidence/v4-exact-input.jsonl):
 *
 *   - direction, from the hook's own `memecoinIsCurrency0` — 35 of 164 graduated pools at
 *     the pinned block have the memecoin as currency0, so "native is currency0" is wrong;
 *   - the fee split, from the hook's per-pool `hookFeeBps` + `creatorTaxBps`, charged on
 *     the unspecified (output) leg of an exact-input swap;
 *   - minimum output for a slippage tolerance;
 *   - price impact against the pool's spot price;
 *   - UniversalRouter calldata, exactly as a wallet would submit it.
 */

import { encodeAbiParameters, encodePacked, type Hex } from "viem";

import { UNIVERSAL_ROUTER_COMMANDS, V4_ROUTER_ACTIONS } from "./protocol";

const BPS = 10_000n;
const Q192 = 1n << 192n;
const X18 = 10n ** 18n;

export const V4_QUOTE_CALCULATION_VERSION = "pons-v2-v4quoter-1";

export interface PoolKeyHex {
  currency0: Hex;
  currency1: Hex;
  fee: number;
  tickSpacing: number;
  hooks: Hex;
}

export type TradeSide = "buy" | "sell";

export function v4Direction(params: { side: TradeSide; memecoinIsCurrency0: boolean; poolKey: PoolKeyHex }): {
  zeroForOne: boolean;
  inputCurrency: Hex;
  outputCurrency: Hex;
} {
  // Buying spends the pair asset. The pair asset is currency0 exactly when the memecoin is not.
  const buyZeroForOne = !params.memecoinIsCurrency0;
  const zeroForOne = params.side === "buy" ? buyZeroForOne : !buyZeroForOne;
  return {
    zeroForOne,
    inputCurrency: zeroForOne ? params.poolKey.currency0 : params.poolKey.currency1,
    outputCurrency: zeroForOne ? params.poolKey.currency1 : params.poolKey.currency0,
  };
}

export function minimumOutput(expectedOut: bigint, slippageBps: number): bigint {
  return (expectedOut * (BPS - BigInt(slippageBps))) / BPS;
}

export interface HookTakeCandidate {
  grossOut: bigint;
  hookFee: bigint;
  creatorTax: bigint;
}

export interface HookTake {
  /** True when exactly one gross output reproduces the quote. */
  exact: boolean;
  hookFee: { min: bigint; max: bigint };
  creatorTax: { min: bigint; max: bigint };
  candidates: HookTakeCandidate[];
}

/**
 * Recover the hook's take from a net exact-input quote.
 *
 * PonsV2MemeHook._afterSwap on the unspecified leg of gross output G:
 *   fee = floor(G·hookFeeBps/1e4), tax = floor(G·creatorTaxBps/1e4), net = G − fee − tax.
 *
 * Flooring makes this many-to-one: when G+1 crosses a rounding boundary the fee grows by
 * one wei and the net does not change. The fork evidence hits that in 3 of 42 swaps. So
 * every G that reproduces `net` is returned and the split is a range, never a guess.
 * Returns null if no G reproduces `net`, which the caller reports as missing evidence.
 */
export function reconstructHookTake(netOut: bigint, hookFeeBps: number, creatorTaxBps: number): HookTake | null {
  const h = BigInt(hookFeeBps);
  const t = BigInt(creatorTaxBps);
  if (h + t >= BPS) return null;
  if (h + t === 0n) {
    return { exact: true, hookFee: { min: 0n, max: 0n }, creatorTax: { min: 0n, max: 0n }, candidates: [{ grossOut: netOut, hookFee: 0n, creatorTax: 0n }] };
  }

  const estimate = (netOut * BPS) / (BPS - h - t);
  const candidates: HookTakeCandidate[] = [];
  for (let g = estimate > 3n ? estimate - 3n : 0n; g <= estimate + 3n; g += 1n) {
    const fee = (g * h) / BPS;
    const tax = (g * t) / BPS;
    if (g - fee - tax === netOut) candidates.push({ grossOut: g, hookFee: fee, creatorTax: tax });
  }
  if (candidates.length === 0) return null;

  const range = (xs: bigint[]) => ({ min: xs.reduce((a, b) => (b < a ? b : a)), max: xs.reduce((a, b) => (b > a ? b : a)) });
  return {
    exact: candidates.length === 1,
    hookFee: range(candidates.map((c) => c.hookFee)),
    creatorTax: range(candidates.map((c) => c.creatorTax)),
    candidates,
  };
}

/**
 * Pool spot price, output units per input unit scaled by 1e18, in raw base units (no
 * decimal adjustment — both sides of the comparison below are raw).
 *   zeroForOne: currency1 per currency0 = sqrtP² / 2¹⁹²
 *   else:       currency0 per currency1 = 2¹⁹² / sqrtP²
 */
export function spotOutPerInX18(sqrtPriceX96: bigint, zeroForOne: boolean): bigint {
  const p2 = sqrtPriceX96 * sqrtPriceX96;
  if (p2 === 0n) return 0n;
  return zeroForOne ? (p2 * X18) / Q192 : (Q192 * X18) / p2;
}

/**
 * How much worse than spot this trade executes, in basis points.
 *
 * `outAmount` decides what is measured: pass the net quote for the all-in figure the user
 * experiences (pool impact + hook fees), or the reconstructed gross for pool impact alone.
 * Never negative for a correctly-oriented trade; clamped at 0 for rounding at tiny sizes.
 */
export function shortfallVsSpotBps(params: { amountIn: bigint; outAmount: bigint; spotX18: bigint }): number {
  if (params.amountIn === 0n || params.spotX18 === 0n) return 0;
  const ideal = (params.amountIn * params.spotX18) / X18;
  if (ideal === 0n || params.outAmount >= ideal) return 0;
  const bps = ((ideal - params.outAmount) * BPS) / ideal;
  return Number(bps);
}

const EXACT_IN_SINGLE_PARAMS = [
  {
    type: "tuple",
    components: [
      {
        name: "poolKey",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      { name: "zeroForOne", type: "bool" },
      { name: "amountIn", type: "uint128" },
      { name: "amountOutMinimum", type: "uint128" },
      // Present in the DEPLOYED router's V4Router (verified source), not in older periphery.
      { name: "minHopPriceX36", type: "uint256" },
      { name: "hookData", type: "bytes" },
    ],
  },
] as const;

/**
 * UniversalRouter `execute(commands, inputs, deadline)` arguments for one exact-input
 * single-pool V4 swap: V4_SWAP with SWAP_EXACT_IN_SINGLE → SETTLE_ALL → TAKE_ALL.
 * `minHopPriceX36 = 0` disables the router's per-hop price check (V4Router.sol:93).
 */
export function encodeRouterExactInSingle(params: {
  poolKey: PoolKeyHex;
  zeroForOne: boolean;
  amountIn: bigint;
  minimumOut: bigint;
}): { commands: Hex; inputs: Hex[] } {
  const inputCurrency = params.zeroForOne ? params.poolKey.currency0 : params.poolKey.currency1;
  const outputCurrency = params.zeroForOne ? params.poolKey.currency1 : params.poolKey.currency0;

  const swap = encodeAbiParameters(EXACT_IN_SINGLE_PARAMS, [
    {
      poolKey: params.poolKey,
      zeroForOne: params.zeroForOne,
      amountIn: params.amountIn,
      amountOutMinimum: params.minimumOut,
      minHopPriceX36: 0n,
      hookData: "0x",
    },
  ]);
  const settle = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [inputCurrency, params.amountIn]);
  const take = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [outputCurrency, params.minimumOut]);
  const actions = encodePacked(
    ["uint8", "uint8", "uint8"],
    [V4_ROUTER_ACTIONS.SWAP_EXACT_IN_SINGLE, V4_ROUTER_ACTIONS.SETTLE_ALL, V4_ROUTER_ACTIONS.TAKE_ALL]
  );
  const input = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, [swap, settle, take]]);
  return { commands: encodePacked(["uint8"], [UNIVERSAL_ROUTER_COMMANDS.V4_SWAP]), inputs: [input] };
}
