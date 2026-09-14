import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeAbiParameters, type Hex } from "viem";
import { describe, expect, it } from "vitest";

import { poolIdFor, sortCurrencies } from "../v4PoolState";
import {
  encodeRouterExactInSingle,
  minimumOutput,
  reconstructHookTake,
  shortfallVsSpotBps,
  spotOutPerInX36,
  v4Direction,
} from "../quote/v4Quote";

/**
 * Phase 7D.3.2 §2 — derivations around the official quoter, checked against real
 * execution. Each row of v4-exact-input.jsonl is one swap through the deployed
 * UniversalRouter on a fork at block 62211539, with the quote, the recipient's measured
 * balance change and the hook's own HookFeeCollected amounts.
 */

interface V4Row {
  source: string;
  case: string;
  token: string;
  pairToken: string;
  poolId: string;
  memecoinIsCurrency0: boolean;
  hookFeeBps: number;
  creatorTaxBps: number;
  side: "buy" | "sell";
  amountSpecified: string;
  quoted: string;
  observed: string;
  hookFee: string;
  creatorTax: string;
  sqrtPriceBefore: string;
  sqrtPriceAfter: string;
}

const ROWS: V4Row[] = readFileSync(join(__dirname, "../__fixtures__/forkEvidence/v4-exact-input.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));

const HOOK = "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044" as Hex;

describe("fork evidence coverage", () => {
  it("covers both currency orders, 6/8/18-decimal pair assets, and 1%–6% total fees", () => {
    expect(ROWS.length).toBe(42);
    expect(ROWS.every((r) => r.quoted === r.observed)).toBe(true);
    expect(new Set(ROWS.map((r) => r.memecoinIsCurrency0))).toEqual(new Set([true, false]));
    expect(new Set(ROWS.map((r) => r.hookFeeBps + r.creatorTaxBps))).toEqual(new Set([100, 200, 300, 600]));
  });
});

describe("pool identity and direction", () => {
  it.each(ROWS.filter((_, i) => i % 6 === 0).map((r) => [r.case, r]))("%s", (_l, row) => {
    const r = row as V4Row;
    const [currency0, currency1] = sortCurrencies(r.pairToken, r.token);
    const poolKey = { currency0, currency1, fee: 0, tickSpacing: 200, hooks: HOOK };
    expect(poolIdFor(poolKey)).toBe(r.poolId.toLowerCase());
    expect(currency0 === r.token.toLowerCase()).toBe(r.memecoinIsCurrency0);

    const buy = v4Direction({ side: "buy", memecoinIsCurrency0: r.memecoinIsCurrency0, poolKey });
    expect(buy.outputCurrency).toBe(r.token.toLowerCase());
    const sell = v4Direction({ side: "sell", memecoinIsCurrency0: r.memecoinIsCurrency0, poolKey });
    expect(sell.inputCurrency).toBe(r.token.toLowerCase());
    expect(sell.zeroForOne).toBe(!buy.zeroForOne);
  });
});

describe("reconstructHookTake matches the hook's own HookFeeCollected event", () => {
  it.each(ROWS.map((r) => [`${r.case} ${r.side} ${r.amountSpecified}`, r]))("%s", (_l, row) => {
    const r = row as V4Row;
    const take = reconstructHookTake(BigInt(r.observed), r.hookFeeBps, r.creatorTaxBps);
    expect(take).not.toBeNull();
    // The true split is always one of the candidates, and never more than 1 wei apart.
    expect(take!.candidates.some((c) => c.hookFee.toString() === r.hookFee && c.creatorTax.toString() === r.creatorTax)).toBe(true);
    expect(take!.hookFee.max - take!.hookFee.min).toBeLessThanOrEqual(1n);
    expect(take!.creatorTax.max - take!.creatorTax.min).toBeLessThanOrEqual(1n);
    expect(take!.exact).toBe(take!.candidates.length === 1);
  });

  it("is genuinely ambiguous for some real swaps, which is why it returns a range", () => {
    const ambiguous = ROWS.filter((r) => !reconstructHookTake(BigInt(r.observed), r.hookFeeBps, r.creatorTaxBps)!.exact);
    expect(ambiguous.length).toBeGreaterThan(0);
  });
});

describe("price impact is measured against the pre-trade pool price", () => {
  it("rises with size and is at least the hook's fee", () => {
    const sma = ROWS.filter((r) => r.case.startsWith("native ETH, memecoin currency1") && r.side === "buy");
    const impacts = sma.map((r) =>
      shortfallVsSpotBps({
        amountIn: BigInt(r.amountSpecified),
        outAmount: BigInt(r.quoted),
        spotX36: spotOutPerInX36(BigInt(r.sqrtPriceBefore), true),
      })
    );
    expect(impacts[0]).toBeGreaterThanOrEqual(300); // 100 bps hook fee + 200 bps creator tax
    expect(impacts[1]).toBeGreaterThan(impacts[0]);
    expect(impacts[2]).toBeGreaterThan(impacts[1]);
  });

  it("reports the recorded 1,000,000 ETH input as a near-total loss", () => {
    const oversized = JSON.parse(readFileSync(join(__dirname, "../__fixtures__/forkEvidence/v4-oversized-input.json"), "utf8"));
    const sma = ROWS.find((r) => r.case.startsWith("native ETH, memecoin currency1") && r.side === "buy")!;
    const impact = shortfallVsSpotBps({
      amountIn: BigInt(oversized.requested),
      outAmount: BigInt(oversized.quotedOut),
      spotX36: spotOutPerInX36(BigInt(sma.sqrtPriceBefore), true),
    });
    expect(oversized.quoteSucceeded && oversized.executionSucceeded).toBe(true);
    expect(impact).toBeGreaterThan(9_900);
  });
});

describe("price impact at extreme price ratios (regression)", () => {
  // Pools like LASSIE/USDG (tick −407072) and HODLER/cbBTC (tick −470238) price the memecoin
  // at ~1e-18 to 1e-20 pair base units per token base unit. With 1e18 scaling their sells
  // read as 0 bps impact despite a 1–3% hook take. Every real swap must show at least the fee.
  it.each(ROWS.map((r) => [`${r.case} ${r.side} ${r.amountSpecified}`, r]))("%s is at least its hook fee", (_l, row) => {
    const r = row as V4Row;
    const [currency0, currency1] = sortCurrencies(r.pairToken, r.token);
    const poolKey = { currency0, currency1, fee: 0, tickSpacing: 200, hooks: HOOK };
    const dir = v4Direction({ side: r.side, memecoinIsCurrency0: r.memecoinIsCurrency0, poolKey });
    const impact = shortfallVsSpotBps({
      amountIn: BigInt(r.amountSpecified),
      outAmount: BigInt(r.quoted),
      spotX36: spotOutPerInX36(BigInt(r.sqrtPriceBefore), dir.zeroForOne),
    });
    // Integer flooring of the fee can shave a fraction of a basis point at tiny sizes.
    expect(impact).toBeGreaterThanOrEqual(r.hookFeeBps + r.creatorTaxBps - 1);
  });
});

describe("minimumOutput", () => {
  it("floors, so the minimum never exceeds what the tolerance allows", () => {
    expect(minimumOutput(10_000n, 100)).toBe(9_900n);
    expect(minimumOutput(10_001n, 100)).toBe(9_900n);
    expect(minimumOutput(123n, 0)).toBe(123n);
  });
});

describe("encodeRouterExactInSingle", () => {
  it("encodes V4_SWAP with SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL and the deployed router's param shape", () => {
    const poolKey = {
      currency0: "0x0000000000000000000000000000000000000000" as Hex,
      currency1: "0x3bd9136d51af679bd1b11d06b951155543c5449f" as Hex,
      fee: 0,
      tickSpacing: 200,
      hooks: HOOK,
    };
    const { commands, inputs } = encodeRouterExactInSingle({ poolKey, zeroForOne: true, amountIn: 10n ** 16n, minimumOut: 5n });
    expect(commands).toBe("0x10");
    const [actions, params] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], inputs[0]);
    expect(actions).toBe("0x060c0f");
    expect(params).toHaveLength(3);
    const [settleCurrency, settleAmount] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }], params[1]);
    expect(settleCurrency).toBe("0x0000000000000000000000000000000000000000");
    expect(settleAmount).toBe(10n ** 16n);
    const [takeCurrency, takeMin] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }], params[2]);
    expect(takeCurrency.toLowerCase()).toBe(poolKey.currency1);
    expect(takeMin).toBe(5n);
  });
});
