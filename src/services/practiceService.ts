/**
 * Phase 7D.4 §5/§6 — Practice: paper-money portfolios, plans, entries/exits, reviews, the intro
 * lesson and learning achievements.
 *
 * Rules:
 *   - Every row belongs to one Supabase user; every read and write is scoped by userId.
 *   - Every create is idempotent on (userId, Idempotency-Key) with a request fingerprint, like paper
 *     positions: the same request replays, a different request with the same key is refused.
 *   - Fills come only from an unexpired quote and, optionally, a successful simulation of that same
 *     quote. Nothing here prices a trade itself.
 *   - Paper cash is per quote currency. A buy needs that much cash; a sell needs that many tokens.
 *     Both run in a serializable transaction with the balance and holding rows locked, and the
 *     database's CHECK constraints refuse negative amounts regardless.
 *   - Achievements reward learning and reviewing, never spending, frequency, risk or profit, and
 *     are awarded from facts in the database, not from what a client claims.
 */

import { createHash } from "node:crypto";

import { Prisma, type PrismaClient } from "@prisma/client";

import { lookupQuoteAsset } from "../pons/usd/chainlinkQuoteUsdRateProvider";
import { canonicalJson, quoteFromSnapshot, simulationFromSnapshot } from "./paperTradingService";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const CHAIN = "robinhood";

export const ACHIEVEMENTS = {
  INTRO_LESSON_COMPLETE: { title: "Finished the practice lesson", description: "Worked through every step of the introductory lesson." },
  COMPARED_ORDER_SIZES: { title: "Compared order sizes", description: "Quoted the same trade at two sizes and saw how size changes the price you get." },
  RECORDED_TRADE_PLAN: { title: "Wrote a trade plan", description: "Recorded why, how much and when to exit before trading." },
  REVIEWED_PAPER_TRADE: { title: "Reviewed a practice trade", description: "Compared a closed practice trade with its plan." },
} as const;
export type AchievementCode = keyof typeof ACHIEVEMENTS;

export const INTRO_LESSON_ID = "intro-v1";
/** Lesson steps A–H. Steps backed by data are derived from the database; the rest are acknowledgements. */
export const INTRO_LESSON_STEPS = ["portfolio", "plan", "compare-sizes", "preview-costs", "simulate", "place-trade", "track", "close-and-review"] as const;
export type LessonStep = (typeof INTRO_LESSON_STEPS)[number];
const ACKNOWLEDGED_STEPS: readonly LessonStep[] = ["preview-costs", "track"];

/** Upper bound on starting paper cash per currency, in whole units: keeps practice realistic and amounts bounded. */
const MAX_STARTING_WHOLE_UNITS = 1_000_000n;

export type PracticeError =
  | "NOT_FOUND"
  | "INVALID_REQUEST"
  | "UNSUPPORTED_CURRENCY"
  | "IDEMPOTENCY_KEY_REUSED"
  | "QUOTE_NOT_FOUND"
  | "QUOTE_NOT_FILLABLE"
  | "QUOTE_EXPIRED"
  | "SIMULATION_NOT_FOUND"
  | "SIMULATION_NOT_FOR_QUOTE"
  | "SIMULATION_NOT_SUCCESSFUL"
  | "NO_PAPER_BALANCE_IN_CURRENCY"
  | "INSUFFICIENT_PAPER_BALANCE"
  | "INSUFFICIENT_PAPER_HOLDING"
  | "PLAN_MISMATCH"
  | "PLAN_NOT_CLOSEABLE"
  | "ALREADY_REVIEWED";

export type Result<T> = { ok: true; created?: boolean; value: T } | { ok: false; code: PracticeError; message: string };
const fail = (code: PracticeError, message: string): { ok: false; code: PracticeError; message: string } => ({ ok: false, code, message });

const PORTFOLIO_INCLUDE = { balances: true, holdings: true } as const;
export type PortfolioWithState = Prisma.PracticePortfolioGetPayload<{ include: typeof PORTFOLIO_INCLUDE }>;

