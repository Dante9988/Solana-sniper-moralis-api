/**
 * Phase 7E.4.3 §10 — the ONE conversion from a raw on-chain quote amount to a USD notional.
 *
 * §10 requires that 5-minute volume, 1-hour volume and the baseline all use the same conversion
 * logic. The reliable way to guarantee that is for there to be only one function, so this is it,
 * and every caller — candle volume (src/pons/candleFeed.ts) and trending windows
 * (src/pons/market/trendingVolume.ts) — goes through it.
 *
 * The rules it enforces:
 *
 *   raw amount -> quote decimals -> whole quote units -> × trusted USD rate -> USD notional
 *
 *  1. Decimals are never skipped and never guessed. A caller with no verified decimals cannot
 *     call this function, because `quoteDecimals` is required.
 *  2. No floating point anywhere in the arithmetic. A raw lamport or wei amount routinely exceeds
 *     Number.MAX_SAFE_INTEGER, and a double quietly rounds it.
 *  3. No rate, no number. A null rate returns null — USD volume is *unavailable*, not estimated.
 *     There is deliberately no default, no cached "last known" price and no constant anywhere in
 *     this file; §10: "Absolutely no fallback: SOL = 170, SOL = 240, etc."
 */

/** Fixed fractional scale for the result. Cents are not enough for a sub-cent memecoin trade. */
export const USD_SCALE = 18;

function parseDecimalToScaled(value: string, scale: number): bigint {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) throw new Error(`not a decimal string: ${value}`);
  const negative = trimmed.startsWith("-");
  const [whole, fraction = ""] = (negative ? trimmed.slice(1) : trimmed).split(".");
  const padded = (fraction + "0".repeat(scale)).slice(0, scale);
  const scaled = BigInt(whole) * 10n ** BigInt(scale) + BigInt(padded || "0");
  return negative ? -scaled : scaled;
}

function formatScaled(value: bigint, scale: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/**
 * Raw integer quote amount -> whole quote units, exactly.
 *
 * `raw` is an integer string as the chain reported it (lamports, wei, base units). A value that
 * already carries a fractional part is rejected rather than rounded — that would mean the caller
 * has already scaled it once, and scaling twice is how a volume figure ends up a billion times off.
 */
export function rawToWholeUnits(raw: string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error(`invalid decimals: ${decimals}`);
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) throw new Error(`raw amount must be an integer string, got ${raw}`);
  const negative = trimmed.startsWith("-");
  const magnitude = negative ? trimmed.slice(1) : trimmed;
  if (decimals === 0) return `${negative ? "-" : ""}${BigInt(magnitude).toString()}`;
  const padded = magnitude.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, "");
  const result = `${BigInt(whole).toString()}${fraction ? `.${fraction}` : ""}`;
  return negative && result !== "0" ? `-${result}` : result;
}

/**
 * The full conversion. Returns null when the rate is unavailable — which is a valid, expected
 * answer, not a failure: a quote-denominated candle with no USD figure is still a usable candle.
 *
 * `rateUsdPerQuote` is USD per ONE WHOLE unit of the quote asset (one SOL, not one lamport), which
 * is the same unit `QuoteUsdRateProvider` documents.
 */
export function quoteRawToUsd(rawQuoteAmount: string, quoteDecimals: number, rateUsdPerQuote: string | null): string | null {
  if (rateUsdPerQuote === null) return null;
  const whole = parseDecimalToScaled(rawToWholeUnits(rawQuoteAmount, quoteDecimals), USD_SCALE);
  const rate = parseDecimalToScaled(rateUsdPerQuote, USD_SCALE);
  return formatScaled((whole * rate) / 10n ** BigInt(USD_SCALE), USD_SCALE);
}

/**
 * Same conversion, as a JS number, for consumers that rank rather than account (trending scores).
 *
 * The arithmetic still happens in exact integers above; only the final, already-scaled result is
 * narrowed. Callers that persist or display a monetary value must use `quoteRawToUsd` instead.
 */
export function quoteRawToUsdNumber(rawQuoteAmount: string, quoteDecimals: number, rateUsdPerQuote: number | null): number | null {
  if (rateUsdPerQuote === null || !Number.isFinite(rateUsdPerQuote)) return null;
  const usd = quoteRawToUsd(rawQuoteAmount, quoteDecimals, rateUsdPerQuote.toString());
  return usd === null ? null : Number(usd);
}
