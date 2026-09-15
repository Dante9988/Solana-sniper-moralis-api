import { describe, expect, it } from "vitest";

import { launchMatches, type LaunchFact, type OrphanedRow } from "../scripts/repairTestOrphanedTokens";

const row: OrphanedRow = {
  id: "r1",
  tokenAddress: "0xabc",
  sourceHeight: 61000000n,
  sourceHash: "0xAAAA",
  sourceTxHash: "0xBBBB",
  sourceIndex: 7,
};
const fact: LaunchFact = { blockNumber: 61000000n, blockHash: "0xaaaa", txHash: "0xbbbb", logIndex: 7 };

describe("repairTestOrphanedTokens.launchMatches", () => {
  it("restores only an exact match of the original launch log (hashes compared case-insensitively)", () => {
    expect(launchMatches(row, fact)).toEqual({ ok: true });
  });

  it("keeps a row orphaned when the launch log is missing or any coordinate differs", () => {
    expect(launchMatches(row, undefined).ok).toBe(false);
    expect(launchMatches(row, { ...fact, blockNumber: 61000001n }).ok).toBe(false);
    expect(launchMatches(row, { ...fact, blockHash: "0xcccc" }).ok).toBe(false);
    expect(launchMatches(row, { ...fact, txHash: "0xdddd" }).ok).toBe(false);
    expect(launchMatches(row, { ...fact, logIndex: 8 }).ok).toBe(false);
  });
});