async function award(db: Prisma.TransactionClient | PrismaClient, userId: string, code: AchievementCode, evidence: Record<string, unknown>): Promise<boolean> {
  const inserted = await db.$executeRaw`
    INSERT INTO "PracticeAchievement" ("userId", code, evidence, "awardedAt")
    VALUES (${userId}, ${code}, ${JSON.stringify(evidence)}::jsonb, now())
    ON CONFLICT ("userId", code) DO NOTHING`;
  return inserted > 0;
}

/** Postgres 40001 (serialization) or 40P01 (deadlock), whether Prisma reports it as P2034 or as a raw-query P2010. */
function isSerializationFailure(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === "P2034") return true;
  const code = (error.meta as { code?: string } | undefined)?.code;
  return error.code === "P2010" && (code === "40001" || code === "40P01" || /40001|40P01/.test(error.message));
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

// ---------------------------------------------------------------------------------------------
// Portfolios

export async function createPortfolio(
  db: PrismaClient,
  params: { userId: string; idempotencyKey: string; name: string; balances: Array<{ currency: string; amount: string }> }
): Promise<Result<PortfolioWithState>> {
  const name = params.name.trim();
  if (!name || name.length > 60) return fail("INVALID_REQUEST", "name must be 1–60 characters");
  if (params.balances.length === 0 || params.balances.length > 4) return fail("INVALID_REQUEST", "start with 1–4 paper balances");
  const balances: Prisma.PracticeBalanceCreateWithoutPortfolioInput[] = [];
  const seen = new Set<string>();
  for (const b of params.balances) {
    const asset = lookupQuoteAsset(b.currency);
    if (!asset) return fail("UNSUPPORTED_CURRENCY", `paper balances can only be held in verified quote assets; ${b.currency} is not one`);
    if (seen.has(asset.address)) return fail("INVALID_REQUEST", `duplicate balance for ${asset.symbol}`);
    seen.add(asset.address);
    if (!/^\d+$/.test(b.amount) || BigInt(b.amount) === 0n) return fail("INVALID_REQUEST", "amounts are positive integers in base units");
    if (BigInt(b.amount) > MAX_STARTING_WHOLE_UNITS * 10n ** BigInt(asset.decimals)) return fail("INVALID_REQUEST", `starting ${asset.symbol} is capped at ${MAX_STARTING_WHOLE_UNITS} whole units`);
    balances.push({ currency: asset.address, symbol: asset.symbol, decimals: asset.decimals, startingAmount: new Prisma.Decimal(b.amount), amount: new Prisma.Decimal(b.amount) });
  }
  const fingerprint = sha256(canonicalJson({ name, balances: params.balances.map((b) => ({ currency: b.currency.toLowerCase(), amount: b.amount })) }));

  const existing = await db.practicePortfolio.findUnique({ where: { userId_idempotencyKey: { userId: params.userId, idempotencyKey: params.idempotencyKey } }, include: PORTFOLIO_INCLUDE });
  if (existing) return existing.requestFingerprint === fingerprint ? { ok: true, created: false, value: existing } : fail("IDEMPOTENCY_KEY_REUSED", "this idempotency key was already used for a different portfolio");

  try {
    const value = await db.practicePortfolio.create({
      data: { userId: params.userId, name, idempotencyKey: params.idempotencyKey, requestFingerprint: fingerprint, balances: { create: balances } },
      include: PORTFOLIO_INCLUDE,
    });
    return { ok: true, created: true, value };
  } catch (error) {
    if (isUniqueViolation(error)) return createPortfolio(db, params);
    throw error;
  }
}

export function listPortfolios(db: PrismaClient, userId: string) {
  return db.practicePortfolio.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, include: PORTFOLIO_INCLUDE, take: 20 });
}

export async function getPortfolio(db: PrismaClient, userId: string, portfolioId: string) {
  return db.practicePortfolio.findFirst({
    where: { id: portfolioId, userId },
    include: { ...PORTFOLIO_INCLUDE, trades: { orderBy: { createdAt: "desc" }, take: 100 }, plans: { orderBy: { createdAt: "desc" }, take: 50, include: { review: true } } },
  });
}

// ---------------------------------------------------------------------------------------------
// Plans and reviews

