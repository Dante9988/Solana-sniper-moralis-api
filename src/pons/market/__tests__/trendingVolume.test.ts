import { describe, expect, it } from "vitest";

import { trendingScore } from "../trendingVolume";

const base = { volume5mUsd: 100, volume1hUsd: 2_000, baselineHourlyUsd: 200, trades1h: 40, traders1h: 12 };

describe("trending by trade volume (Phase 7D.4)", () => {
  it("scores a volume surge above its own recent baseline", () => {
    const r = trendingScore(base);
    expect(r.surge).toBe(10);
    expect(r.score).toBe(2_000 * 10 * 1);
  });

  it("ranks a hotter last five minutes above an equally large but cooling hour", () => {
    const hot = trendingScore({ ...base, volume5mUsd: 500 });
    const cooling = trendingScore({ ...base, volume5mUsd: 0 });
    expect(hot.score!).toBeGreaterThan(cooling.score!);
    expect(trendingScore({ ...base, volume5mUsd: 100_000 }).score).toBe(2_000 * 10 * 3);
  });

  it("does not trend steady volume, thin volume, or volume from a handful of wallets", () => {
    expect(trendingScore({ ...base, volume1hUsd: 2_000, baselineHourlyUsd: 1_800 }).score).toBeNull();
    expect(trendingScore({ ...base, volume1hUsd: 400, baselineHourlyUsd: 10 }).score).toBeNull();
    expect(trendingScore({ ...base, trades1h: 9 }).score).toBeNull();
    expect(trendingScore({ ...base, traders1h: 2 }).score).toBeNull();
  });

  it("lets a new launch with no history trend on volume alone, capped like a 1.5× surge", () => {
    expect(trendingScore({ ...base, baselineHourlyUsd: null, volume1hUsd: 900 }).score).toBeNull();
    const r = trendingScore({ ...base, baselineHourlyUsd: null, volume1hUsd: 5_000, volume5mUsd: 300 });
    expect(r.surge).toBeNull();
    expect(r.score).toBe(5_000 * 1.5 * 1);
  });

  it("uses a baseline floor so a near-silent history cannot produce an absurd multiple", () => {
    expect(trendingScore({ ...base, baselineHourlyUsd: 1 }).surge).toBe(2_000 / 50);
    expect(trendingScore({ ...base, baselineHourlyUsd: 1 }).score).toBe(2_000 * 10);
  });
});
