import { describe, expect, it } from "vitest";
import { classifyCandleHealth } from "../health";
import type { CandleHealthThresholds } from "../config";

const THRESHOLDS: CandleHealthThresholds = { healthStaleMs: 120_000, healthErrorWindowMs: 60_000, healthLaggingMs: 30_000 };

describe("classifyCandleHealth", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");

  it("is UNAVAILABLE when the worker has never completed a tick", () => {
    expect(classifyCandleHealth(null, 0, now, THRESHOLDS)).toBe("UNAVAILABLE");
  });

  it("is UNAVAILABLE when the last tick is older than the stale threshold", () => {
    const state = { lastTickAt: new Date(now.getTime() - 200_000), lastSuccessAt: new Date(now.getTime() - 200_000), lastError: null, lastErrorAt: null };
    expect(classifyCandleHealth(state, 0, now, THRESHOLDS)).toBe("UNAVAILABLE");
  });

  it("is REORG_RECOVERY whenever invalidations are pending, even with a fresh healthy tick", () => {
    const state = { lastTickAt: now, lastSuccessAt: now, lastError: null, lastErrorAt: null };
    expect(classifyCandleHealth(state, 3, now, THRESHOLDS)).toBe("REORG_RECOVERY");
  });

  it("is DEGRADED when the latest tick recorded a recent per-token error", () => {
    const state = { lastTickAt: now, lastSuccessAt: now, lastError: "decimals unavailable for 0xabc", lastErrorAt: now };
    expect(classifyCandleHealth(state, 0, now, THRESHOLDS)).toBe("DEGRADED");
  });

  it("clears DEGRADED once a subsequent clean tick nulls lastError", () => {
    const state = { lastTickAt: now, lastSuccessAt: now, lastError: null, lastErrorAt: null };
    expect(classifyCandleHealth(state, 0, now, THRESHOLDS)).toBe("LIVE");
  });

  it("is LAGGING when the last successful tick is older than the lagging threshold but not yet stale", () => {
    const state = { lastTickAt: new Date(now.getTime() - 40_000), lastSuccessAt: new Date(now.getTime() - 40_000), lastError: null, lastErrorAt: null };
    expect(classifyCandleHealth(state, 0, now, THRESHOLDS)).toBe("LAGGING");
  });

  it("is LIVE for a fresh, error-free, invalidation-free tick", () => {
    const state = { lastTickAt: now, lastSuccessAt: now, lastError: null, lastErrorAt: null };
    expect(classifyCandleHealth(state, 0, now, THRESHOLDS)).toBe("LIVE");
  });

  it("REORG_RECOVERY takes priority over DEGRADED", () => {
    const state = { lastTickAt: now, lastSuccessAt: now, lastError: "some error", lastErrorAt: now };
    expect(classifyCandleHealth(state, 1, now, THRESHOLDS)).toBe("REORG_RECOVERY");
  });
});