export async function createPlan(
  db: PrismaClient,
  params: { userId: string; idempotencyKey: string; portfolioId: string; tokenAddress: string; thesis: string; sizeNote?: string | null; exitNote?: string | null }
) {
  const thesis = params.thesis.trim();
  if (thesis.length < 10 || thesis.length > 2_000) return fail("INVALID_REQUEST", "describe the plan in 10–2000 characters");
  if (!/^0x[0-9a-fA-F]{40}$/.test(params.tokenAddress)) return fail("INVALID_REQUEST", "tokenAddress must be an EVM address");
  const portfolio = await db.practicePortfolio.findFirst({ where: { id: params.portfolioId, userId: params.userId }, select: { id: true } });
  if (!portfolio) return fail("NOT_FOUND", "no such portfolio");
  const data = { tokenAddress: params.tokenAddress.toLowerCase(), thesis, sizeNote: params.sizeNote?.trim() || null, exitNote: params.exitNote?.trim() || null };
  const fingerprint = sha256(canonicalJson({ portfolioId: params.portfolioId, ...data }));

  const existing = await db.practicePlan.findUnique({ where: { userId_idempotencyKey: { userId: params.userId, idempotencyKey: params.idempotencyKey } } });
  if (existing) return existing.requestFingerprint === fingerprint ? { ok: true as const, created: false, value: existing } : fail("IDEMPOTENCY_KEY_REUSED", "this idempotency key was already used for a different plan");

  try {
    const value = await db.$transaction(async (tx) => {
      const plan = await tx.practicePlan.create({ data: { userId: params.userId, portfolioId: params.portfolioId, chain: CHAIN, ...data, idempotencyKey: params.idempotencyKey, requestFingerprint: fingerprint } });
      await award(tx, params.userId, "RECORDED_TRADE_PLAN", { planId: plan.id });
      return plan;
    });
    return { ok: true as const, created: true, value };
  } catch (error) {
    if (isUniqueViolation(error)) return createPlan(db, params);
    throw error;
  }
}

