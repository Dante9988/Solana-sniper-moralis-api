/**
 * Phase 7D.3.2 §4 — Pons V2 bonding-curve quotes.
 *
 * Pure BigInt arithmetic that reproduces PonsV2BondingCurve.buy/sell (verified source,
 * PonsV2LaunchFactory bundle, 2026-08-04) from view state read at one block. It is only
 * trusted because it matched real execution to the wei on a mainnet fork — 18 buy/sell
 * rows across native and USDG curves plus a clamped fill (src/pons/__fixtures__/
 * forkEvidence/curve-quotes.jsonl). Any change here must keep those fixtures passing.
 *
 * Unsupported, deliberately:
 *   - The anti-snipe tax. It depends on the recipient and decays to zero within
 *     `snipeTaxSeconds` (3 s at the pinned block). Rather than model it, a quote inside the
 *     window is refused.
 *   - Fee-on-transfer quote assets. The curve credits what it actually receives; a quote
 *     cannot know that in advance.
 */

const BPS = 10_000n;

export const CURVE_QUOTE_CALCULATION_VERSION = "pons-v2-curve-1";

export interface CurveState {
  quoteReserve: bigint;
  tokenReserve: bigint;
  feeBps: bigint;
  creatorTaxBps: bigint;
  sellableTokens: bigint;
  graduated: boolean;
  readyToGraduate: boolean;
  snipeTaxStartBps: bigint;
  snipeTaxSeconds: bigint;
  launchedAt: bigint;
}

export type CurveRefusal =
  | "CURVE_GRADUATED" // trading has moved to the V4 pool (or is between venues)
  | "SNIPE_WINDOW_OPEN" // anti-snipe tax may apply; not modelled
  | "ZERO_AMOUNT"
  | "OUTPUT_ROUNDS_TO_ZERO" // PonsV2BondingCurveMath.InsufficientOutputAmount
  | "INSUFFICIENT_LIQUIDITY"; // a reserve is zero

export interface CurveBuyQuote {
  ok: true;
  side: "buy";
  /** Quote asset offered. */
  amountIn: bigint;
  /** Quote asset the curve keeps. Below amountIn only when the fill is clamped. */
  spent: bigint;
  refund: bigint;
  tokensOut: bigint;
  protocolFee: bigint;
  creatorTax: bigint;
  /** True when the buy exhausts the sellable allocation and is partially refunded. */
  clamped: boolean;
}

export interface CurveSellQuote {
  ok: true;
  side: "sell";
  amountIn: bigint;
  grossQuoteOut: bigint;
  quoteOut: bigint;
  protocolFee: bigint;
  creatorTax: bigint;
}

export type CurveQuoteResult<T> = T | { ok: false; refusal: CurveRefusal };

/** PonsV2BondingCurveMath._amountOut with feeBps = 0 — the curve removes fees before pricing. */
function amountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  const inWithFee = amountIn * BPS;
  return (inWithFee * reserveOut) / (reserveIn * BPS + inWithFee);
}

/** PonsV2BondingCurveMath.getAmountIn with feeBps = 0. */
function amountIn(out: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  return (out * reserveIn * BPS) / ((reserveOut - out) * BPS) + 1n;
}

/** OpenZeppelin Math.mulDiv(..., Rounding.Ceil). */
function mulDivCeil(a: bigint, b: bigint, d: bigint): bigint {
  const p = a * b;
  return p % d === 0n ? p / d : p / d + 1n;
}

export function snipeWindowOpen(state: CurveState, blockTimestamp: bigint): boolean {
  if (state.snipeTaxStartBps === 0n) return false;
  return blockTimestamp - state.launchedAt < state.snipeTaxSeconds;
}

