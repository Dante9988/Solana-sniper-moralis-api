import { describe, expect, it } from "vitest";
import { backfillBridgesLiveCoverage } from "../marketDataService";

const complete = { status: "COMPLETE", fromBlock: 10n, toBlock: 100n, cursor: 100n, poolCursor: 100n };

describe("graduated token backfill coverage", () => {
  it("joins contiguous history to a live session at the exact boundary", () => {
    expect(backfillBridgesLiveCoverage(complete, 10n, 200n, 100n)).toBe(true);
    expect(backfillBridgesLiveCoverage(complete, 10n, 200n, 101n)).toBe(false);
  });
  it("does not infer coverage from a COMPLETE label without both venue checkpoints", () => {
    expect(backfillBridgesLiveCoverage({ ...complete, poolCursor: null }, 10n, 200n, 100n)).toBe(false);
    expect(backfillBridgesLiveCoverage({ ...complete, cursor: 99n }, 10n, 200n, 100n)).toBe(false);
    expect(backfillBridgesLiveCoverage({ ...complete, status: "PARTIAL" }, 10n, 200n, 100n)).toBe(false);
    expect(backfillBridgesLiveCoverage({ ...complete, fromBlock: 11n }, 10n, 200n, 100n)).toBe(false);
  });
  it("requires backfill through the indexed tip when the live stream start is unknown", () => {
    expect(backfillBridgesLiveCoverage(complete, 10n, 100n, null)).toBe(true);
    expect(backfillBridgesLiveCoverage(complete, 10n, 101n, null)).toBe(false);
    expect(backfillBridgesLiveCoverage(null, 10n, 100n, null)).toBe(false);
  });
});