export async function reviewPlan(db: PrismaClient, params: { userId: string; planId: string; outcome: string; notes: string }) {
  const outcomes = ["MATCHED_PLAN", "DEVIATED", "STOPPED_EARLY", "OTHER"];
  if (!outcomes.includes(params.outcome)) return fail("INVALID_REQUEST", `outcome must be one of ${outcomes.join(", ")}`);
  const notes = params.notes.trim();
  if (notes.length < 10 || notes.length > 2_000) return fail("INVALID_REQUEST", "write a review of 10–2000 characters");
  const plan = await db.practicePlan.findFirst({ where: { id: params.planId, userId: params.userId }, include: { review: true, trades: { select: { side: true } } } });
  if (!plan) return fail("NOT_FOUND", "no such plan");
  if (plan.review) return fail("ALREADY_REVIEWED", "this plan has already been reviewed");
  if (!plan.trades.some((t) => t.side === "buy") || !plan.trades.some((t) => t.side === "sell")) {
    return fail("PLAN_NOT_CLOSEABLE", "a plan is reviewed after its practice entry and exit");
  }
  try {
    const review = await db.$transaction(async (tx) => {
      const created = await tx.practiceReview.create({ data: { userId: params.userId, planId: plan.id, outcome: params.outcome, notes } });
      await tx.practicePlan.update({ where: { id: plan.id }, data: { status: "CLOSED", closedAt: new Date() } });
      await award(tx, params.userId, "REVIEWED_PAPER_TRADE", { planId: plan.id, reviewId: created.id });
      return created;
    });
    return { ok: true as const, created: true, value: review };
  } catch (error) {
    if (isUniqueViolation(error)) return fail("ALREADY_REVIEWED", "this plan has already been reviewed");
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Trades

export async function placePracticeTrade(
  db: PrismaClient,
  params: { userId: string; idempotencyKey: string; portfolioId: string; quoteId: string; simulationId: string | null; planId: string | null; now?: Date }
) {
  const fingerprint = sha256(canonicalJson({ portfolioId: params.portfolioId, quoteId: params.quoteId, simulationId: params.simulationId, planId: params.planId }));
  const replay = async () => {
    const existing = await db.practiceTrade.findUnique({ where: { userId_idempotencyKey: { userId: params.userId, idempotencyKey: params.idempotencyKey } } });
    if (!existing) return null;
    return existing.requestFingerprint === fingerprint ? { ok: true as const, created: false, value: existing } : fail("IDEMPOTENCY_KEY_REUSED", "this idempotency key was already used for a different practice trade");
  };
  const previous = await replay();
  if (previous) return previous;

  const portfolio = await db.practicePortfolio.findFirst({ where: { id: params.portfolioId, userId: params.userId }, select: { id: true } });
  if (!portfolio) return fail("NOT_FOUND", "no such portfolio");

  const now = params.now ?? new Date();
  const quoteSnapshot = await db.evidenceSnapshot.findUnique({ where: { id: params.quoteId } });
  if (!quoteSnapshot || quoteSnapshot.kind !== "QUOTE") return fail("QUOTE_NOT_FOUND", "no such quote");
  const quote = quoteFromSnapshot(quoteSnapshot);
  if (!quote) return fail("QUOTE_NOT_FILLABLE", "this quote did not produce a price, so there is nothing to fill");
  if (!quoteSnapshot.expiresAt || quoteSnapshot.expiresAt.getTime() <= now.getTime()) return fail("QUOTE_EXPIRED", "the quote has expired; request a new quote");

  let fillBasis: "EXECUTION_SIMULATION" | "QUOTE" = "QUOTE";
  let input = BigInt(quote.spent);
  let output = BigInt(quote.output.expected);
  if (params.simulationId) {
    const sim = await db.evidenceSnapshot.findUnique({ where: { id: params.simulationId } });
    if (!sim || sim.kind !== "SIMULATION") return fail("SIMULATION_NOT_FOUND", "no such simulation");
    if (sim.parentId !== quoteSnapshot.id) return fail("SIMULATION_NOT_FOR_QUOTE", "the simulation belongs to a different quote");
    const outcome = simulationFromSnapshot(sim);
    if (!outcome || outcome.status !== "SIMULATED") return fail("SIMULATION_NOT_SUCCESSFUL", "only a successful simulation can back a practice fill");
    fillBasis = "EXECUTION_SIMULATION";
    input = BigInt(outcome.result.spent);
    output = BigInt(outcome.result.received);
  }

  const token = quote.tokenAddress.toLowerCase();
  const quoteCurrency = (quote.side === "buy" ? quote.input.currency : quote.output.currency).toLowerCase();

  if (params.planId) {
    const plan = await db.practicePlan.findFirst({ where: { id: params.planId, userId: params.userId, portfolioId: params.portfolioId } });
    if (!plan || plan.tokenAddress !== token) return fail("PLAN_MISMATCH", "the plan belongs to a different portfolio or token");
    if (plan.status !== "OPEN") return fail("PLAN_MISMATCH", "the plan is already closed");
  }

  const run = () =>
    db.$transaction(
      async (tx) => {
        // Lock the rows this fill changes, so a concurrent fill waits and then sees the new amounts.
        const balances = await tx.$queryRaw<Array<{ amount: Prisma.Decimal }>>`
          SELECT amount FROM "PracticeBalance" WHERE "portfolioId" = ${params.portfolioId} AND currency = ${quoteCurrency} FOR UPDATE`;
        if (balances.length === 0) return fail("NO_PAPER_BALANCE_IN_CURRENCY", `this portfolio holds no paper ${quote.side === "buy" ? quote.input.symbol ?? "balance" : quote.output.symbol ?? "balance"} for this pair`);
        const cash = BigInt(balances[0].amount.toFixed(0));
        const holdings = await tx.$queryRaw<Array<{ amount: Prisma.Decimal; costBasis: Prisma.Decimal; quoteCurrency: string }>>`
          SELECT amount, "costBasis", "quoteCurrency" FROM "PracticeHolding" WHERE "portfolioId" = ${params.portfolioId} AND chain = ${CHAIN} AND "tokenAddress" = ${token} FOR UPDATE`;
        const held = holdings[0] ? BigInt(holdings[0].amount.toFixed(0)) : 0n;
        const basis = holdings[0] ? BigInt(holdings[0].costBasis.toFixed(0)) : 0n;

        let realized: bigint | null = null;
        if (quote.side === "buy") {
          if (cash < input) return fail("INSUFFICIENT_PAPER_BALANCE", "not enough paper cash for this entry");
          if (holdings[0] && holdings[0].quoteCurrency !== quoteCurrency) return fail("INVALID_REQUEST", "this holding is tracked in a different quote currency");
          await tx.practiceBalance.update({ where: { portfolioId_currency: { portfolioId: params.portfolioId, currency: quoteCurrency } }, data: { amount: new Prisma.Decimal((cash - input).toString()) } });
          await tx.practiceHolding.upsert({
            where: { portfolioId_chain_tokenAddress: { portfolioId: params.portfolioId, chain: CHAIN, tokenAddress: token } },
            create: { portfolioId: params.portfolioId, chain: CHAIN, tokenAddress: token, quoteCurrency, amount: new Prisma.Decimal(output.toString()), costBasis: new Prisma.Decimal(input.toString()), realizedPnl: new Prisma.Decimal(0) },
            update: { amount: new Prisma.Decimal((held + output).toString()), costBasis: new Prisma.Decimal((basis + input).toString()) },
          });
        } else {
          if (held < input) return fail("INSUFFICIENT_PAPER_HOLDING", "you cannot sell more practice tokens than you hold");
          // Cost basis leaves in proportion to the tokens sold.
          const removedBasis = (basis * input) / held;
          realized = output - removedBasis;
          await tx.practiceHolding.update({
            where: { portfolioId_chain_tokenAddress: { portfolioId: params.portfolioId, chain: CHAIN, tokenAddress: token } },
            data: { amount: new Prisma.Decimal((held - input).toString()), costBasis: new Prisma.Decimal((basis - removedBasis).toString()), realizedPnl: { increment: new Prisma.Decimal(realized.toString()) } },
          });
          await tx.practiceBalance.update({ where: { portfolioId_currency: { portfolioId: params.portfolioId, currency: quoteCurrency } }, data: { amount: new Prisma.Decimal((cash + output).toString()) } });
        }

        const trade = await tx.practiceTrade.create({
          data: {
            userId: params.userId,
            portfolioId: params.portfolioId,
            planId: params.planId,
            chain: CHAIN,
            tokenAddress: token,
            side: quote.side,
            venue: quote.venue,
            fillBasis,
            quoteCurrency,
            inputAmount: new Prisma.Decimal(input.toString()),
            outputAmount: new Prisma.Decimal(output.toString()),
            minimumOutput: new Prisma.Decimal(quote.output.minimum),
            allInCostBps: quote.priceImpact.allInBps,
            realizedPnl: realized === null ? null : new Prisma.Decimal(realized.toString()),
            quoteSnapshotId: quoteSnapshot.id,
            simulationSnapshotId: params.simulationId,
            idempotencyKey: params.idempotencyKey,
            requestFingerprint: fingerprint,
          },
        });
        return { ok: true as const, created: true, value: trade };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20_000 }
    );

  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      // A concurrent request with the same key may have committed first: replay it.
      const winner = isUniqueViolation(error) || isSerializationFailure(error) ? await replay() : null;
      if (winner) return winner;
      // Serialization conflicts are retried; the locked re-read then decides the outcome.
      if (isSerializationFailure(error) && attempt < 8) {
        await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 40 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Lesson and achievements

export async function recordSizeComparison(db: PrismaClient, params: { userId: string; quoteIds: [string, string] }) {
  const snapshots = await db.evidenceSnapshot.findMany({ where: { id: { in: params.quoteIds }, kind: "QUOTE" } });
  const quotes = snapshots.map(quoteFromSnapshot);
  if (snapshots.length !== 2 || quotes.some((q) => !q)) return fail("QUOTE_NOT_FOUND", "compare two existing, priced quotes");
  const [a, b] = quotes as NonNullable<(typeof quotes)[number]>[];
  if (a.tokenAddress.toLowerCase() !== b.tokenAddress.toLowerCase() || a.side !== b.side) return fail("INVALID_REQUEST", "compare the same token and side");
  if (a.input.amount === b.input.amount) return fail("INVALID_REQUEST", "compare two different sizes");
  const evidence = { quoteIds: params.quoteIds, token: a.tokenAddress, side: a.side, sizes: [a.input.amount, b.input.amount], allInCostBps: [a.priceImpact.allInBps, b.priceImpact.allInBps] };
  const awarded = await award(db, params.userId, "COMPARED_ORDER_SIZES", evidence);
  await acknowledgeLessonStep(db, { userId: params.userId, step: "compare-sizes", evidenceChecked: true });
  return { ok: true as const, value: { awarded, evidence } };
}

/** Records a step. Steps other than the two acknowledgements must already be true in the database. */
export async function acknowledgeLessonStep(db: PrismaClient, params: { userId: string; step: string; evidenceChecked?: boolean }) {
  if (!(INTRO_LESSON_STEPS as readonly string[]).includes(params.step)) return fail("INVALID_REQUEST", "unknown lesson step");
  const step = params.step as LessonStep;
  if (!ACKNOWLEDGED_STEPS.includes(step) && !params.evidenceChecked) return fail("INVALID_REQUEST", "this step is completed by doing it, not by marking it");
  await db.$executeRaw`
    INSERT INTO "PracticeLessonProgress" ("userId", "lessonId", steps, "updatedAt")
    VALUES (${params.userId}, ${INTRO_LESSON_ID}, ARRAY[${step}]::text[], now())
    ON CONFLICT ("userId", "lessonId") DO UPDATE
      SET steps = (SELECT array_agg(DISTINCT s) FROM unnest("PracticeLessonProgress".steps || ARRAY[${step}]::text[]) s), "updatedAt" = now()`;
  return getLessonProgress(db, params.userId);
}

/** Progress is recomputed from facts every time, so it cannot drift from what the user actually did. */
export async function getLessonProgress(db: PrismaClient, userId: string) {
  const [row, portfolios, plans, trades, reviews, achievements] = await Promise.all([
    db.practiceLessonProgress.findUnique({ where: { userId_lessonId: { userId, lessonId: INTRO_LESSON_ID } } }),
    db.practicePortfolio.count({ where: { userId } }),
    db.practicePlan.count({ where: { userId } }),
    db.practiceTrade.findMany({ where: { userId }, select: { side: true, fillBasis: true }, take: 200 }),
    db.practiceReview.count({ where: { userId } }),
    db.practiceAchievement.findMany({ where: { userId } }),
  ]);
  const acknowledged = new Set(row?.steps ?? []);
  const done: Record<LessonStep, boolean> = {
    portfolio: portfolios > 0,
    plan: plans > 0,
    "compare-sizes": achievements.some((a) => a.code === "COMPARED_ORDER_SIZES"),
    "preview-costs": acknowledged.has("preview-costs"),
    simulate: trades.some((t) => t.fillBasis === "EXECUTION_SIMULATION"),
    "place-trade": trades.some((t) => t.side === "buy"),
    track: acknowledged.has("track"),
    "close-and-review": trades.some((t) => t.side === "sell") && reviews > 0,
  };
  const complete = INTRO_LESSON_STEPS.every((s) => done[s]);
  let newlyAwarded = false;
  if (complete) {
    newlyAwarded = await award(db, userId, "INTRO_LESSON_COMPLETE", { lessonId: INTRO_LESSON_ID, steps: INTRO_LESSON_STEPS });
    if (newlyAwarded) await db.practiceLessonProgress.updateMany({ where: { userId, lessonId: INTRO_LESSON_ID, completedAt: null }, data: { completedAt: new Date() } });
  }
  const earned = await db.practiceAchievement.findMany({ where: { userId }, orderBy: { awardedAt: "asc" } });
  return {
    ok: true as const,
    value: {
      lessonId: INTRO_LESSON_ID,
      steps: INTRO_LESSON_STEPS.map((s) => ({ id: s, done: done[s] })),
      complete,
      achievements: (Object.keys(ACHIEVEMENTS) as AchievementCode[]).map((code) => {
        const got = earned.find((a) => a.code === code);
        return { code, ...ACHIEVEMENTS[code], earned: Boolean(got), awardedAt: got?.awardedAt.toISOString() ?? null };
      }),
    },
  };
}
