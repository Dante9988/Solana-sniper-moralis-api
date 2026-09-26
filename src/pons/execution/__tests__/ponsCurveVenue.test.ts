/**
 * Phase 7E.1 §6 — bonding-curve execution: calldata, gates, approvals and reconciliation.
 *
 * The calldata assertions decode the bytes back through the ABI rather than comparing hex
 * strings, so a test failure says which argument is wrong instead of "these differ".
 */

import { decodeFunctionData, encodeAbiParameters, getAbiItem, pad, toEventSelector } from "viem";
import { describe, expect, it } from "vitest";

import { PONS_V2_CURVE_ABI } from "../../abiV2";
import { ERC20_EXECUTION_ABI, PONS_CURVE_EXECUTION_ABI } from "../executionProtocol";
import { RobinhoodPonsExecutionVenue } from "../ponsCurveVenue";
import type { ReceiptFacts } from "../venue";
import { BLOCK, CURVE, FakeCaller, TOKEN, WALLET, curveBuyQuote, curveSellQuote, fakeProbe, poolBuyQuote } from "./testSupport";

const venue = new RobinhoodPonsExecutionVenue();
const NOW = new Date("2026-09-25T00:00:10.000Z"); // inside the quote's 30s window

function built(outcome: Awaited<ReturnType<typeof venue.buildTransaction>>) {
  if (outcome.status !== "BUILT") throw new Error(`expected BUILT, got ${outcome.status}: ${JSON.stringify(outcome)}`);
  return outcome.plan;
}

describe("RobinhoodPonsExecutionVenue.supports", () => {
  it("claims curve quotes and refuses pool quotes", () => {
    expect(venue.supports(curveBuyQuote())).toBe(true);
    expect(venue.supports(poolBuyQuote())).toBe(false);
  });
});

