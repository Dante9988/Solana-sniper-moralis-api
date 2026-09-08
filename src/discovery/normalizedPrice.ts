/**
 * Phase 7B.5B §2 — the candle domain's normalized (decimal-adjusted)
 * execution-price primitive. Deliberately separate from `ChainTrade.priceQuote`
 * (raw quote-units/raw token-units ratio, unchanged since Phase 7B.4/7B.5A —
 * see ARCHITECTURE.md §20.6): candles need a real human-readable price,
 * `priceQuote` intentionally stays raw for its own existing consumers.
 *
 * Chain-neutral: lives alongside decimalDivide (src/discovery/decimal.ts),
 * not under src/pons/**, so a future Solana ChainAdapter's trades normalize
 * through the exact same functions — only the decimals values differ, never
 * the formula, and never a hardcoded assumption (phase7b5b.txt §2: "Never
 * simply assume 18 decimals because this is an EVM chain").
 */

import { decimalDivide } from "./decimal";

/**
 * A raw on-chain integer amount (e.g. ChainTrade.tokenAmount/quoteAmount,
 * both uint256) divided down by its token's verified decimals() into a
 * human-readable decimal string, to `scale` fractional digits.
 *
 * normalizeAmount(raw, decimals) = raw / 10^decimals
 */
export function normalizeAmount(rawAmount: string, decimals: number, scale = 18): string {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new RangeError(`decimals must be a non-negative integer, got ${decimals}`);
  }
  const denominator = decimals === 0 ? "1" : `1${"0".repeat(decimals)}`;
  return decimalDivide(rawAmount, denominator, scale);
}

/**
 * The canonical normalized execution price (phase7b5b.txt §2):
 *
 *   normalized quote amount / normalized token amount
 *   = (quoteAmountRaw / 10^quoteDecimals) / (tokenAmountRaw / 10^tokenDecimals)
 *   = (quoteAmountRaw * 10^tokenDecimals) / (tokenAmountRaw * 10^quoteDecimals)
 *
 * Computed as one decimal-safe BigInt division (never two lossy intermediate
 * divisions) so no precision is lost normalizing each side separately before
 * dividing. tokenAmountRaw = "0" is the only zero-division case `ponsAdapter`
 * can ever produce (it already refuses to decode a zero-token-amount swap —
 * see ponsAdapter.ts's "fail closed rather than guess a side for a
 * degenerate/zero swap leg"), and decimalDivide itself returns "0" rather
 * than throwing for a zero denominator, so this never throws for real
 * ChainTrade rows.
 */
export function computeNormalizedPrice(
  quoteAmountRaw: string,
  quoteDecimals: number,
  tokenAmountRaw: string,
  tokenDecimals: number,
  scale = 18
): string {
  if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0) {
    throw new RangeError(`tokenDecimals must be a non-negative integer, got ${tokenDecimals}`);
  }
  if (!Number.isInteger(quoteDecimals) || quoteDecimals < 0) {
    throw new RangeError(`quoteDecimals must be a non-negative integer, got ${quoteDecimals}`);
  }
  const numerator = BigInt(quoteAmountRaw) * 10n ** BigInt(tokenDecimals);
  const denominator = BigInt(tokenAmountRaw) * 10n ** BigInt(quoteDecimals);
  return decimalDivide(numerator.toString(), denominator.toString(), scale);
}
