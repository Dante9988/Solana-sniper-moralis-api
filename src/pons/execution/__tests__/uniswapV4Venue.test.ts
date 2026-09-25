/**
 * Phase 7E.1 §7/§11 — graduated-pool execution through the UniversalRouter.
 *
 * The swap calldata is asserted against `encodeRouterExactInSingle` itself rather than a
 * frozen hex blob: that encoder is what the fork-verified route simulator drives, so
 * "what is simulated is what is signed" is the property under test, and a change to the
 * encoder that the venue failed to pick up would fail here.
 */

import { decodeFunctionData, encodeAbiParameters, getAbiItem, pad, toEventSelector } from "viem";
import { describe, expect, it } from "vitest";

import { UNISWAP_V4_POOL_MANAGER_ABI } from "../../abiV2";
import { UNISWAP_V4_ROBINHOOD } from "../../quote/protocol";
import { encodeRouterExactInSingle } from "../../quote/v4Quote";
import { ERC20_EXECUTION_ABI, EXECUTION_DEADLINE_SECONDS, PERMIT2_ABI, UNIVERSAL_ROUTER_ABI } from "../executionProtocol";
import { RobinhoodUniswapV4ExecutionVenue } from "../uniswapV4Venue";
import type { ReceiptFacts } from "../venue";
import { BLOCK, BLOCK_SECONDS, FakeCaller, POOL_ID, TOKEN, WALLET, curveBuyQuote, fakeProbe, poolBuyQuote, poolSellQuote } from "./testSupport";

const venue = new RobinhoodUniswapV4ExecutionVenue();
const NOW = new Date("2026-09-25T00:00:10.000Z");
const ROUTER = UNISWAP_V4_ROBINHOOD.universalRouter;
const PERMIT2 = UNISWAP_V4_ROBINHOOD.permit2;

function built(outcome: Awaited<ReturnType<typeof venue.buildTransaction>>) {
  if (outcome.status !== "BUILT") throw new Error(`expected BUILT, got ${outcome.status}: ${JSON.stringify(outcome)}`);
  return outcome.plan;
}

/** A sell reads both the ERC-20 allowance to Permit2 and Permit2's allowance to the router. */
function sellReads(options: { erc20?: bigint | string; permit2?: readonly [bigint, number, number] | string; balance?: bigint } = {}) {
  return {
    [`${TOKEN}:allowance`]: options.erc20 ?? 0n,
    [`${TOKEN}:balanceOf`]: options.balance ?? 10_000n,
    [`${PERMIT2}:allowance`]: options.permit2 ?? ([0n, 0, 0] as const),
  };
}

describe("RobinhoodUniswapV4ExecutionVenue.supports", () => {
  it("claims pool quotes and refuses curve quotes", () => {
    expect(venue.supports(poolBuyQuote())).toBe(true);
    expect(venue.supports(curveBuyQuote())).toBe(false);
  });
});

