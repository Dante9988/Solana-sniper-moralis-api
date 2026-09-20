import { describe, expect, it } from "vitest";

import { nextTickDelayMs, processedWidth } from "../tickPacing";

/**
 * Phase 7D.5. Phase 7D's comment promised "don't wait when this tick processed a full range
 * but hasn't reached the tip yet", but the code only checked that the tick had processed
 * *something*. Measured 2026-09-20 with V1 discovery at the tip (lag 5): 105 ticks in ~60s,
 * each scanning ~14 blocks, finding nothing, and each spending a getLogs plus block reads on
 * the single usable wide-range provider that V2 discovery and curve trades needed.
 */
const POLL = 5_000;
const MAX = 10_000;

describe("tick pacing", () => {
  it("loops immediately after a full window — still behind, keep catching up", () => {
    expect(nextTickDelayMs({ processedWidth: BigInt(MAX), maxRangePerPoll: MAX, pollIntervalMs: POLL })).toBe(0);
  });

  it("waits after a partial window — that is what reaching the tip looks like", () => {
    // The exact shape of the busy-poll: a 14-block tick at the tip looping with no delay.
    expect(nextTickDelayMs({ processedWidth: 14n, maxRangePerPoll: MAX, pollIntervalMs: POLL })).toBe(POLL);
  });

  it("waits when the tick did not process a range at all", () => {
    for (const width of [null]) {
      expect(nextTickDelayMs({ processedWidth: width, maxRangePerPoll: MAX, pollIntervalMs: POLL })).toBe(POLL);
    }
  });

  it("treats an over-full window as full, never as a tip signal", () => {
    expect(nextTickDelayMs({ processedWidth: BigInt(MAX) + 1n, maxRangePerPoll: MAX, pollIntervalMs: POLL })).toBe(0);
  });

  describe("processedWidth", () => {
    it("measures a PROCESSED range inclusively", () => {
      expect(processedWidth({ status: "PROCESSED", fromBlock: 100n, toBlock: 109n })).toBe(10n);
      expect(processedWidth({ status: "PROCESSED", fromBlock: 100n, toBlock: 100n })).toBe(1n);
    });

    it.each([
      ["UP_TO_DATE", { status: "UP_TO_DATE" }],
      ["WAITING_ON_DISCOVERY", { status: "WAITING_ON_DISCOVERY" }],
      ["UNAVAILABLE", { status: "UNAVAILABLE" }],
      ["REORG_RECOVERED", { status: "REORG_RECOVERED" }],
      ["undefined (tick threw)", undefined],
    ])("has no width for %s, so the caller backs off", (_label, result) => {
      expect(processedWidth(result as never)).toBeNull();
    });
  });
});