describe("RobinhoodPonsExecutionVenue.buildTransaction", () => {
  it("builds a native buy with the spend as BOTH the argument and msg.value, and no approval", async () => {
    const plan = built(
      await venue.buildTransaction({ quote: curveBuyQuote(), walletAddress: WALLET }, { caller: new FakeCaller(), probe: fakeProbe(), now: () => NOW })
    );

    expect(plan.approvals).toEqual([]);
    expect(plan.route).toEqual({ kind: "BONDING_CURVE", target: CURVE });
    expect(plan.swap.to).toBe(CURVE);
    expect(plan.swap.value).toBe("1000");
    expect(plan.poolId).toBeNull();
    expect(plan.deadline).toBeNull();

    const decoded = decodeFunctionData({ abi: PONS_CURVE_EXECUTION_ABI, data: plan.swap.data });
    expect(decoded.functionName).toBe("buy");
    // quoteIn, minTokensOut, recipient — the recipient is the user, never this backend.
    expect(decoded.args).toEqual([1000n, 4950n, WALLET.toLowerCase()]);
  });

  it("sends the minimum output the quote promised, not the expected one", async () => {
    const plan = built(
      await venue.buildTransaction({ quote: curveBuyQuote(), walletAddress: WALLET }, { caller: new FakeCaller(), probe: fakeProbe(), now: () => NOW })
    );
    const [, minimum] = decodeFunctionData({ abi: PONS_CURVE_EXECUTION_ABI, data: plan.swap.data }).args as [bigint, bigint, string];
    expect(minimum.toString()).toBe("4950");
    expect(plan.minimumOutput).toBe("4950");
    expect(plan.expectedOutput).toBe("5000");
  });

  it("requires an EXACT approval for an ERC-20 sell, never an unlimited one", async () => {
    const caller = new FakeCaller({
      reads: { [`${TOKEN}:allowance`]: 0n, [`${TOKEN}:balanceOf`]: 10_000n },
    });
    const plan = built(await venue.buildTransaction({ quote: curveSellQuote(), walletAddress: WALLET }, { caller, probe: fakeProbe(), now: () => NOW }));

    expect(plan.approvals).toHaveLength(1);
    const approval = plan.approvals[0];
    expect(approval.kind).toBe("ERC20_TO_CURVE");
    expect(approval.spender).toBe(CURVE);
    expect(approval.satisfied).toBe(false);
    expect(approval.required).toBe("5000");

    const decoded = decodeFunctionData({ abi: ERC20_EXECUTION_ABI, data: approval.transaction.data });
    expect(decoded.functionName).toBe("approve");
    expect(decoded.args).toEqual([CURVE, 5000n]);
    // The whole point of §11: not 2^256-1.
    expect((decoded.args as [string, bigint])[1]).not.toBe((1n << 256n) - 1n);
  });

  it("marks an approval satisfied when the existing allowance already covers it", async () => {
    const caller = new FakeCaller({ reads: { [`${TOKEN}:allowance`]: 9_000n, [`${TOKEN}:balanceOf`]: 10_000n } });
    const plan = built(await venue.buildTransaction({ quote: curveSellQuote(), walletAddress: WALLET }, { caller, probe: fakeProbe(), now: () => NOW }));
    expect(plan.approvals[0].satisfied).toBe(true);
  });

  it("attaches no msg.value to a sell", async () => {
    const caller = new FakeCaller({ reads: { [`${TOKEN}:allowance`]: 9_000n, [`${TOKEN}:balanceOf`]: 10_000n } });
    const plan = built(await venue.buildTransaction({ quote: curveSellQuote(), walletAddress: WALLET }, { caller, probe: fakeProbe(), now: () => NOW }));
    expect(plan.swap.value).toBe("0");
  });

  it("refuses an expired quote", async () => {
    const outcome = await venue.buildTransaction(
      { quote: curveBuyQuote(), walletAddress: WALLET },
      { caller: new FakeCaller(), probe: fakeProbe(), now: () => new Date("2026-09-25T00:01:00.000Z") }
    );
    expect(outcome).toMatchObject({ status: "REFUSED", reason: "QUOTE_EXPIRED" });
  });

  it("refuses when the quote's block is no longer canonical", async () => {
    const caller = new FakeCaller({ blockHash: "0xdead000000000000000000000000000000000000000000000000000000000000" });
    const outcome = await venue.buildTransaction({ quote: curveBuyQuote(), walletAddress: WALLET }, { caller, probe: fakeProbe(), now: () => NOW });
    expect(outcome).toMatchObject({ status: "REFUSED", reason: "QUOTE_BLOCK_REORGED" });
  });

  it("refuses a quote for another chain", async () => {
    const outcome = await venue.buildTransaction(
      { quote: curveBuyQuote({ chainId: 1 }), walletAddress: WALLET },
      { caller: new FakeCaller(), probe: fakeProbe(), now: () => NOW }
    );
    expect(outcome).toMatchObject({ status: "REFUSED", reason: "WRONG_CHAIN" });
  });

  it("refuses a pool quote it does not own", async () => {
    const outcome = await venue.buildTransaction({ quote: poolBuyQuote(), walletAddress: WALLET }, { caller: new FakeCaller(), probe: fakeProbe(), now: () => NOW });
    expect(outcome).toMatchObject({ status: "REFUSED", reason: "VENUE_MISMATCH" });
  });

  it("refuses a malformed wallet address before reading any chain state", async () => {
    const caller = new FakeCaller();
    const outcome = await venue.buildTransaction({ quote: curveBuyQuote(), walletAddress: "not-an-address" }, { caller, probe: fakeProbe(), now: () => NOW });
    expect(outcome).toMatchObject({ status: "REFUSED" });
    expect(caller.reads).toEqual([]);
  });

  it("refuses when the wallet cannot cover an ERC-20 input", async () => {
    const caller = new FakeCaller({ reads: { [`${TOKEN}:allowance`]: 0n, [`${TOKEN}:balanceOf`]: 10n } });
    const outcome = await venue.buildTransaction({ quote: curveSellQuote(), walletAddress: WALLET }, { caller, probe: fakeProbe(), now: () => NOW });
    expect(outcome).toMatchObject({ status: "REFUSED", reason: "INSUFFICIENT_BALANCE" });
  });

  it("refuses a native buy that would leave nothing for gas", async () => {
    const outcome = await venue.buildTransaction(
      { quote: curveBuyQuote(), walletAddress: WALLET },
      { caller: new FakeCaller(), probe: fakeProbe({ balance: 1000n }), now: () => NOW }
    );
    expect(outcome).toMatchObject({ status: "REFUSED", reason: "INSUFFICIENT_GAS_BALANCE" });
  });

  it("still builds when no probe is configured, leaving the gas limit to the wallet", async () => {
    const plan = built(await venue.buildTransaction({ quote: curveBuyQuote(), walletAddress: WALLET }, { caller: new FakeCaller(), now: () => NOW }));
    expect(plan.swap.gasLimit).toBeNull();
  });

  it("adds headroom to the node's gas estimate", async () => {
    const plan = built(
      await venue.buildTransaction({ quote: curveBuyQuote(), walletAddress: WALLET }, { caller: new FakeCaller(), probe: fakeProbe({ gas: 200_000n }), now: () => NOW })
    );
    expect(plan.swap.gasLimit).toBe("250000");
  });

  it("reports an unreadable allowance as unavailable rather than assuming zero", async () => {
    const caller = new FakeCaller({ reads: { [`${TOKEN}:allowance`]: "UNAVAILABLE", [`${TOKEN}:balanceOf`]: 10_000n } });
    const outcome = await venue.buildTransaction({ quote: curveSellQuote(), walletAddress: WALLET }, { caller, probe: fakeProbe(), now: () => NOW });
    expect(outcome).toMatchObject({ status: "UNAVAILABLE" });
  });
});

// --- reconciliation -------------------------------------------------------------------

/**
 * Topics are derived from the same ABI the venue decodes with, exactly as ponsV2Adapter
 * does. Hard-coding a hash here would let the test keep passing after the event changed.
 */
const CURVE_BUY_TOPIC0 = toEventSelector(getAbiItem({ abi: PONS_V2_CURVE_ABI, name: "CurveBuy" }));
const CURVE_SELL_TOPIC0 = toEventSelector(getAbiItem({ abi: PONS_V2_CURVE_ABI, name: "CurveSell" }));

