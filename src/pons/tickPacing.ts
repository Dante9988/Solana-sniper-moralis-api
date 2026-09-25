/**
 * Phase 7D.5 — how long to wait before the next ingestion tick.
 *
 * Phase 7D introduced a zero delay after any processed tick, because waiting the full poll
 * interval between narrow catch-up windows made backfill slower than new-block production
 * on a ~10 blocks/s chain. Its comment said "don't wait when this tick processed a full
 * range but hasn't reached the tip yet" — but the code never checked the width, so a
 * caught-up listener also looped with no delay.
 *
 * Measured 2026-09-20 with V1 discovery sitting at the tip (lag 5): **105 ticks in ~60s**,
 * each scanning ~14 blocks and finding nothing, each costing a `getLogs` plus block reads
 * on the one usable wide-range provider — the same provider V2 discovery and curve-trade
 * ingestion were being starved by.
 *
 * So: a tick that filled its whole window is still behind, and loops immediately. A tick
 * that could not fill its window has reached the tip, and waits.
 */
export function nextTickDelayMs(params: {
  processedWidth: bigint | null;
  maxRangePerPoll: number;
  pollIntervalMs: number;
}): number {
  const { processedWidth, maxRangePerPoll, pollIntervalMs } = params;
  if (processedWidth === null) return pollIntervalMs;
  return processedWidth >= BigInt(maxRangePerPoll) ? 0 : pollIntervalMs;
}

/** `PROCESSED` tick results all carry the range they covered; anything else has no width. */
export function processedWidth(result: { status: string; fromBlock?: bigint; toBlock?: bigint } | undefined): bigint | null {
  if (!result || result.status !== "PROCESSED" || result.fromBlock === undefined || result.toBlock === undefined) return null;
  return result.toBlock - result.fromBlock + 1n;
}
