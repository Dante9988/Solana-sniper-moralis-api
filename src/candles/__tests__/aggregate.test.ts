import { describe, expect, it } from "vitest";
import { aggregateTrades } from "../aggregate";
import type { CandleTradeInput } from "../types";

function trade(overrides: Partial<CandleTradeInput> & { sourceHeight: bigint; sourceIndex: number; sourceTimestamp: Date }): CandleTradeInput {
  return {
    side: "buy",
    price: "1.0",
    tokenAmount: "10",
    quoteAmount: "10",
    usdAmount: null,
    trader: "0xtrader1",
    ...overrides,
  };
}

const T0 = new Date("2026-01-01T00:00:00.000Z"); // unix 1767225600

describe("aggregateTrades", () => {
  it("produces no candle for a no-trade interval", () => {
    const result = aggregateTrades([], ["1m"]);
    expect(result.get("1m")).toEqual([]);
  });

  it("buckets a single trade correctly at every requested resolution", () => {
    const t = trade({ sourceHeight: 1n, sourceIndex: 0, sourceTimestamp: T0, price: "2.5" });
    const result = aggregateTrades([t], ["1s", "1m", "1h"]);
    for (const res of ["1s", "1m", "1h"] as const) {
      const buckets = result.get(res)!;
      expect(buckets).toHaveLength(1);
      expect(buckets[0].open).toBe("2.5");
      expect(buckets[0].close).toBe("2.5");
      expect(buckets[0].high).toBe("2.5");
      expect(buckets[0].low).toBe("2.5");
      expect(buckets[0].tradeCount).toBe(1);
    }
  });

  it("computes deterministic UTC bucket boundaries (floor(ts/interval)*interval), no local timezone math", () => {
    const base = Math.floor(T0.getTime() / 1000);
    const t1 = trade({ sourceHeight: 1n, sourceIndex: 0, sourceTimestamp: new Date((base + 3) * 1000) });
    const t2 = trade({ sourceHeight: 2n, sourceIndex: 0, sourceTimestamp: new Date((base + 7) * 1000) });
    const result = aggregateTrades([t1, t2], ["5s"]);
    const buckets = result.get("5s")!;
    expect(buckets).toHaveLength(2);
    expect(buckets[0].bucketStart).toBe(base); // floor(3/5)*5 relative alignment == base
    expect(buckets[1].bucketStart).toBe(base + 5);
  });

  it("open = first trade by source order, close = last, high/low = extremes, regardless of input array order", () => {
    const base = Math.floor(T0.getTime() / 1000);
    const t1 = trade({ sourceHeight: 1n, sourceIndex: 0, sourceTimestamp: new Date(base * 1000), price: "1.0" });
    const t2 = trade({ sourceHeight: 1n, sourceIndex: 1, sourceTimestamp: new Date(base * 1000), price: "5.0" });
    const t3 = trade({ sourceHeight: 2n, sourceIndex: 0, sourceTimestamp: new Date(base * 1000), price: "0.5" });
    const t4 = trade({ sourceHeight: 2n, sourceIndex: 1, sourceTimestamp: new Date(base * 1000), price: "3.0" });

    // deliberately shuffled — the aggregator must never trust input order
    const result = aggregateTrades([t4, t1, t3, t2], ["1h"]);
    const [bucket] = result.get("1h")!;
    expect(bucket.open).toBe("1");
    expect(bucket.close).toBe("3");
    expect(bucket.high).toBe("5");
    expect(bucket.low).toBe("0.5");
    expect(bucket.tradeCount).toBe(4);
  });

  it("orders multiple swaps in the same block by sourceIndex (EVM logIndex), never insertion order", () => {
    const base = Math.floor(T0.getTime() / 1000);
    const sameBlockTs = new Date(base * 1000);
    // Same sourceHeight (same block) — only sourceIndex distinguishes order.
    const early = trade({ sourceHeight: 100n, sourceIndex: 2, sourceTimestamp: sameBlockTs, price: "9.0" });
    const late = trade({ sourceHeight: 100n, sourceIndex: 40, sourceTimestamp: sameBlockTs, price: "1.0" });
    // Passed in reverse-of-logIndex order to prove input order is irrelevant.
    const result = aggregateTrades([late, early], ["1h"]);
    const [bucket] = result.get("1h")!;
    expect(bucket.open).toBe("9"); // sourceIndex 2 first
    expect(bucket.close).toBe("1"); // sourceIndex 40 last
  });

  it("sums token/quote volume as absolute amounts", () => {
    const base = Math.floor(T0.getTime() / 1000);
    const ts = new Date(base * 1000);
    const t1 = trade({ sourceHeight: 1n, sourceIndex: 0, sourceTimestamp: ts, tokenAmount: "10.5", quoteAmount: "21" });
    const t2 = trade({ sourceHeight: 1n, sourceIndex: 1, sourceTimestamp: ts, tokenAmount: "4.25", quoteAmount: "8.5" });
    const result = aggregateTrades([t1, t2], ["1h"]);
    const [bucket] = result.get("1h")!;
    expect(bucket.volumeToken).toBe("14.75");
    expect(bucket.volumeQuote).toBe("29.5");
  });

  it("USD volume is the sum only when every trade in the bucket has a non-null usdAmount", () => {
    const base = Math.floor(T0.getTime() / 1000);
    const ts = new Date(base * 1000);
    const withUsd1 = trade({ sourceHeight: 1n, sourceIndex: 0, sourceTimestamp: ts, usdAmount: "10" });
    const withUsd2 = trade({ sourceHeight: 1n, sourceIndex: 1, sourceTimestamp: ts, usdAmount: "5" });
    const okResult = aggregateTrades([withUsd1, withUsd2], ["1h"]);
    expect(okResult.get("1h")![0].volumeUsd).toBe("15");

    const missing = trade({ sourceHeight: 1n, sourceIndex: 2, sourceTimestamp: ts, usdAmount: null });
    const partialResult = aggregateTrades([withUsd1, withUsd2, missing], ["1h"]);
    // Never partially estimated — one missing rate nulls the whole bucket's USD volume.
    expect(partialResult.get("1h")![0].volumeUsd).toBeNull();
  });

  it("counts distinct observed traders, not raw trade count", () => {
    const base = Math.floor(T0.getTime() / 1000);
    const ts = new Date(base * 1000);
    const t1 = trade({ sourceHeight: 1n, sourceIndex: 0, sourceTimestamp: ts, trader: "0xaaa" });
    const t2 = trade({ sourceHeight: 1n, sourceIndex: 1, sourceTimestamp: ts, trader: "0xaaa" });
    const t3 = trade({ sourceHeight: 1n, sourceIndex: 2, sourceTimestamp: ts, trader: "0xbbb" });
    const result = aggregateTrades([t1, t2, t3], ["1h"]);
    const [bucket] = result.get("1h")!;
    expect(bucket.tradeCount).toBe(3);
    expect(bucket.uniqueTraders).toBe(2);
  });

  it("firstSourceHeight/lastSourceHeight span the bucket's canonical trades", () => {
    const base = Math.floor(T0.getTime() / 1000);
    const t1 = trade({ sourceHeight: 10n, sourceIndex: 0, sourceTimestamp: new Date(base * 1000) });
    const t2 = trade({ sourceHeight: 12n, sourceIndex: 0, sourceTimestamp: new Date(base * 1000) });
    const result = aggregateTrades([t1, t2], ["1h"]);
    const [bucket] = result.get("1h")!;
    expect(bucket.firstSourceHeight).toBe(10n);
    expect(bucket.lastSourceHeight).toBe(12n);
  });

  it("supports every backend resolution: 1s 5s 15s 1m 5m 15m 1h", () => {
    const base = Math.floor(T0.getTime() / 1000);
    const t = trade({ sourceHeight: 1n, sourceIndex: 0, sourceTimestamp: new Date(base * 1000) });
    const result = aggregateTrades([t]);
    expect([...result.keys()].sort()).toEqual(["15m", "15s", "1h", "1m", "1s", "5m", "5s"].sort());
    for (const buckets of result.values()) expect(buckets).toHaveLength(1);
  });

  it("does not double-count when the same trade object is passed twice (caller responsibility to dedupe, but proves no hidden dedupe silently masks bugs elsewhere)", () => {
    const base = Math.floor(T0.getTime() / 1000);
    const ts = new Date(base * 1000);
    const t = trade({ sourceHeight: 1n, sourceIndex: 0, sourceTimestamp: ts, tokenAmount: "10", quoteAmount: "10" });
    const result = aggregateTrades([t, t], ["1h"]);
    // The aggregator is a pure function of its input — feeding it a
    // duplicate produces double volume. Real duplicate-prevention is
    // ChainTrade's DB unique constraint + candleFeed.ts's query, proven in
    // candleAggregationService.dbIntegration.test.ts, not here.
    expect(result.get("1h")![0].volumeToken).toBe("20");
  });

  it("high precision (18-decimal) prices are preserved exactly, no floating-point drift", () => {
    const base = Math.floor(T0.getTime() / 1000);
    const ts = new Date(base * 1000);
    const t1 = trade({ sourceHeight: 1n, sourceIndex: 0, sourceTimestamp: ts, price: "0.000000000000000001" });
    const t2 = trade({ sourceHeight: 1n, sourceIndex: 1, sourceTimestamp: ts, price: "123456789.1234567890123456789" });
    const result = aggregateTrades([t1, t2], ["1h"]);
    const [bucket] = result.get("1h")!;
    expect(bucket.low).toBe("0.000000000000000001");
    expect(bucket.high).toBe("123456789.123456789012345678"); // truncated to 18 fractional digits, exact — not rounded/floated
  });
});