function curveTradeLog(params: { event: "CurveBuy" | "CurveSell"; recipient: string; amountIn: bigint; amountOut: bigint; address?: string }) {
  return {
    address: params.address ?? CURVE,
    topics: [
      params.event === "CurveBuy" ? CURVE_BUY_TOPIC0 : CURVE_SELL_TOPIC0,
      pad(WALLET as `0x${string}`, { size: 32 }),
      pad(params.recipient as `0x${string}`, { size: 32 }),
    ],
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      [params.amountIn, params.amountOut, 0n, 0n]
    ),
  };
}

describe("RobinhoodPonsExecutionVenue.reconcile", () => {
  const plan = {
    venue: "ROBINHOOD_PONS_CURVE" as const,
    route: { kind: "BONDING_CURVE" as const, target: CURVE },
    chainId: 4663,
    walletAddress: WALLET.toLowerCase(),
    side: "buy" as const,
    tokenAddress: TOKEN,
    approvals: [],
    swap: { chainId: 4663, to: CURVE, data: "0x" as const, value: "0", gasLimit: null, description: "" },
    poolId: null,
    outputCurrency: TOKEN,
    hookAddress: null,
    deadline: null,
    expectedOutput: "5000",
    minimumOutput: "4950",
    quoteBlock: BLOCK,
    calldataVersion: "test",
  };

  const receipt = (overrides: Partial<ReceiptFacts> = {}): ReceiptFacts => ({
    status: "success",
    blockNumber: 62211540n,
    blockHash: "0xbeef",
    gasUsed: 150_000n,
    effectiveGasPrice: 1_000_000_000n,
    logs: [],
    ...overrides,
  });

  it("reports a revert without inventing amounts", () => {
    const result = venue.reconcile({ plan, receipt: receipt({ status: "reverted" }) });
    expect(result.status).toBe("REVERTED");
    expect(result.actualInput).toBeNull();
    expect(result.netWalletOutput).toBeNull();
    expect(result.failureReason).toBeTruthy();
  });

  it("confirms without amounts when no recognised event is present, rather than guessing", () => {
    const result = venue.reconcile({ plan, receipt: receipt() });
    expect(result.status).toBe("CONFIRMED");
    expect(result.actualInput).toBeNull();
    expect(result.netWalletOutput).toBeNull();
    expect(result.matchedWallet).toBe(false);
  });

  it("carries gas facts straight from the receipt", () => {
    const result = venue.reconcile({ plan, receipt: receipt() });
    expect(result.gasUsed).toBe("150000");
    expect(result.effectiveGasPrice).toBe("1000000000");
    expect(result.blockNumber).toBe("62211540");
  });

  it("ignores a look-alike event emitted by a contract that is not this plan's curve", () => {
    const foreign = curveTradeLog({ event: "CurveBuy", recipient: WALLET, amountIn: 1000n, amountOut: 5000n, address: "0x9999999999999999999999999999999999999999" });
    const result = venue.reconcile({ plan, receipt: receipt({ logs: [foreign] }) });
    expect(result.netWalletOutput).toBeNull();
  });

  it("reads the real fill out of the curve's own CurveBuy event", () => {
    const log = curveTradeLog({ event: "CurveBuy", recipient: WALLET, amountIn: 990n, amountOut: 4980n });
    const result = venue.reconcile({ plan, receipt: receipt({ logs: [log] }) });
    expect(result.status).toBe("CONFIRMED");
    // The event wins over the quote: spent 990, not the quoted 1000.
    expect(result.actualInput).toBe("990");
    expect(result.netWalletOutput).toBe("4980");
    expect(result.matchedWallet).toBe(true);
  });

  it("refuses to credit this wallet for a fill that paid someone else", () => {
    const log = curveTradeLog({ event: "CurveBuy", recipient: "0x8888888888888888888888888888888888888888", amountIn: 990n, amountOut: 4980n });
    const result = venue.reconcile({ plan, receipt: receipt({ logs: [log] }) });
    // The trade happened, so the venue's own figure is reported...
    expect(result.grossVenueOutput).toBe("4980");
    // ...but nothing may be shown to THIS wallet as "you received".
    expect(result.netWalletOutput).toBeNull();
    expect(result.matchedWallet).toBe(false);
  });

  it("does not read a sell event into a buy plan", () => {
    const log = curveTradeLog({ event: "CurveSell", recipient: WALLET, amountIn: 5000n, amountOut: 990n });
    const result = venue.reconcile({ plan, receipt: receipt({ logs: [log] }) });
    expect(result.netWalletOutput).toBeNull();
  });

  it("reads a sell fill for a sell plan", () => {
    const log = curveTradeLog({ event: "CurveSell", recipient: WALLET, amountIn: 5000n, amountOut: 990n });
    const result = venue.reconcile({ plan: { ...plan, side: "sell" as const }, receipt: receipt({ logs: [log] }) });
    expect(result.actualInput).toBe("5000");
    expect(result.netWalletOutput).toBe("990");
    expect(result.matchedWallet).toBe(true);
  });
});
