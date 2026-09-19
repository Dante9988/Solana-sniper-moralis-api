import { describe, expect, it, vi } from "vitest";

import { GraduationPoller } from "../graduationPoller";

/**
 * Phase 7D.5 — the V1 graduation poller must only ever look at V1 rows.
 *
 * `graduationStatus(token)` is a Pons **V1** factory method. V2 curves do not implement
 * it, and V2 graduation arrives as a real `PoolGraduated` event read by
 * discoveryV2Listener — which is why there is deliberately no V2 graduation poller.
 *
 * Measured on 2026-09-19: with no `venue` filter the poller selected all 39,623
 * non-graduated V2 tokens and every single read reverted with `0xcbdb7b30`, burning one
 * RPC round trip and one WARN line each on the same rate-limited endpoints that V2
 * discovery and curve-trade ingestion were starved for.
 */
describe("graduation poller scope", () => {
  it("asks only for venue 'pons' rows", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const poller = new GraduationPoller({
      chainClient: { readContract: vi.fn() } as never,
      db: { discoveredToken: { findMany } } as never,
      config: {} as never,
    });

    await poller.runOnce();

    expect(findMany).toHaveBeenCalledTimes(1);
    const where = findMany.mock.calls[0][0].where;
    expect(where.venue, "a missing venue filter polls every V2 token with a V1-only method").toBe("pons");
    // The guards this phase must not regress.
    expect(where.chain).toBe("robinhood");
    expect(where.graduated).toBe(false);
    expect(where.canonicalStatus).toBe("CANONICAL");
  });

  it("does nothing when no V1 row qualifies, instead of falling back to every venue", async () => {
    const readContract = vi.fn();
    const poller = new GraduationPoller({
      chainClient: { readContract } as never,
      db: { discoveredToken: { findMany: vi.fn().mockResolvedValue([]) } } as never,
      config: {} as never,
    });

    await expect(poller.runOnce()).resolves.toEqual({ status: "NO_POOLS_TRACKED" });
    expect(readContract).not.toHaveBeenCalled();
  });
});
