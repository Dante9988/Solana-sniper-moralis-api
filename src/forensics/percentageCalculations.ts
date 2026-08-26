/**
 * Phase 5A pure percentage math. No I/O. Callers (Phase 5C analyzers) supply
 * evidence-backed raw base-unit amounts; this module never fabricates a value
 * and never turns a missing denominator into `0`.
 */

export interface AmountEntry {
  wallet: string;
  /** Raw base-unit token amount (pre-decimals), as a bigint for exact arithmetic. */
  amount: bigint;
}

export function sumAmounts(entries: AmountEntry[]): bigint {
  return entries.reduce((total, entry) => total + entry.amount, 0n);
}

/**
 * numerator / denominator * 100, rounded to 4 decimal places.
 * Returns `undefined` when the denominator is missing or non-positive —
 * never `0`, which would misrepresent "no data" as "safe".
 */
export function calculatePercentage(
  numerator: bigint,
  denominator: bigint | undefined
): number | undefined {
  if (denominator === undefined || denominator <= 0n) return undefined;
  if (numerator < 0n) return undefined;
  const scaled = (numerator * 1_000_000n) / denominator;
  return Number(scaled) / 10_000;
}

export function calculateBundledAcquisitionPct(
  bundleWalletAmounts: AmountEntry[],
  supplyAtLaunch: bigint | undefined
): number | undefined {
  return calculatePercentage(sumAmounts(bundleWalletAmounts), supplyAtLaunch);
}

export function calculateCurrentHoldingsPct(
  walletAmounts: AmountEntry[],
  currentSupply: bigint | undefined
): number | undefined {
  return calculatePercentage(sumAmounts(walletAmounts), currentSupply);
}

/**
 * Top-holder concentration after removing only positively-evidenced excluded
 * addresses. Callers must never exclude an address on size alone.
 */
export function calculateAdjustedConcentration(
  topHolders: AmountEntry[],
  excludedAddresses: ReadonlySet<string>,
  currentSupply: bigint | undefined
): number | undefined {
  const included = topHolders.filter((holder) => !excludedAddresses.has(holder.wallet));
  return calculatePercentage(sumAmounts(included), currentSupply);
}

export function calculateLargestHolderPct(
  holders: AmountEntry[],
  excludedAddresses: ReadonlySet<string>,
  currentSupply: bigint | undefined
): number | undefined {
  const eligible = holders.filter((holder) => !excludedAddresses.has(holder.wallet));
  if (eligible.length === 0) return undefined;
  const largest = eligible.reduce((max, holder) => (holder.amount > max.amount ? holder : max));
  return calculatePercentage(largest.amount, currentSupply);
}
