/**
 * Phase 7D.4 §5/§6 — Practice ledger, plans, reviews, lesson progress and achievements on real
 * PostgreSQL. Disposable database only.
 *
 *   PAPER_RUN_DB_TESTS=true DATABASE_URL=postgresql://…/ci_x_test npx vitest run --no-file-parallelism src/services/__tests__/practiceService.dbIntegration.test.ts
 */
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { PonsQuote } from "../../pons/quote/quoteService";
import type { SimulationOutcome } from "../../pons/quote/simulationService";
import { saveQuoteSnapshot, saveSimulationSnapshot } from "../paperTradingService";
import {
  acknowledgeLessonStep,
  createPlan,
  createPortfolio,
  getLessonProgress,
  getPortfolio,
  placePracticeTrade,
  recordSizeComparison,
  reviewPlan,
} from "../practiceService";

const RUN = process.env.PAPER_RUN_DB_TESTS === "true";
const TOKEN = "0x1111111111111111111111111111111111111111";
const ETH = "0x0000000000000000000000000000000000000000";
const USER_A = "aaaaaaaa-7d40-4000-8000-00000000000a";
const USER_B = "bbbbbbbb-7d40-4000-8000-00000000000b";
const E18 = 10n ** 18n;

function quote(side: "buy" | "sell", amountIn: bigint, amountOut: bigint, allInBps = 250): PonsQuote {
  const now = Date.now();
  const tokenLeg = { currency: TOKEN, symbol: "TST", decimals: 18 };
  const ethLeg = { currency: ETH, symbol: "ETH", decimals: 18 };
  return {
    chain: "robinhood",
    chainId: 4663,
    tokenAddress: TOKEN,
    side,
    venue: "PONS_V2_BONDING_CURVE",
    method: "CURVE_FORMULA_AT_PINNED_BLOCK",
    input: { ...(side === "buy" ? ethLeg : tokenLeg), amount: amountIn.toString() },
    output: { ...(side === "buy" ? tokenLeg : ethLeg), amount: amountOut.toString(), expected: amountOut.toString(), minimum: ((amountOut * 99n) / 100n).toString() },
    spent: amountIn.toString(),
    refund: "0",
    slippageBps: 100,
    fees: [],
    priceImpact: { allInBps, poolOnlyBps: null, spotOutPerInX36: "1" },
    block: { number: "1", hash: "0x" + "ab".repeat(32), timestamp: "1789328376" },
    quotedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 30_000).toISOString(),
    calculationVersion: "test",
    policyVersion: "quote-policy-1",
    venueState: {} as never,
    warnings: [],
    limitations: [],
    sourceReferences: [],
  } as PonsQuote;
}