export function quoteCurveBuy(state: CurveState, quoteIn: bigint, blockTimestamp: bigint): CurveQuoteResult<CurveBuyQuote> {
  if (quoteIn <= 0n) return { ok: false, refusal: "ZERO_AMOUNT" };
  if (state.graduated || state.sellableTokens === 0n) return { ok: false, refusal: "CURVE_GRADUATED" };
  if (snipeWindowOpen(state, blockTimestamp)) return { ok: false, refusal: "SNIPE_WINDOW_OPEN" };
  if (state.quoteReserve === 0n || state.tokenReserve === 0n) return { ok: false, refusal: "INSUFFICIENT_LIQUIDITY" };

  let spent = quoteIn;
  let protocolFee = (spent * state.feeBps) / BPS;
  let creatorTax = (spent * state.creatorTaxBps) / BPS;
  const net = spent - protocolFee - creatorTax;
  if (net === 0n) return { ok: false, refusal: "OUTPUT_ROUNDS_TO_ZERO" };

  let tokensOut = amountOut(net, state.quoteReserve, state.tokenReserve);
  if (tokensOut === 0n) return { ok: false, refusal: "OUTPUT_ROUNDS_TO_ZERO" };

  let clamped = false;
  if (tokensOut > state.sellableTokens) {
    // buy(): price the clamped fill from the token side, then gross the fee legs back up.
    clamped = true;
    tokensOut = state.sellableTokens;
    const netNeeded = amountIn(state.sellableTokens, state.quoteReserve, state.tokenReserve);
    const grossed = mulDivCeil(netNeeded, BPS, BPS - state.feeBps - state.creatorTaxBps);
    spent = grossed < quoteIn ? grossed : quoteIn;
    protocolFee = (spent * state.feeBps) / BPS;
    creatorTax = (spent * state.creatorTaxBps) / BPS;
  }

  return { ok: true, side: "buy", amountIn: quoteIn, spent, refund: quoteIn - spent, tokensOut, protocolFee, creatorTax, clamped };
}

export function quoteCurveSell(state: CurveState, tokensIn: bigint): CurveQuoteResult<CurveSellQuote> {
  if (tokensIn <= 0n) return { ok: false, refusal: "ZERO_AMOUNT" };
  // sell() reverts once the allocation is exhausted, even before `graduated` flips.
  if (state.graduated || state.readyToGraduate) return { ok: false, refusal: "CURVE_GRADUATED" };
  if (state.quoteReserve === 0n || state.tokenReserve === 0n) return { ok: false, refusal: "INSUFFICIENT_LIQUIDITY" };

  const grossQuoteOut = amountOut(tokensIn, state.tokenReserve, state.quoteReserve);
  if (grossQuoteOut === 0n) return { ok: false, refusal: "OUTPUT_ROUNDS_TO_ZERO" };
  const protocolFee = (grossQuoteOut * state.feeBps) / BPS;
  const creatorTax = (grossQuoteOut * state.creatorTaxBps) / BPS;
  return { ok: true, side: "sell", amountIn: tokensIn, grossQuoteOut, quoteOut: grossQuoteOut - protocolFee - creatorTax, protocolFee, creatorTax };
}

/**
 * Spot price before the trade, quote base units per token base unit scaled by 1e36, from the
 * curve's constant-product reserves (virtual quote reserve included — that is what prices
 * trades). 1e36 because a 6-decimal quote asset against an 18-decimal token is ~1e-20 raw.
 */
export function curveSpotQuotePerTokenX36(state: Pick<CurveState, "quoteReserve" | "tokenReserve">): bigint {
  if (state.tokenReserve === 0n) return 0n;
  return (state.quoteReserve * 10n ** 36n) / state.tokenReserve;
}

/** The inverse: token base units per quote base unit, scaled by 1e36, computed from reserves. */
export function curveSpotTokenPerQuoteX36(state: Pick<CurveState, "quoteReserve" | "tokenReserve">): bigint {
  if (state.quoteReserve === 0n) return 0n;
  return (state.tokenReserve * 10n ** 36n) / state.quoteReserve;
}
