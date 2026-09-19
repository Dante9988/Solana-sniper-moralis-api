/**
 * Phase 7D.4 §5/§6 — Practice contracts. Amounts are base-unit decimal strings with their decimals.
 * Every response here is paper: nothing was signed or broadcast, and nothing is a wallet balance.
 */

import { z } from "./zodOpenApi";

export const PRACTICE_API_VERSION = 1 as const;
const BaseUnits = z.string().regex(/^-?\d+$/).openapi({ description: "Integer amount in base units, as a decimal string." });
const IdempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);

export const CreatePracticePortfolioRequestSchema = z
  .object({
    name: z.string().min(1).max(60),
    balances: z.array(z.object({ currency: z.string().regex(/^0x[0-9a-fA-F]{40}$/), amount: z.string().regex(/^\d+$/) })).min(1).max(4),
  })
  .openapi("CreatePracticePortfolioRequest");

export const PracticeBalanceSchema = z.object({ currency: z.string(), symbol: z.string(), decimals: z.number().int(), startingAmount: BaseUnits, amount: BaseUnits }).openapi("PracticeBalance");
export const PracticeHoldingSchema = z
  .object({ chain: z.string(), tokenAddress: z.string(), quoteCurrency: z.string(), amount: BaseUnits, costBasis: BaseUnits, realizedPnl: BaseUnits, updatedAt: z.string() })
  .openapi("PracticeHolding");
export const PracticeTradeSchema = z
  .object({
    id: z.string(),
    planId: z.string().nullable(),
    tokenAddress: z.string(),
    side: z.enum(["buy", "sell"]),
    venue: z.string(),
    fillBasis: z.enum(["EXECUTION_SIMULATION", "QUOTE"]),
    quoteCurrency: z.string(),
    inputAmount: BaseUnits,
    outputAmount: BaseUnits,
    minimumOutput: BaseUnits,
    allInCostBps: z.number().int().openapi({ description: "Shortfall versus the pre-trade price, fees included, from the quote." }),
    realizedPnl: BaseUnits.nullable(),
    quoteSnapshotId: z.string(),
    simulationSnapshotId: z.string().nullable(),
    createdAt: z.string(),
    paper: z.literal(true),
  })
  .openapi("PracticeTrade");
export const PracticePlanSchema = z
  .object({
    id: z.string(),
    tokenAddress: z.string(),
    thesis: z.string(),
    sizeNote: z.string().nullable(),
    exitNote: z.string().nullable(),
    status: z.enum(["OPEN", "CLOSED"]),
    createdAt: z.string(),
    closedAt: z.string().nullable(),
    review: z.object({ outcome: z.string(), notes: z.string(), createdAt: z.string() }).nullable(),
  })
  .openapi("PracticePlan");
export const PracticePortfolioSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    createdAt: z.string(),
    balances: z.array(PracticeBalanceSchema),
    holdings: z.array(PracticeHoldingSchema),
    trades: z.array(PracticeTradeSchema),
    plans: z.array(PracticePlanSchema),
  })
  .openapi("PracticePortfolio");

export const PracticeLessonSchema = z
  .object({
    lessonId: z.string(),
    steps: z.array(z.object({ id: z.string(), done: z.boolean() })),
    complete: z.boolean(),
    achievements: z.array(z.object({ code: z.string(), title: z.string(), description: z.string(), earned: z.boolean(), awardedAt: z.string().nullable() })),
  })
  .openapi("PracticeLesson");

export const PracticeOverviewResponseSchema = z
  .object({ apiVersion: z.literal(PRACTICE_API_VERSION), portfolios: z.array(PracticePortfolioSchema), lesson: PracticeLessonSchema })
  .openapi("PracticeOverviewResponse");
export const PracticePortfolioResponseSchema = z.object({ apiVersion: z.literal(PRACTICE_API_VERSION), created: z.boolean(), portfolio: PracticePortfolioSchema }).openapi("PracticePortfolioResponse");
export const CreatePracticePlanRequestSchema = z
  .object({ tokenAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/), thesis: z.string().min(10).max(2000), sizeNote: z.string().max(500).nullable().optional(), exitNote: z.string().max(500).nullable().optional() })
  .openapi("CreatePracticePlanRequest");
export const PracticePlanResponseSchema = z.object({ apiVersion: z.literal(PRACTICE_API_VERSION), created: z.boolean(), plan: PracticePlanSchema }).openapi("PracticePlanResponse");
export const CreatePracticeTradeRequestSchema = z
  .object({ quoteId: z.string().uuid(), simulationId: z.string().uuid().nullable(), planId: z.string().uuid().nullable().optional() })
  .openapi("CreatePracticeTradeRequest");
export const PracticeTradeResponseSchema = z.object({ apiVersion: z.literal(PRACTICE_API_VERSION), created: z.boolean(), trade: PracticeTradeSchema }).openapi("PracticeTradeResponse");
export const ReviewPracticePlanRequestSchema = z
  .object({ outcome: z.enum(["MATCHED_PLAN", "DEVIATED", "STOPPED_EARLY", "OTHER"]), notes: z.string().min(10).max(2000) })
  .openapi("ReviewPracticePlanRequest");
export const CompareSizesRequestSchema = z.object({ quoteIds: z.tuple([z.string().uuid(), z.string().uuid()]) }).openapi("CompareSizesRequest");
export const LessonStepRequestSchema = z.object({ step: z.enum(["preview-costs", "track"]) }).openapi("LessonStepRequest");
export const PracticeLessonResponseSchema = z.object({ apiVersion: z.literal(PRACTICE_API_VERSION), lesson: PracticeLessonSchema }).openapi("PracticeLessonResponse");

export { IdempotencyKey as PracticeIdempotencyKeySchema };
