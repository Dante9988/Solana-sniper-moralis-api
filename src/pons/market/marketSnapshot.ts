/**
 * Phase 7D.4 — live market state of a Pons V2 token from contract state, not from trades.
 *
 * Sources (PonsV2BondingCurve, Sourcify exact match for factory 0x7eD5…EC7e on chain 4663, solc
 * 0.8.35, fetched 2026-09-15; reads verified on mainnet the same day):
 *   - `getReserves()` = (phantomQuote + trackedQuote − pending fees, trackedTokens). Spot price is
 *     their ratio, the same spot the quoter uses (`curveSpotQuotePerTokenX36`).
 *   - `realQuoteReserve()` = quote physically held, without the virtual reserve or pending fees.
 *     This is the curve's liquidity: what sellers can actually be paid from.
 *   - `readyToGraduate()` is `sellableTokens() == 0`, with `sellableTokens = trackedTokens −
 *     reservedTokens`. The contract calls the token side the hard trigger, so bonding progress is
 *     the share of the initial sellable allocation (`launchSupply − reservedTokens`) bought out.
 *   - Graduation seeds a single full-range Uniswap V4 position (`PonsV2GraduationMath`: amounts
 *     approach `L / sqrtP` and `L · sqrtP`). Pool liquidity is therefore reported as twice the
 *     quote side of the active liquidity at the current price, labelled a full-range equivalent:
 *     concentrated positions added later would make it an overestimate.
 * Amounts stay integers in base units until the USD step, which uses decimal-safe bigint maths.
 */

export const X36 = 10n ** 36n;
const Q96 = 2n ** 96n;
const Q192 = 2n ** 192n;
const TEN = 10n;

export interface CurveReads {
  quoteReserve: bigint;
  tokenReserve: bigint;
  realQuoteReserve: bigint;
  reservedTokens: bigint;
  launchSupply: bigint;
  sellableTokens: bigint;
  graduated: boolean;
  readyToGraduate: boolean;
  graduationThreshold: bigint;
  totalSupply: bigint;
}

export interface PoolReads {
  sqrtPriceX96: bigint;
  liquidity: bigint;
  /** True when the memecoin is the pool's currency0. */
  tokenIsCurrency0: boolean;
  totalSupply: bigint;
}

export interface QuoteDenominatedSnapshot {
  venue: "PONS_V2_BONDING_CURVE" | "UNISWAP_V4_POOL";
  priceQuoteX36: bigint;
  marketCapQuote: bigint;
  liquidityQuote: bigint;
  totalSupply: bigint;
  bondingProgressBps: number | null;
  quoteRaised: bigint | null;
  graduationThreshold: bigint | null;
  graduated: boolean;
  readyToGraduate: boolean;
}

export function bondingProgressBps(r: Pick<CurveReads, "launchSupply" | "reservedTokens" | "sellableTokens" | "readyToGraduate" | "graduated">): number {
  if (r.graduated || r.readyToGraduate) return 10_000;
  const initial = r.launchSupply - r.reservedTokens;
  if (initial <= 0n) return 0;
  const sold = initial - r.sellableTokens;
  if (sold <= 0n) return 0;
  const bps = Number((sold * 10_000n) / initial);
  return Math.min(10_000, Math.max(0, bps));
}

export function curveSnapshot(r: CurveReads): QuoteDenominatedSnapshot {
  const priceQuoteX36 = r.tokenReserve === 0n ? 0n : (r.quoteReserve * X36) / r.tokenReserve;
  return {
    venue: "PONS_V2_BONDING_CURVE",
    priceQuoteX36,
    marketCapQuote: (r.totalSupply * priceQuoteX36) / X36,
    liquidityQuote: r.realQuoteReserve,
    totalSupply: r.totalSupply,
    bondingProgressBps: bondingProgressBps(r),
    quoteRaised: r.realQuoteReserve,
    graduationThreshold: r.graduationThreshold,
    graduated: r.graduated,
    readyToGraduate: r.readyToGraduate,
  };
}

