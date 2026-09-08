/**
 * Decimal-safe arithmetic shared by every ChainAdapter. Never use
 * JavaScript floats for on-chain amounts or derived prices — see
 * phase7b4.txt §1 (Prisma convention) and CANDLESTICK_CHART.md.
 */

/** Same algorithm as src/pump/normalizeTrade.ts's local decimalDivide, kept generic here so every adapter shares one implementation instead of each reinventing it. */
export function decimalDivide(numerator: string, denominator: string, scale = 18): string {
  const n = BigInt(numerator);
  const d = BigInt(denominator);
  if (d === 0n) return "0";
  const scaled = (n * 10n ** BigInt(scale)) / d;
  const negative = scaled < 0n;
  const abs = (negative ? -scaled : scaled).toString().padStart(scale + 1, "0");
  const intPart = abs.slice(0, -scale) || "0";
  const fracPart = abs.slice(-scale).replace(/0+$/, "");
  const result = fracPart ? `${intPart}.${fracPart}` : intPart;
  return negative ? `-${result}` : result;
}

/**
 * Phase 7B.5B — fixed-point BigInt helpers shared by the candle domain
 * (src/candles/aggregate.ts) for OHLC/volume math. Every candle accounting
 * value (open/high/low/close, token/quote/USD volume) is parsed once into a
 * scaled BigInt, compared/summed with exact integer arithmetic, and
 * formatted back to a decimal string — never a JavaScript float at any
 * point in the pipeline (phase7b5b.txt §2/§16).
 */

/** Parses a decimal string (e.g. from decimalDivide's own output, or a Prisma Decimal#toFixed()) into a BigInt scaled by `scale` fractional digits. Excess input precision is truncated, never rounded — consistent with decimalDivide's own truncation-toward-zero behavior. */
export function parseDecimalToScaledBigInt(value: string, scale: number): bigint {
  const trimmed = value.trim();
  const negative = trimmed.startsWith("-");
  const abs = negative ? trimmed.slice(1) : trimmed;
  const [intPartRaw, fracPartRaw = ""] = abs.split(".");
  const intPart = intPartRaw === "" ? "0" : intPartRaw;
  const fracPart = fracPartRaw.padEnd(scale, "0").slice(0, scale);
  const combined = `${intPart}${fracPart}`.replace(/^0+(?=\d)/, "");
  const magnitude = BigInt(combined === "" ? "0" : combined);
  return negative && magnitude !== 0n ? -magnitude : magnitude;
}

/** Inverse of parseDecimalToScaledBigInt — always a fixed (never scientific-notation) decimal string, matching this repo's Prisma Decimal#toFixed() convention (Phase 7B.4/7B.5A discovered #toString() can emit "1e+27" for large values). */
export function formatScaledBigInt(value: bigint, scale: number): string {
  const negative = value < 0n;
  const abs = (negative ? -value : value).toString().padStart(scale + 1, "0");
  const intPart = abs.slice(0, abs.length - scale) || "0";
  const fracPart = scale > 0 ? abs.slice(abs.length - scale).replace(/0+$/, "") : "";
  const result = fracPart ? `${intPart}.${fracPart}` : intPart;
  return negative && result !== "0" ? `-${result}` : result;
}