describe.skipIf(!RUN)("practiceService — real Postgres", () => {
  const db = new PrismaClient();
  let seq = 0;
  const key = () => `k-${Date.now()}-${seq++}`;

  async function savedQuote(q: PonsQuote, simulate = false) {
    const snap = await saveQuoteSnapshot(db, { status: "QUOTED", quote: q }, { tokenAddress: TOKEN, side: q.side, amountIn: q.input.amount, slippageBps: 100 });
    if (!simulate) return { quoteId: snap.id, simulationId: null as string | null };
    const sim = await saveSimulationSnapshot(db, snap, {
      status: "SIMULATED",
      block: q.block,
      simulatedAt: new Date().toISOString(),
      method: "ETH_CALL_STATE_OVERRIDE",
      route: { kind: "BONDING_CURVE", target: TOKEN },
      account: "0x0000000000000000000000000000000051350001",
      simulator: { sourceSha256: "x", runtimeCodeHash: "y" },
      inputBalanceOverride: { currency: q.input.currency, slot: null },
      result: { success: true, spent: q.spent, received: q.output.expected, gasUsed: "1", expectedOut: q.output.expected, minimumOut: q.output.minimum, matchesQuote: true, revert: null },
      calculationVersion: "test",
      limitations: [],
    } as unknown as SimulationOutcome as never);
    return { quoteId: snap.id, simulationId: sim.id };
  }

  async function cleanup() {
    for (const userId of [USER_A, USER_B]) {
      await db.practicePortfolio.deleteMany({ where: { userId } });
      await db.practiceAchievement.deleteMany({ where: { userId } });
      await db.practiceLessonProgress.deleteMany({ where: { userId } });
      await db.practiceReview.deleteMany({ where: { userId } });
    }
  }
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await db.$disconnect();
  });

  const portfolio = async (userId = USER_A, eth = 1n * E18) => {
    const r = await createPortfolio(db, { userId, idempotencyKey: key(), name: "Practice", balances: [{ currency: ETH, amount: eth.toString() }] });
    if (!r.ok) throw new Error(r.message);
    return r.value;
  };

  it("creates a portfolio only in verified quote currencies, idempotently", async () => {
    const k = key();
    const first = await createPortfolio(db, { userId: USER_A, idempotencyKey: k, name: "Mine", balances: [{ currency: ETH, amount: (2n * E18).toString() }] });
    const again = await createPortfolio(db, { userId: USER_A, idempotencyKey: k, name: "Mine", balances: [{ currency: ETH, amount: (2n * E18).toString() }] });
    expect(first.ok && again.ok && first.value.id === again.value.id && again.created === false).toBe(true);
    const reused = await createPortfolio(db, { userId: USER_A, idempotencyKey: k, name: "Other", balances: [{ currency: ETH, amount: "1" }] });
    expect(reused).toMatchObject({ ok: false, code: "IDEMPOTENCY_KEY_REUSED" });
    const fake = await createPortfolio(db, { userId: USER_A, idempotencyKey: key(), name: "Fake", balances: [{ currency: TOKEN, amount: "1" }] });
    expect(fake).toMatchObject({ ok: false, code: "UNSUPPORTED_CURRENCY" });
  });

  it("buys with paper cash, sells what is held, and books realized PnL with proportional cost basis", async () => {
    const p = await portfolio();
    const buy = await savedQuote(quote("buy", E18 / 2n, 1_000n * E18), true);
    const b = await placePracticeTrade(db, { userId: USER_A, idempotencyKey: key(), portfolioId: p.id, ...buy, planId: null });
    expect(b.ok).toBe(true);
    const sell = await savedQuote(quote("sell", 400n * E18, E18 / 4n));
    const s = await placePracticeTrade(db, { userId: USER_A, idempotencyKey: key(), portfolioId: p.id, ...sell, planId: null });
    expect(s.ok).toBe(true);
    const state = await getPortfolio(db, USER_A, p.id);
    expect(state!.balances[0].amount.toFixed()).toBe((E18 / 2n + E18 / 4n).toString());
    const h = state!.holdings[0];
    expect(h.amount.toFixed()).toBe((600n * E18).toString());
    expect(h.costBasis.toFixed()).toBe((E18 * 3n / 10n).toString()); // 0.5 ETH × 600/1000
    expect(h.realizedPnl.toFixed()).toBe((E18 / 4n - E18 / 5n).toString()); // 0.25 − 0.2
    expect(state!.trades.find((t) => t.side === "buy")!.fillBasis).toBe("EXECUTION_SIMULATION");
  });

  it("refuses to overspend paper cash or oversell a holding", async () => {
    const p = await portfolio(USER_A, E18 / 10n);
    const big = await savedQuote(quote("buy", E18, 10n * E18));
    expect(await placePracticeTrade(db, { userId: USER_A, idempotencyKey: key(), portfolioId: p.id, ...big, planId: null })).toMatchObject({ ok: false, code: "INSUFFICIENT_PAPER_BALANCE" });
    const sell = await savedQuote(quote("sell", E18, E18));
    expect(await placePracticeTrade(db, { userId: USER_A, idempotencyKey: key(), portfolioId: p.id, ...sell, planId: null })).toMatchObject({ ok: false, code: "INSUFFICIENT_PAPER_HOLDING" });
  });

  it("does not overspend under concurrent entries", async () => {
    const p = await portfolio(USER_A, E18);
    const quotes = await Promise.all(Array.from({ length: 5 }, () => savedQuote(quote("buy", (E18 * 3n) / 10n, 100n * E18))));
    const results = await Promise.all(quotes.map((q) => placePracticeTrade(db, { userId: USER_A, idempotencyKey: key(), portfolioId: p.id, ...q, planId: null })));
    expect(results.filter((r) => r.ok)).toHaveLength(3); // 3 × 0.3 ≤ 1 < 4 × 0.3
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.code === "INSUFFICIENT_PAPER_BALANCE")).toBe(true);
    const state = await getPortfolio(db, USER_A, p.id);
    expect(state!.balances[0].amount.toFixed()).toBe((E18 / 10n).toString());
  });

  it("replays a repeated trade request instead of filling twice", async () => {
    const p = await portfolio();
    const q = await savedQuote(quote("buy", E18 / 10n, 10n * E18));
    const k = key();
    const [one, two] = await Promise.all([
      placePracticeTrade(db, { userId: USER_A, idempotencyKey: k, portfolioId: p.id, ...q, planId: null }),
      placePracticeTrade(db, { userId: USER_A, idempotencyKey: k, portfolioId: p.id, ...q, planId: null }),
    ]);
    expect(one.ok && two.ok).toBe(true);
    const state = await getPortfolio(db, USER_A, p.id);
    expect(state!.trades).toHaveLength(1);
    expect(state!.balances[0].amount.toFixed()).toBe(((E18 * 9n) / 10n).toString());
  });

  it("keeps users apart: B cannot read or trade in A's portfolio", async () => {
    const p = await portfolio(USER_A);
    expect(await getPortfolio(db, USER_B, p.id)).toBeNull();
    const q = await savedQuote(quote("buy", E18 / 10n, E18));
    expect(await placePracticeTrade(db, { userId: USER_B, idempotencyKey: key(), portfolioId: p.id, ...q, planId: null })).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("awards learning achievements from facts, once each, and completes the lesson only when every step is done", async () => {
    const p = await portfolio();
    const plan = await createPlan(db, { userId: USER_A, idempotencyKey: key(), portfolioId: p.id, tokenAddress: TOKEN, thesis: "Test the curve with a small size first.", exitNote: "Exit after the review." });
    expect(plan.ok).toBe(true);
    const planId = plan.ok ? plan.value.id : "";

    const small = await savedQuote(quote("buy", E18 / 100n, 10n * E18, 120));
    const large = await savedQuote(quote("buy", E18 / 2n, 400n * E18, 900));
    expect((await recordSizeComparison(db, { userId: USER_A, quoteIds: [small.quoteId, large.quoteId] })).ok).toBe(true);
    expect(await acknowledgeLessonStep(db, { userId: USER_A, step: "place-trade" })).toMatchObject({ ok: false });

    const entry = await savedQuote(quote("buy", E18 / 10n, 50n * E18), true);
    await placePracticeTrade(db, { userId: USER_A, idempotencyKey: key(), portfolioId: p.id, ...entry, planId });
    expect(await reviewPlan(db, { userId: USER_A, planId, outcome: "MATCHED_PLAN", notes: "Too early to review." })).toMatchObject({ ok: false, code: "PLAN_NOT_CLOSEABLE" });
    const exit = await savedQuote(quote("sell", 50n * E18, E18 / 12n));
    await placePracticeTrade(db, { userId: USER_A, idempotencyKey: key(), portfolioId: p.id, ...exit, planId });
    expect((await reviewPlan(db, { userId: USER_A, planId, outcome: "MATCHED_PLAN", notes: "Followed the plan; the price moved against me." })).ok).toBe(true);

    let progress = await getLessonProgress(db, USER_A);
    expect(progress.value.complete).toBe(false);
    await acknowledgeLessonStep(db, { userId: USER_A, step: "preview-costs" });
    progress = (await acknowledgeLessonStep(db, { userId: USER_A, step: "track" })) as typeof progress;
    expect(progress.value.complete).toBe(true);
    const earned = progress.value.achievements.filter((a) => a.earned).map((a) => a.code).sort();
    expect(earned).toEqual(["COMPARED_ORDER_SIZES", "INTRO_LESSON_COMPLETE", "RECORDED_TRADE_PLAN", "REVIEWED_PAPER_TRADE"]);
    await getLessonProgress(db, USER_A);
    expect(await db.practiceAchievement.count({ where: { userId: USER_A } })).toBe(4);
    expect(await db.practiceAchievement.count({ where: { userId: USER_B } })).toBe(0);
  });
});