export function poolSnapshot(r: PoolReads): QuoteDenominatedSnapshot {
  if (r.sqrtPriceX96 === 0n) throw new Error("pool is not initialized");
  const sq = r.sqrtPriceX96 * r.sqrtPriceX96; // currency1 per currency0, Q192
  // Quote base units per token base unit, ×1e36.
  const priceQuoteX36 = r.tokenIsCurrency0 ? (sq * X36) / Q192 : (Q192 * X36) / sq;
  // Active liquidity at the current price: amount0 = L·Q96/sqrtP, amount1 = L·sqrtP/Q96.
  const quoteSide = r.tokenIsCurrency0 ? (r.liquidity * r.sqrtPriceX96) / Q96 : (r.liquidity * Q96) / r.sqrtPriceX96;
  return {
    venue: "UNISWAP_V4_POOL",
    priceQuoteX36,
    marketCapQuote: (r.totalSupply * priceQuoteX36) / X36,
    liquidityQuote: 2n * quoteSide,
    totalSupply: r.totalSupply,
    bondingProgressBps: 10_000,
    quoteRaised: null,
    graduationThreshold: null,
    graduated: true,
    readyToGraduate: false,
  };
}

/** Parses a non-negative decimal string into an integer scaled by 10^scale (truncating). */
export function parseDecimal(value: string, scale: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new Error(`not a non-negative decimal: ${value}`);
  const frac = (m[2] ?? "").padEnd(scale, "0").slice(0, scale);
  return BigInt(m[1]) * TEN ** BigInt(scale) + BigInt(frac || "0");
}

export function formatScaled(raw: bigint, scale: number): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const base = TEN ** BigInt(scale);
  const frac = (abs % base).toString().padStart(scale, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${abs / base}${frac ? `.${frac}` : ""}`;
}

const USD_SCALE = 30;

export interface UsdValues {
  priceUsd: string;
  marketCapUsd: string;
  liquidityUsd: string;
}

/** Values in USD from quote-denominated amounts and a USD-per-whole-quote rate string. */
export function toUsd(s: Pick<QuoteDenominatedSnapshot, "priceQuoteX36" | "marketCapQuote" | "liquidityQuote">, decimals: { token: number; quote: number }, rateUsdPerQuote: string): UsdValues {
  const rate = parseDecimal(rateUsdPerQuote, USD_SCALE); // USD per whole quote, ×1e30
  const quoteBase = TEN ** BigInt(decimals.quote);
  // price per whole token in whole quote = priceX36 · 10^tokenDec / (10^quoteDec · 1e36)
  const priceUsd = (s.priceQuoteX36 * TEN ** BigInt(decimals.token) * rate) / (quoteBase * X36);
  const mcapUsd = (s.marketCapQuote * rate) / quoteBase;
  const liqUsd = (s.liquidityQuote * rate) / quoteBase;
  return {
    priceUsd: formatScaled(priceUsd, USD_SCALE),
    marketCapUsd: formatScaled(mcapUsd / TEN ** 24n, 6),
    liquidityUsd: formatScaled(liqUsd / TEN ** 24n, 6),
  };
}

/**
 * When to read a token again. Active tokens stay fresh; a token whose state has not changed backs
 * off exponentially to six hours, so a sweep of tens of thousands of dead launches stays cheap.
 */
export function nextRefreshDelayMs(p: { changed: boolean; unchangedReads: number; graduated: boolean; progressBps: number | null; launchedAgeMs: number | null }): number {
  const MIN = 60_000;
  if (p.changed) return p.graduated ? 2 * MIN : MIN;
  if (p.launchedAgeMs !== null && p.launchedAgeMs < 6 * 3_600_000) return 2 * MIN;
  if ((p.progressBps ?? 0) >= 5_000 && !p.graduated) return 2 * MIN;
  const backoff = 5 * MIN * 2 ** Math.min(p.unchangedReads, 7);
  return Math.min(backoff, 6 * 3_600_000);
}
