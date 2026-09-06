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