describe("RobinhoodUniswapV4ExecutionVenue.buildTransaction", () => {
  it("targets the UniversalRouter and encodes the same swap the simulator drives", async () => {
    const quote = poolBuyQuote();
    const plan = built(await venue.buildTransaction({ quote, walletAddress: WALLET }, { caller: new FakeCaller(), probe: fakeProbe(), now: () => NOW }));

    expect(plan.route).toEqual({ kind: "UNIVERSAL_ROUTER", target: ROUTER });
    expect(plan.swap.to).toBe(ROUTER);
    expect(plan.poolId).toBe(POOL_ID);

    const decoded = decodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, data: plan.swap.data });
    expect(decoded.functionName).toBe("execute");

    if (quote.venueState.kind !== "pool") throw new Error("fixture must carry pool state");
    const expected = encodeRouterExactInSingle({
      poolKey: quote.venueState.poolKey,
      zeroForOne: true, // native ETH is currency0 in the fixture
      amountIn: 1000n,
      minimumOut: 4950n,
    });
    const [commands, inputs, deadline] = decoded.args as [string, string[], bigint];
    expect(commands).toBe(expected.commands);
    expect(inputs).toEqual(expected.inputs);
    expect(deadline).toBe(BigInt(BLOCK.timestamp) + EXECUTION_DEADLINE_SECONDS);
  });

  it("measures the deadline from the quote's block timestamp, not the server clock", async () => {
    const plan = built(
      await venue.buildTransaction({ quote: poolBuyQuote(), walletAddress: WALLET }, { caller: new FakeCaller(), probe: fakeProbe(), now: () => NOW })
    );
    // The fixture's chain clock and the server clock are deliberately far apart, so a
    // deadline built from Date.now() would not land on this value.
    expect(plan.deadline).toBe((BigInt(BLOCK.timestamp) + EXECUTION_DEADLINE_SECONDS).toString());
    expect(plan.deadline).not.toBe((BigInt(Math.floor(NOW.getTime() / 1000)) + EXECUTION_DEADLINE_SECONDS).toString());
  });

  it("attaches msg.value for a native input and none for an ERC-20 input", async () => {
    const buy = built(await venue.buildTransaction({ quote: poolBuyQuote(), walletAddress: WALLET }, { caller: new FakeCaller(), probe: fakeProbe(), now: () => NOW }));
    expect(buy.swap.value).toBe("1000");

    const sell = built(
      await venue.buildTransaction({ quote: poolSellQuote(), walletAddress: WALLET }, { caller: new FakeCaller({ reads: sellReads() }), probe: fakeProbe(), now: () => NOW })
    );
    expect(sell.swap.value).toBe("0");
  });

  it("needs NO approval for a native buy", async () => {
    const plan = built(await venue.buildTransaction({ quote: poolBuyQuote(), walletAddress: WALLET }, { caller: new FakeCaller(), probe: fakeProbe(), now: () => NOW }));
    expect(plan.approvals).toEqual([]);
  });

  it("needs TWO approvals for an ERC-20 input: token to Permit2, then Permit2 to the router", async () => {
    const plan = built(
      await venue.buildTransaction({ quote: poolSellQuote(), walletAddress: WALLET }, { caller: new FakeCaller({ reads: sellReads() }), probe: fakeProbe(), now: () => NOW })
    );
    expect(plan.approvals.map((a) => a.kind)).toEqual(["ERC20_TO_PERMIT2", "PERMIT2_TO_ROUTER"]);

    const [toPermit2, toRouter] = plan.approvals;
    expect(toPermit2.spender).toBe(PERMIT2);
    expect(toPermit2.transaction.to).toBe(TOKEN);
    const erc20Args = decodeFunctionData({ abi: ERC20_EXECUTION_ABI, data: toPermit2.transaction.data }).args as [string, bigint];
    expect(erc20Args[0].toLowerCase()).toBe(PERMIT2);
    expect(erc20Args[1]).toBe(5000n);

    expect(toRouter.spender).toBe(ROUTER);
    expect(toRouter.transaction.to).toBe(PERMIT2);
    const permitArgs = decodeFunctionData({ abi: PERMIT2_ABI, data: toRouter.transaction.data }).args as [string, string, bigint, number];
    expect(permitArgs[0].toLowerCase()).toBe(TOKEN);
    expect(permitArgs[1].toLowerCase()).toBe(ROUTER);
    expect(permitArgs[2]).toBe(5000n);
  });

  it("gives the Permit2 approval an expiry that outlives the swap deadline", async () => {
    const plan = built(
      await venue.buildTransaction({ quote: poolSellQuote(), walletAddress: WALLET }, { caller: new FakeCaller({ reads: sellReads() }), probe: fakeProbe(), now: () => NOW })
    );
    const [, , , expiration] = decodeFunctionData({ abi: PERMIT2_ABI, data: plan.approvals[1].transaction.data }).args as [string, string, bigint, number];
    // A swap that outlives its own approval reverts with AllowanceExpired even though the
    // user approved, so this ordering is the point.
    expect(BigInt(expiration)).toBeGreaterThan(BigInt(plan.deadline!));
  });

  it("requests exactly the input amount, never uint160 max", async () => {
    const plan = built(
      await venue.buildTransaction({ quote: poolSellQuote(), walletAddress: WALLET }, { caller: new FakeCaller({ reads: sellReads() }), probe: fakeProbe(), now: () => NOW })
    );
    for (const approval of plan.approvals) {
      expect(approval.required).toBe("5000");
    }
    const permitAmount = (decodeFunctionData({ abi: PERMIT2_ABI, data: plan.approvals[1].transaction.data }).args as [string, string, bigint, number])[2];
    expect(permitAmount).not.toBe((1n << 160n) - 1n);
  });

  it("treats a large-but-EXPIRED Permit2 allowance as unsatisfied", async () => {
    const past = Number(BLOCK_SECONDS) - 60;
    const plan = built(
      await venue.buildTransaction(
        { quote: poolSellQuote(), walletAddress: WALLET },
        { caller: new FakeCaller({ reads: sellReads({ erc20: 10_000n, permit2: [999_999n, past, 0] }) }), probe: fakeProbe(), now: () => NOW }
      )
    );
    expect(plan.approvals[0].satisfied).toBe(true); // the plain ERC-20 leg is fine
    expect(plan.approvals[1].satisfied).toBe(false); // but Permit2's has lapsed
    expect(plan.approvals[1].current).toBe("0");
  });

  it("treats a live and sufficient Permit2 allowance as satisfied", async () => {
    const future = Number(BLOCK_SECONDS) + 3600;
    const plan = built(
      await venue.buildTransaction(
        { quote: poolSellQuote(), walletAddress: WALLET },
        { caller: new FakeCaller({ reads: sellReads({ erc20: 10_000n, permit2: [10_000n, future, 3] }) }), probe: fakeProbe(), now: () => NOW }
      )
    );
    expect(plan.approvals.every((a) => a.satisfied)).toBe(true);
  });

  it("refuses a curve quote it does not own", async () => {
    const outcome = await venue.buildTransaction({ quote: curveBuyQuote(), walletAddress: WALLET }, { caller: new FakeCaller(), probe: fakeProbe(), now: () => NOW });
    expect(outcome).toMatchObject({ status: "REFUSED", reason: "VENUE_MISMATCH" });
  });

  it("refuses an expired quote and a reorged quote block", async () => {
    await expect(
      venue.buildTransaction({ quote: poolBuyQuote(), walletAddress: WALLET }, { caller: new FakeCaller(), probe: fakeProbe(), now: () => new Date("2026-09-25T00:01:00.000Z") })
    ).resolves.toMatchObject({ status: "REFUSED", reason: "QUOTE_EXPIRED" });

    await expect(
      venue.buildTransaction(
        { quote: poolBuyQuote(), walletAddress: WALLET },
        { caller: new FakeCaller({ blockHash: "0xdead000000000000000000000000000000000000000000000000000000000000" }), probe: fakeProbe(), now: () => NOW }
      )
    ).resolves.toMatchObject({ status: "REFUSED", reason: "QUOTE_BLOCK_REORGED" });
  });

  it("refuses an ERC-20 input larger than a Permit2 allowance can carry", async () => {
    const huge = ((1n << 160n) + 1n).toString();
    const quote = poolSellQuote({ input: { currency: TOKEN, symbol: "DRIFT", decimals: 18, amount: huge } });
    const outcome = await venue.buildTransaction({ quote, walletAddress: WALLET }, { caller: new FakeCaller(), probe: fakeProbe(), now: () => NOW });
    expect(outcome).toMatchObject({ status: "REFUSED", reason: "UNSUPPORTED_ROUTE" });
  });
});

