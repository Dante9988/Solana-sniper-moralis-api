import { describe, it, expect } from "vitest";
import { mapWithConcurrency, chunk } from "../concurrency";

describe("mapWithConcurrency", () => {
  it("never runs more than `limit` calls concurrently", async () => {
    let current = 0;
    let max = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);

    await mapWithConcurrency(items, 4, async (item) => {
      current += 1;
      max = Math.max(max, current);
      await new Promise((resolve) => setTimeout(resolve, 1));
      current -= 1;
      return item * 2;
    });

    expect(max).toBeLessThanOrEqual(4);
    expect(max).toBeGreaterThan(1); // proves it actually ran some in parallel, not serially
  });

  it("captures every outcome, including a rejection, without discarding the others (§4: one bad token must not discard good discoveries)", async () => {
    const items = [1, 2, 3, 4, 5];
    const outcomes = await mapWithConcurrency(items, 2, async (item) => {
      if (item === 3) throw new Error("simulated bad token");
      return item * 10;
    });

    expect(outcomes).toHaveLength(5);
    expect(outcomes[0]).toEqual({ status: "fulfilled", value: 10 });
    expect(outcomes[1]).toEqual({ status: "fulfilled", value: 20 });
    expect(outcomes[2].status).toBe("rejected");
    expect(outcomes[3]).toEqual({ status: "fulfilled", value: 40 });
    expect(outcomes[4]).toEqual({ status: "fulfilled", value: 50 });
  });

  it("returns an empty array for an empty input without calling fn", async () => {
    let calls = 0;
    const outcomes = await mapWithConcurrency([], 5, async () => {
      calls += 1;
      return null;
    });
    expect(outcomes).toEqual([]);
    expect(calls).toBe(0);
  });

  it("clamps an oversized limit down to the item count rather than erroring", async () => {
    const outcomes = await mapWithConcurrency([1, 2], 100, async (n) => n);
    expect(outcomes).toEqual([
      { status: "fulfilled", value: 1 },
      { status: "fulfilled", value: 2 },
    ]);
  });
});

describe("chunk", () => {
  it("splits into groups of the given size, with a shorter final group", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns a single chunk when size exceeds the item count", () => {
    expect(chunk([1, 2], 10)).toEqual([[1, 2]]);
  });

  it("returns an empty array for empty input", () => {
    expect(chunk([], 5)).toEqual([]);
  });

  it("throws on a non-positive size rather than looping forever", () => {
    expect(() => chunk([1, 2], 0)).toThrow();
  });
});
