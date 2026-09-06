/**
 * Phase 7B.5A §4 — bounded concurrency for RPC fan-out (batch discovery
 * enrichment, chunked trade-pool log queries). Deliberately not
 * `Promise.all(items.map(fn))`: an unbounded fan-out during a launch burst
 * or a large tracked-pool set would open one RPC request per item
 * simultaneously. This runs at most `limit` `fn` calls concurrently and
 * never throws — each item's outcome (including a thrown error) is
 * captured individually so one bad item can never discard the others'
 * results (phase7b5a.txt §4: "one bad token must not discard good
 * discoveries").
 */

export type ConcurrencyOutcome<R> = { status: "fulfilled"; value: R } | { status: "rejected"; reason: unknown };

export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<ConcurrencyOutcome<R>[]> {
  if (items.length === 0) return [];
  const boundedLimit = Math.max(1, Math.min(limit, items.length));
  const results: ConcurrencyOutcome<R>[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        const value = await fn(items[index], index);
        results[index] = { status: "fulfilled", value };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }

  await Promise.all(Array.from({ length: boundedLimit }, () => worker()));
  return results;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) throw new Error(`chunk size must be positive, got ${size}`);
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}