// --- reconciliation -------------------------------------------------------------------

const SWAP_TOPIC0 = toEventSelector(getAbiItem({ abi: UNISWAP_V4_POOL_MANAGER_ABI, name: "Swap" }));

function swapLog(params: { poolId: string; amount0: bigint; amount1: bigint; address?: string }) {
  return {
    address: params.address ?? UNISWAP_V4_ROBINHOOD.poolManager,
    topics: [SWAP_TOPIC0, params.poolId, pad(WALLET as `0x${string}`, { size: 32 })],
    data: encodeAbiParameters(
      [{ type: "int128" }, { type: "int128" }, { type: "uint160" }, { type: "uint128" }, { type: "int24" }, { type: "uint24" }],
      [params.amount0, params.amount1, 79228162514264337593543950336n, 1_000_000n, 0, 3000]
    ),
  };
}

describe("RobinhoodUniswapV4ExecutionVenue.reconcile", () => {
  const plan = {
    venue: "ROBINHOOD_UNISWAP_V4" as const,
    route: { kind: "UNIVERSAL_ROUTER" as const, target: ROUTER },
    chainId: 4663,
    walletAddress: WALLET.toLowerCase(),
    side: "buy" as const,
    tokenAddress: TOKEN,
    approvals: [],
    swap: { chainId: 4663, to: ROUTER, data: "0x" as const, value: "0", gasLimit: null, description: "" },
    poolId: POOL_ID,
    deadline: (BLOCK_SECONDS + 600n).toString(),
    expectedOutput: "5000",
    minimumOutput: "4950",
    quoteBlock: BLOCK,
    calldataVersion: "test",
  };

  const receipt = (overrides: Partial<ReceiptFacts> = {}): ReceiptFacts => ({
    status: "success",
    blockNumber: 62211540n,
    blockHash: "0xbeef",
    gasUsed: 180_000n,
    effectiveGasPrice: null,
    logs: [],
    ...overrides,
  });

  it("reads trader-side amounts: negative is paid, positive is received", () => {
    // Trader paid 1000 of currency0 (ETH) and received 4980 of currency1 (the token).
    const result = venue.reconcile({ plan, receipt: receipt({ logs: [swapLog({ poolId: POOL_ID, amount0: -1000n, amount1: 4980n })] }) });
    expect(result.actualInput).toBe("1000");
    expect(result.actualOutput).toBe("4980");
  });

  it("reads a sell the same way, with the legs reversed", () => {
    const result = venue.reconcile({
      plan: { ...plan, side: "sell" as const },
      receipt: receipt({ logs: [swapLog({ poolId: POOL_ID, amount0: 990n, amount1: -5000n })] }),
    });
    expect(result.actualInput).toBe("5000");
    expect(result.actualOutput).toBe("990");
  });

  it("ignores a Swap from a different pool in the same transaction", () => {
    const other = "0xcccc000000000000000000000000000000000000000000000000000000000000";
    const result = venue.reconcile({ plan, receipt: receipt({ logs: [swapLog({ poolId: other, amount0: -1n, amount1: 2n })] }) });
    expect(result.actualOutput).toBeNull();
  });

  it("picks this plan's pool out of several Swaps", () => {
    const other = "0xcccc000000000000000000000000000000000000000000000000000000000000";
    const logs = [swapLog({ poolId: other, amount0: -7n, amount1: 8n }), swapLog({ poolId: POOL_ID, amount0: -1000n, amount1: 4980n })];
    const result = venue.reconcile({ plan, receipt: receipt({ logs }) });
    expect(result.actualOutput).toBe("4980");
  });

  it("ignores a Swap emitted by something other than the verified PoolManager", () => {
    const log = swapLog({ poolId: POOL_ID, amount0: -1000n, amount1: 4980n, address: "0x9999999999999999999999999999999999999999" });
    const result = venue.reconcile({ plan, receipt: receipt({ logs: [log] }) });
    expect(result.actualOutput).toBeNull();
  });

  it("reports a revert without amounts", () => {
    const result = venue.reconcile({ plan, receipt: receipt({ status: "reverted" }) });
    expect(result.status).toBe("REVERTED");
    expect(result.actualOutput).toBeNull();
    expect(result.failureReason).toBeTruthy();
  });

  it("never claims a wallet match, because Swap carries no recipient", () => {
    const result = venue.reconcile({ plan, receipt: receipt({ logs: [swapLog({ poolId: POOL_ID, amount0: -1000n, amount1: 4980n })] }) });
    expect(result.matchedWallet).toBe(false);
  });
});
