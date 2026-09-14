import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { quoteCurveBuy, quoteCurveSell, snipeWindowOpen, type CurveState } from "../quote/curveQuote";

/**
 * Phase 7D.3.2 §4 — curve quotes against real execution.
 *
 * Every row was produced by evm-verification/test/fork/PonsCurveFork.t.sol: the real
 * PonsV2BondingCurve on a Robinhood Chain fork at block 62211539, state read, trade
 * executed, balance change measured. `observedOut`/`observedSpend` are what a wallet
 * actually got. The TypeScript formula must reproduce them to the wei.
 */

interface ForkRow {
  source: string;
  block: number;
  case: string;
  side: "buy" | "sell";
  feeBps: number;
  creatorTaxBps: number;
  amountIn: string;
  quoteReserve: string;
  tokenReserve: string;
  sellableTokens: string;
  observedOut: string;
  observedSpend: string;
  fee: string;
  creatorTax: string;
  clamped: boolean;
}

function rows(file: string): ForkRow[] {
  return readFileSync(join(__dirname, "../__fixtures__/forkEvidence", file), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

/** At the pinned block every sampled curve was past its 3 s snipe window and trading. */
const LAUNCHED_LONG_AGO = 0n;
const BLOCK_TIMESTAMP = 1_789_328_376n;

function stateFor(row: ForkRow): CurveState {
  return {
    quoteReserve: BigInt(row.quoteReserve),
    tokenReserve: BigInt(row.tokenReserve),
    feeBps: BigInt(row.feeBps),
    creatorTaxBps: BigInt(row.creatorTaxBps),
    sellableTokens: BigInt(row.sellableTokens),
    graduated: false,
    readyToGraduate: false,
    snipeTaxStartBps: 9_900n,
    snipeTaxSeconds: 3n,
    launchedAt: LAUNCHED_LONG_AGO,
  };
}

const QUOTE_ROWS = rows("curve-quotes.jsonl");
const CLAMP_ROWS = rows("curve-clamp.jsonl");

describe("fork evidence", () => {
  it("is actual-Pons execution at the pinned block, covering both directions and a clamp", () => {
    expect(QUOTE_ROWS.length).toBe(18);
    expect(new Set(QUOTE_ROWS.map((r) => r.source))).toEqual(new Set(["actual-pons-fork"]));
    expect(new Set(QUOTE_ROWS.map((r) => r.block))).toEqual(new Set([62211539]));
    expect(QUOTE_ROWS.some((r) => r.side === "buy")).toBe(true);
    expect(QUOTE_ROWS.some((r) => r.side === "sell")).toBe(true);
    expect(CLAMP_ROWS[0].clamped).toBe(true);
  });
});

describe("quoteCurveBuy reproduces real execution", () => {
  it.each([...QUOTE_ROWS.filter((r) => r.side === "buy"), ...CLAMP_ROWS].map((r) => [`${r.case} ${r.amountIn}`, r]))(
    "%s",
    (_label, row) => {
      const q = quoteCurveBuy(stateFor(row as ForkRow), BigInt((row as ForkRow).amountIn), BLOCK_TIMESTAMP);
      if (!q.ok) throw new Error(`refused: ${q.refusal}`);
      expect(q.tokensOut.toString()).toBe((row as ForkRow).observedOut);
      expect(q.spent.toString()).toBe((row as ForkRow).observedSpend);
      expect(q.protocolFee.toString()).toBe((row as ForkRow).fee);
      expect(q.creatorTax.toString()).toBe((row as ForkRow).creatorTax);
      expect(q.clamped).toBe((row as ForkRow).clamped);
      expect(q.refund).toBe(BigInt((row as ForkRow).amountIn) - q.spent);
    }
  );
});

describe("quoteCurveSell reproduces real execution", () => {
  it.each(QUOTE_ROWS.filter((r) => r.side === "sell").map((r) => [`${r.case} ${r.amountIn}`, r]))("%s", (_label, row) => {
    const q = quoteCurveSell(stateFor(row as ForkRow), BigInt((row as ForkRow).amountIn));
    if (!q.ok) throw new Error(`refused: ${q.refusal}`);
    expect(q.quoteOut.toString()).toBe((row as ForkRow).observedOut);
    expect(q.protocolFee.toString()).toBe((row as ForkRow).fee);
    expect(q.creatorTax.toString()).toBe((row as ForkRow).creatorTax);
  });
});

describe("refusals fail closed instead of inventing a number", () => {
  const base = stateFor(QUOTE_ROWS[0]);

  it("refuses inside the anti-snipe window, which is not modelled", () => {
    const fresh = { ...base, launchedAt: BLOCK_TIMESTAMP - 1n };
    expect(snipeWindowOpen(fresh, BLOCK_TIMESTAMP)).toBe(true);
    expect(quoteCurveBuy(fresh, 10n ** 16n, BLOCK_TIMESTAMP)).toEqual({ ok: false, refusal: "SNIPE_WINDOW_OPEN" });
  });

  it("does not refuse when the launch disabled the snipe tax", () => {
    const fresh = { ...base, launchedAt: BLOCK_TIMESTAMP, snipeTaxStartBps: 0n };
    expect(quoteCurveBuy(fresh, 10n ** 16n, BLOCK_TIMESTAMP).ok).toBe(true);
  });

  it("refuses buys on an exhausted allocation and sells once ready to graduate", () => {
    expect(quoteCurveBuy({ ...base, sellableTokens: 0n }, 10n ** 16n, BLOCK_TIMESTAMP)).toEqual({ ok: false, refusal: "CURVE_GRADUATED" });
    expect(quoteCurveSell({ ...base, readyToGraduate: true }, 10n ** 18n)).toEqual({ ok: false, refusal: "CURVE_GRADUATED" });
    expect(quoteCurveSell({ ...base, graduated: true }, 10n ** 18n)).toEqual({ ok: false, refusal: "CURVE_GRADUATED" });
  });

  it("refuses zero and dust that rounds to nothing", () => {
    expect(quoteCurveBuy(base, 0n, BLOCK_TIMESTAMP)).toEqual({ ok: false, refusal: "ZERO_AMOUNT" });
    expect(quoteCurveSell(base, 1n)).toEqual({ ok: false, refusal: "OUTPUT_ROUNDS_TO_ZERO" });
  });
});
