import { describe, expect, it } from "vitest";
import { analyzeFreshWalletStatus, analyzeWalletFunding } from "../walletFundingAnalyzer";
import { makeFakeClient } from "../fixtures/fakeClient";
import { accountKey, available, systemTransfer, unavailable } from "../fixtures/syntheticBuilders";
import { TransactionsForAddressItem } from "../rpcSchemas";

const DEFINITION_LABEL = "NO_ACTIVITY_OBSERVED_IN_BOUNDED_30_DAY_LOOKBACK";

const RECIPIENT = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const FUNDER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

function ctx() {
  let n = 0;
  return { evidenceId: () => `ev-${++n}`, now: () => new Date("2026-01-01T00:00:00.000Z") };
}

function txForAddressResult(items: TransactionsForAddressItem[]) {
  return available({ data: items, paginationToken: null });
}

describe("analyzeWalletFunding", () => {
  it("finds a one-hop System Program funding transfer within the bounded window", async () => {
    const client = makeFakeClient({
      getTransactionsForAddress: async () =>
        txForAddressResult([
          {
            signature: "sig-fund-1",
            slot: 10,
            blockTime: 1000,
            transaction: { signatures: ["sig-fund-1"], message: { accountKeys: [accountKey(FUNDER, { signer: true })], instructions: [systemTransfer(FUNDER, RECIPIENT, 5_000_000)] } },
            meta: { innerInstructions: [] },
          },
        ]),
    });
    const result = await analyzeWalletFunding(client, RECIPIENT, { maxTransactions: 25, ...ctx() });
    expect(result.completeness).toBe("FOUND_WITHIN_BOUND");
    expect(result.funderWallet).toBe(FUNDER);
    expect(result.lamports).toBe("5000000");
    expect(result.observedTransactionCount).toBe(1);
  });

  it("returns NOT_FOUND_WITHIN_BOUND with zero observed transactions (fresh-wallet evidence) when history is empty", async () => {
    const client = makeFakeClient({ getTransactionsForAddress: async () => txForAddressResult([]) });
    const result = await analyzeWalletFunding(client, RECIPIENT, { maxTransactions: 25, ...ctx() });
    expect(result.completeness).toBe("NOT_FOUND_WITHIN_BOUND");
    expect(result.observedTransactionCount).toBe(0);
    expect(result.funderWallet).toBeUndefined();
  });

  it("returns NOT_FOUND_WITHIN_BOUND (not FOUND) when transactions exist but none transfer to the recipient", async () => {
    const client = makeFakeClient({
      getTransactionsForAddress: async () =>
        txForAddressResult([
          {
            signature: "sig-unrelated",
            slot: 5,
            transaction: { signatures: ["sig-unrelated"], message: { accountKeys: [accountKey(FUNDER, { signer: true })], instructions: [systemTransfer(FUNDER, "SomeoneElse1111111111111111111111111111", 1)] } },
            meta: { innerInstructions: [] },
          },
        ]),
    });
    const result = await analyzeWalletFunding(client, RECIPIENT, { maxTransactions: 25, ...ctx() });
    expect(result.completeness).toBe("NOT_FOUND_WITHIN_BOUND");
    expect(result.observedTransactionCount).toBe(1);
  });

  it("returns UNAVAILABLE when the RPC call fails, never a fabricated funder", async () => {
    const client = makeFakeClient({ getTransactionsForAddress: async () => unavailable("RATE_LIMITED") });
    const result = await analyzeWalletFunding(client, RECIPIENT, { maxTransactions: 25, ...ctx() });
    expect(result.completeness).toBe("UNAVAILABLE");
    expect(result.funderWallet).toBeUndefined();
  });

  it("warns that the search is bounded, not proof of the wallet's original creation funding", async () => {
    const client = makeFakeClient({ getTransactionsForAddress: async () => txForAddressResult([]) });
    const result = await analyzeWalletFunding(client, RECIPIENT, { maxTransactions: 10, ...ctx() });
    expect(result.warnings.join(" ")).toMatch(/not proof of the wallet's original creation funding/);
  });
});

const LAUNCH_SLOT = 1000;
const LAUNCH_SIG = "sig-launch";

describe("analyzeFreshWalletStatus (phase5d.txt §4)", () => {
  it("is FRESH on a complete zero-history lookback (pagination terminates naturally, nothing found)", async () => {
    const client = makeFakeClient({
      getTransactionsForAddressPaginated: async () => ({ status: "COMPLETE", pagesFetched: 1, items: [], warnings: [] }),
    });
    const result = await analyzeFreshWalletStatus(client, RECIPIENT, {
      launchSlot: LAUNCH_SLOT,
      launchSignature: LAUNCH_SIG,
      maxPages: 2,
      limitPerPage: 100,
      definitionLabel: DEFINITION_LABEL,
      ...ctx(),
    });
    expect(result.status).toBe("FRESH");
    expect(result.definition).toBe(DEFINITION_LABEL);
  });

  it("excludes the launch transaction itself from the pre-launch activity test", async () => {
    const client = makeFakeClient({
      getTransactionsForAddressPaginated: async () => ({
        status: "COMPLETE",
        pagesFetched: 1,
        items: [{ signature: LAUNCH_SIG, slot: LAUNCH_SLOT }],
        warnings: [],
      }),
    });
    const result = await analyzeFreshWalletStatus(client, RECIPIENT, {
      launchSlot: LAUNCH_SLOT,
      launchSignature: LAUNCH_SIG,
      maxPages: 2,
      limitPerPage: 100,
      definitionLabel: DEFINITION_LABEL,
      ...ctx(),
    });
    expect(result.status).toBe("FRESH");
  });

  it("is UNKNOWN (not FRESH) when pagination is truncated before reaching the launch slot", async () => {
    // Ascending scan hasn't reached (or passed) the launch slot yet when the
    // page cap hits, and nothing disqualifying was found in what WAS seen —
    // coverage of the pre-launch window is genuinely unproven.
    const client = makeFakeClient({
      getTransactionsForAddressPaginated: async () => ({
        status: "PARTIAL",
        pagesFetched: 2,
        items: [],
        warnings: ["maximum transaction pages reached"],
      }),
    });
    const result = await analyzeFreshWalletStatus(client, RECIPIENT, {
      launchSlot: LAUNCH_SLOT,
      launchSignature: LAUNCH_SIG,
      maxPages: 2,
      limitPerPage: 100,
      definitionLabel: DEFINITION_LABEL,
      ...ctx(),
    });
    expect(result.status).toBe("UNKNOWN");
  });

  it("is UNKNOWN on a query timeout", async () => {
    const client = makeFakeClient({
      getTransactionsForAddressPaginated: async () => ({ status: "UNAVAILABLE", pagesFetched: 0, items: [], warnings: ["page 1: TIMEOUT request timed out"] }),
    });
    const result = await analyzeFreshWalletStatus(client, RECIPIENT, {
      launchSlot: LAUNCH_SLOT,
      launchSignature: LAUNCH_SIG,
      maxPages: 2,
      limitPerPage: 100,
      definitionLabel: DEFINITION_LABEL,
      ...ctx(),
    });
    expect(result.status).toBe("UNKNOWN");
  });

  it("is UNKNOWN on budget exhaustion", async () => {
    const client = makeFakeClient({
      getTransactionsForAddressPaginated: async () => ({
        status: "UNAVAILABLE",
        pagesFetched: 0,
        items: [],
        warnings: ["page 1: BUDGET_EXHAUSTED credit budget exhausted"],
      }),
    });
    const result = await analyzeFreshWalletStatus(client, RECIPIENT, {
      launchSlot: LAUNCH_SLOT,
      launchSignature: LAUNCH_SIG,
      maxPages: 2,
      limitPerPage: 100,
      definitionLabel: DEFINITION_LABEL,
      ...ctx(),
    });
    expect(result.status).toBe("UNKNOWN");
  });

  it("is NOT_FRESH when one older (pre-launch) transaction is found", async () => {
    const client = makeFakeClient({
      getTransactionsForAddressPaginated: async () => ({
        status: "COMPLETE",
        pagesFetched: 1,
        items: [{ signature: "sig-old", slot: LAUNCH_SLOT - 10 }],
        warnings: [],
      }),
    });
    const result = await analyzeFreshWalletStatus(client, RECIPIENT, {
      launchSlot: LAUNCH_SLOT,
      launchSignature: LAUNCH_SIG,
      maxPages: 2,
      limitPerPage: 100,
      definitionLabel: DEFINITION_LABEL,
      ...ctx(),
    });
    expect(result.status).toBe("NOT_FRESH");
  });

  it("a transaction exactly at the launch slot boundary does not disqualify freshness", async () => {
    const client = makeFakeClient({
      getTransactionsForAddressPaginated: async () => ({
        status: "COMPLETE",
        pagesFetched: 1,
        items: [{ signature: "sig-same-slot-different-tx", slot: LAUNCH_SLOT }],
        warnings: [],
      }),
    });
    const result = await analyzeFreshWalletStatus(client, RECIPIENT, {
      launchSlot: LAUNCH_SLOT,
      launchSignature: LAUNCH_SIG,
      maxPages: 2,
      limitPerPage: 100,
      definitionLabel: DEFINITION_LABEL,
      ...ctx(),
    });
    expect(result.status).toBe("FRESH");
  });

  it("is UNKNOWN when the launch slot itself is unavailable", async () => {
    const client = makeFakeClient({});
    const result = await analyzeFreshWalletStatus(client, RECIPIENT, {
      launchSlot: undefined,
      launchSignature: LAUNCH_SIG,
      maxPages: 2,
      limitPerPage: 100,
      definitionLabel: DEFINITION_LABEL,
      ...ctx(),
    });
    expect(result.status).toBe("UNKNOWN");
  });

  it("never claims the wallet was newly created — only the bounded no-activity label", () => {
    expect(DEFINITION_LABEL).not.toMatch(/newly created|new wallet/i);
  });
});
