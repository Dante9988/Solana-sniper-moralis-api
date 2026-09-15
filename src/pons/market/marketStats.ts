/**
 * Phase 7D.4 §3 — rolling market statistics from normalized, deduplicated trades. Pure.
 *
 * Rules the terminal depends on:
 *   - A trade counts once, in quote units, on the trader's side of the curve or pool (a buy's quote
 *     paid, a sell's quote received). Buy and sell legs are never both counted.
 *   - Coverage decides what a number means. A window is COMPLETE only if trade ingestion covers
 *     all of it; then zero trades really means no activity. PARTIAL windows report what was
 *     observed and say so; NONE windows report nothing.
 *   - USD volume is the sum of per-trade USD at each trade's own time, and only when every trade in
 *     the window could be valued; otherwise null with the count that could be.
 *   - Price change compares the last price at or before the window start with the latest price; with
 *     no trade before the start there is no baseline and no change.
 */

export const WINDOWS = [
  { id: "5m", seconds: 300 },
  { id: "15m", seconds: 900 },
  { id: "30m", seconds: 1_800 },
  { id: "1h", seconds: 3_600 },
  { id: "24h", seconds: 86_400 },
] as const;
export type WindowId = (typeof WINDOWS)[number]["id"];

export type CoverageStatus = "COMPLETE" | "PARTIAL" | "NONE";

export interface StatTrade {
  side: "buy" | "sell";
  tokenAmount: bigint;
  quoteAmount: bigint;
  timestamp: Date;
  /** Decimal string USD for this trade's quote amount, or null if it could not be valued. */
  usd: string | null;
}

export interface Coverage {
  /** Earliest time trades are known to be fully ingested for this token; null if unknown. */
  from: Date | null;
  /** Latest time trade ingestion has confirmed; null if no stream has committed. */
  to: Date | null;
}

export interface WindowStats {
  window: WindowId;
  from: string;
  to: string;
  coverage: CoverageStatus;
  trades: number | null;
  buys: number | null;
  sells: number | null;
  volumeQuote: string | null;
  volumeUsd: string | null;
  tradesValuedUsd: number | null;
  priceChangePct: string | null;
}

const SCALE = 18n;
const TEN = 10n;

/** raw / 10^decimals as a decimal string with up to 18 fractional digits, exact truncation. */
export function formatUnits(raw: bigint, decimals: number, maxFraction = 18): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const base = TEN ** BigInt(decimals);
  const whole = abs / base;
  let frac = (abs % base).toString().padStart(decimals, "0").slice(0, maxFraction).replace(/0+$/, "");
  if (decimals === 0) frac = "";
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** Price of one whole token in whole quote units, as a bigint scaled by 1e18. */
export function priceScaled(trade: Pick<StatTrade, "tokenAmount" | "quoteAmount">, tokenDecimals: number, quoteDecimals: number): bigint | null {
  if (trade.tokenAmount === 0n) return null;
  return (trade.quoteAmount * TEN ** (SCALE + BigInt(tokenDecimals))) / (trade.tokenAmount * TEN ** BigInt(quoteDecimals));
}

function parseUsd(value: string): bigint {
  const [whole, frac = ""] = value.split(".");
  return BigInt(whole) * TEN ** SCALE + BigInt((frac + "0".repeat(18)).slice(0, 18));
}

export function coverageFor(windowStart: Date, now: Date, coverage: Coverage, graceSec: number): CoverageStatus {
  if (!coverage.to || coverage.to.getTime() < windowStart.getTime()) return "NONE";
  const reachesNow = coverage.to.getTime() >= now.getTime() - graceSec * 1000;
  const reachesStart = coverage.from !== null && coverage.from.getTime() <= windowStart.getTime();
  return reachesNow && reachesStart ? "COMPLETE" : "PARTIAL";
}

/**
 * `trades` sorted ascending by time; `baseline` is the last trade before the earliest window start
 * (or null). Both must be canonical and deduplicated upstream.
 */
export function computeWindows(params: {
  trades: readonly StatTrade[];
  baseline: StatTrade | null;
  now: Date;
  coverage: Coverage;
  tokenDecimals: number;
  quoteDecimals: number;
  /** How far behind "now" ingestion may be and still count as reaching now. */
  graceSec?: number;
}): WindowStats[] {
  const { trades, now, coverage, tokenDecimals, quoteDecimals } = params;
  const grace = params.graceSec ?? 120;
  const last = trades.length > 0 ? trades[trades.length - 1] : params.baseline;
  const lastPrice = last ? priceScaled(last, tokenDecimals, quoteDecimals) : null;

  return WINDOWS.map(({ id, seconds }) => {
    const start = new Date(now.getTime() - seconds * 1000);
    const status = coverageFor(start, now, coverage, grace);
    const base = { window: id, from: start.toISOString(), to: now.toISOString(), coverage: status };
    if (status === "NONE") {
      return { ...base, trades: null, buys: null, sells: null, volumeQuote: null, volumeUsd: null, tradesValuedUsd: null, priceChangePct: null };
    }

    const inWindow = trades.filter((t) => t.timestamp.getTime() > start.getTime() && t.timestamp.getTime() <= now.getTime());
    let volume = 0n;
    let usd = 0n;
    let valued = 0;
    let buys = 0;
    for (const t of inWindow) {
      volume += t.quoteAmount;
      if (t.side === "buy") buys += 1;
      if (t.usd !== null) {
        usd += parseUsd(t.usd);
        valued += 1;
      }
    }

    // Baseline: last trade at or before the start, from the window list or the pre-window baseline.
    let before: StatTrade | null = params.baseline;
    for (const t of trades) if (t.timestamp.getTime() <= start.getTime()) before = t;
    const startPrice = before ? priceScaled(before, tokenDecimals, quoteDecimals) : null;
    const change = startPrice && lastPrice !== null && startPrice > 0n ? formatUnits(((lastPrice - startPrice) * 10n ** 20n) / startPrice, 18, 4) : null;

    return {
      ...base,
      trades: inWindow.length,
      buys,
      sells: inWindow.length - buys,
      volumeQuote: formatUnits(volume, quoteDecimals),
      volumeUsd: valued === inWindow.length ? formatUnits(usd, 18, 2) : null,
      tradesValuedUsd: valued,
      priceChangePct: change,
    };
  });
}
