import { describe, expect, it } from "vitest";
import { buildHolderSnapshot, currentHoldingsOf } from "../holderSnapshotService";
import { makeFakeClient } from "../fixtures/fakeClient";
import { dasEntry, dasPage } from "../fixtures/syntheticBuilders";
import { PUMPSWAP_PROGRAM_ID } from "../wellKnownAccounts";

const MINT = "So11111111111111111111111111111111111111112";
const WHALE = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const HOLDER_B = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const POOL_TOKEN_ACCOUNT = "PoolVaultTokenAccount1111111111111111111";

function ctx() {
  let n = 0;
  return { evidenceId: () => `ev-${++n}`, now: () => new Date("2026-01-01T00:00:00.000Z") };
}

describe("buildHolderSnapshot", () => {
  it("aggregates multiple token accounts owned by the same wallet into one holder", async () => {
    const client = makeFakeClient({
      getTokenAccountsPaginated: async () => ({
        status: "COMPLETE",
        pagesFetched: 1,
        pages: [dasPage([dasEntry("acct1", MINT, WHALE, "600"), dasEntry("acct2", MINT, WHALE, "400"), dasEntry("acct3", MINT, HOLDER_B, "200")])],
        contextSlot: 1,
        warnings: [],
      }),
    });
    const result = await buildHolderSnapshot(client, MINT, { maxPages: 2, currentSupply: 1200n, ...ctx() });
    expect(result.coverage).toBe("COMPLETE");
    expect(result.owners).toHaveLength(2);
    const whale = result.owners.find((o) => o.owner === WHALE);
    expect(whale?.balance).toBe(1000n);
    expect(whale?.tokenAccounts).toEqual(["acct1", "acct2"]);
  });

  it("computes raw vs adjusted top-10, excluding a positively-classified pool vault", async () => {
    const client = makeFakeClient({
      getTokenAccountsPaginated: async () => ({
        status: "COMPLETE",
        pagesFetched: 1,
        pages: [dasPage([dasEntry(POOL_TOKEN_ACCOUNT, MINT, PUMPSWAP_PROGRAM_ID, "700"), dasEntry("acctB", MINT, HOLDER_B, "300")])],
        contextSlot: 1,
        warnings: [],
      }),
    });
    const result = await buildHolderSnapshot(client, MINT, { maxPages: 2, currentSupply: 1000n, ...ctx() });
    expect(result.holderConcentration.rawTop10Pct).toBeCloseTo(100, 4);
    expect(result.holderConcentration.adjustedTop10Pct).toBeCloseTo(30, 4);
    expect(result.holderConcentration.excludedAccounts.map((e) => e.address)).toContain(PUMPSWAP_PROGRAM_ID);
  });

  it("retains a large unknown account in adjusted concentration without evidence (never excluded on size alone)", async () => {
    const client = makeFakeClient({
      getTokenAccountsPaginated: async () => ({
        status: "COMPLETE",
        pagesFetched: 1,
        pages: [dasPage([dasEntry("acctWhale", MINT, WHALE, "950"), dasEntry("acctB", MINT, HOLDER_B, "50")])],
        contextSlot: 1,
        warnings: [],
      }),
    });
    const result = await buildHolderSnapshot(client, MINT, { maxPages: 2, currentSupply: 1000n, ...ctx() });
    expect(result.holderConcentration.excludedAccounts).toHaveLength(0);
    expect(result.holderConcentration.adjustedTop10Pct).toBeCloseTo(100, 4);
    expect(result.holderConcentration.largestNonSystemHolderPct).toBeCloseTo(95, 4);
  });

  it("withholds top10/adjusted/holderCount when pagination coverage is not COMPLETE", async () => {
    const client = makeFakeClient({
      getTokenAccountsPaginated: async () => ({
        status: "PARTIAL",
        pagesFetched: 1,
        pages: [dasPage([dasEntry("acct1", MINT, WHALE, "600")], { cursor: "next-page" })],
        contextSlot: 1,
        warnings: ["maximum holder pages reached"],
      }),
    });
    const result = await buildHolderSnapshot(client, MINT, { maxPages: 1, currentSupply: 1000n, ...ctx() });
    expect(result.coverage).toBe("PARTIAL");
    expect(result.holderConcentration.rawTop10Pct).toBeUndefined();
    expect(result.holderConcentration.adjustedTop10Pct).toBeUndefined();
    expect(result.holderConcentration.holderCount).toBeUndefined();
  });
});

describe("currentHoldingsOf", () => {
  it("returns undefined (never zero-fills) when the snapshot is not COMPLETE", async () => {
    const partialSnapshot = await buildHolderSnapshot(
      makeFakeClient({
        getTokenAccountsPaginated: async () => ({ status: "PARTIAL", pagesFetched: 1, pages: [], contextSlot: 1, warnings: ["cutoff"] }),
      }),
      MINT,
      { maxPages: 1, currentSupply: 1000n, ...ctx() }
    );
    expect(currentHoldingsOf(partialSnapshot, [WHALE])).toBeUndefined();
  });

  it("zero-fills a wallet absent from a COMPLETE snapshot (true zero, not missing)", async () => {
    const completeSnapshot = await buildHolderSnapshot(
      makeFakeClient({
        getTokenAccountsPaginated: async () => ({ status: "COMPLETE", pagesFetched: 1, pages: [dasPage([dasEntry("a", MINT, HOLDER_B, "10")])], contextSlot: 1, warnings: [] }),
      }),
      MINT,
      { maxPages: 1, currentSupply: 100n, ...ctx() }
    );
    expect(currentHoldingsOf(completeSnapshot, [WHALE])).toEqual([{ wallet: WHALE, amount: 0n }]);
  });
});
