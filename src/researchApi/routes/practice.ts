/**
 * Phase 7D.4 §5/§6 — Practice routes. Signed-in Supabase users only; every query is scoped to the
 * caller. Creates require an Idempotency-Key. Nothing here signs, broadcasts or touches a wallet.
 */

import type { PrismaClient } from "@prisma/client";
import { Router, type Response } from "express";

import type { ApiConfig } from "../config";
import { sendError, type ErrorCode } from "../contracts/errors";
import {
  CompareSizesRequestSchema,
  CreatePracticePlanRequestSchema,
  CreatePracticePortfolioRequestSchema,
  CreatePracticeTradeRequestSchema,
  LessonStepRequestSchema,
  PRACTICE_API_VERSION,
  ReviewPracticePlanRequestSchema,
} from "../contracts/practice";
import { AuthenticateDeps, createRequireSupabaseUser } from "../middleware/authenticate";
import { createRateLimiter, createRateLimiterStore, rateLimitKey } from "../middleware/rateLimit";
import {
  acknowledgeLessonStep,
  createPlan,
  createPortfolio,
  getLessonProgress,
  getPortfolio,
  listPortfolios,
  placePracticeTrade,
  recordSizeComparison,
  reviewPlan,
  type PracticeError,
} from "../../services/practiceService";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;

/** requireSupabaseUser has already rejected anything but a Supabase identity. */
function uid(req: { auth?: import("../middleware/authenticate").AuthContext }): string {
  if (req.auth?.type !== "supabase") throw new Error("practice route reached without a Supabase user");
  return req.auth.userId;
}
type Dec = { toFixed: (dp?: number) => string };
const s = (d: Dec) => d.toFixed(0);

const ERROR_FOR: Record<PracticeError, ErrorCode> = {
  NOT_FOUND: "NOT_FOUND",
  INVALID_REQUEST: "BAD_REQUEST",
  UNSUPPORTED_CURRENCY: "UNSUPPORTED_CURRENCY",
  IDEMPOTENCY_KEY_REUSED: "IDEMPOTENCY_KEY_REUSED",
  QUOTE_NOT_FOUND: "NOT_FOUND",
  QUOTE_NOT_FILLABLE: "QUOTE_NOT_FILLABLE",
  QUOTE_EXPIRED: "QUOTE_EXPIRED",
  SIMULATION_NOT_FOUND: "NOT_FOUND",
  SIMULATION_NOT_FOR_QUOTE: "SIMULATION_NOT_FOR_QUOTE",
  SIMULATION_NOT_SUCCESSFUL: "SIMULATION_NOT_SUCCESSFUL",
  NO_PAPER_BALANCE_IN_CURRENCY: "NO_PAPER_BALANCE_IN_CURRENCY",
  INSUFFICIENT_PAPER_BALANCE: "INSUFFICIENT_PAPER_BALANCE",
  INSUFFICIENT_PAPER_HOLDING: "INSUFFICIENT_PAPER_HOLDING",
  PLAN_MISMATCH: "PLAN_MISMATCH",
  PLAN_NOT_CLOSEABLE: "PLAN_NOT_CLOSEABLE",
  ALREADY_REVIEWED: "ALREADY_REVIEWED",
};

/* eslint-disable @typescript-eslint/no-explicit-any */
function serializePlan(p: any) {
  return {
    id: p.id,
    tokenAddress: p.tokenAddress,
    thesis: p.thesis,
    sizeNote: p.sizeNote,
    exitNote: p.exitNote,
    status: p.status,
    createdAt: p.createdAt.toISOString(),
    closedAt: p.closedAt?.toISOString() ?? null,
    review: p.review ? { outcome: p.review.outcome, notes: p.review.notes, createdAt: p.review.createdAt.toISOString() } : null,
  };
}
function serializeTrade(t: any) {
  return {
    id: t.id,
    planId: t.planId,
    tokenAddress: t.tokenAddress,
    side: t.side,
    venue: t.venue,
    fillBasis: t.fillBasis,
    quoteCurrency: t.quoteCurrency,
    inputAmount: s(t.inputAmount),
    outputAmount: s(t.outputAmount),
    minimumOutput: s(t.minimumOutput),
    allInCostBps: t.allInCostBps,
    realizedPnl: t.realizedPnl === null ? null : s(t.realizedPnl),
    quoteSnapshotId: t.quoteSnapshotId,
    simulationSnapshotId: t.simulationSnapshotId,
    createdAt: t.createdAt.toISOString(),
    paper: true as const,
  };
}
function serializePortfolio(p: any) {
  return {
    id: p.id,
    name: p.name,
    createdAt: p.createdAt.toISOString(),
    balances: p.balances.map((b: any) => ({ currency: b.currency, symbol: b.symbol, decimals: b.decimals, startingAmount: s(b.startingAmount), amount: s(b.amount) })),
    holdings: p.holdings
      .filter((h: any) => s(h.amount) !== "0" || s(h.realizedPnl) !== "0")
      .map((h: any) => ({ chain: h.chain, tokenAddress: h.tokenAddress, quoteCurrency: h.quoteCurrency, amount: s(h.amount), costBasis: s(h.costBasis), realizedPnl: s(h.realizedPnl), updatedAt: h.updatedAt.toISOString() })),
    trades: (p.trades ?? []).map(serializeTrade),
    plans: (p.plans ?? []).map(serializePlan),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export function createPracticeRouter(db: PrismaClient, config: ApiConfig, deps: AuthenticateDeps): Router {
  const router = Router();
  const requireUser = createRequireSupabaseUser(deps);
  const limiter = createRateLimiter({ windowMs: 60_000, max: config.rateLimitPerMinute, keyFn: rateLimitKey, store: createRateLimiterStore(config.rateLimit) });

  const failWith = (res: Response, requestId: string, r: { code: PracticeError; message: string }) => sendError(res, ERROR_FOR[r.code], r.message, requestId);
  const idempotencyKey = (req: { header: (n: string) => string | undefined }, res: Response, requestId: string): string | null => {
    const key = req.header("idempotency-key");
    if (!key || !IDEMPOTENCY_KEY.test(key)) {
      sendError(res, "IDEMPOTENCY_KEY_REQUIRED", "send an Idempotency-Key header (8–128 characters: letters, digits, - or _)", requestId);
      return null;
    }
    return key;
  };

  router.use("/me/practice", requireUser, limiter);

  router.get("/me/practice", async (req, res, next) => {
    try {
      const userId = uid(req);
      const [portfolios, lesson] = await Promise.all([listPortfolios(db, userId), getLessonProgress(db, userId)]);
      const detailed = await Promise.all(portfolios.map((p) => getPortfolio(db, userId, p.id)));
      res.json({ apiVersion: PRACTICE_API_VERSION, portfolios: detailed.filter(Boolean).map(serializePortfolio), lesson: lesson.value });
    } catch (err) {
      next(err);
    }
  });

  router.post("/me/practice/portfolios", async (req, res, next) => {
    try {
      const key = idempotencyKey(req, res, req.requestId);
      if (!key) return;
      const body = CreatePracticePortfolioRequestSchema.safeParse(req.body);
      if (!body.success) return sendError(res, "BAD_REQUEST", "body must be { name, balances: [{ currency, amount }] }", req.requestId);
      const r = await createPortfolio(db, { userId: uid(req), idempotencyKey: key, ...body.data });
      if (!r.ok) return failWith(res, req.requestId, r);
      const full = await getPortfolio(db, uid(req), r.value.id);
      res.status(r.created ? 201 : 200).json({ apiVersion: PRACTICE_API_VERSION, created: Boolean(r.created), portfolio: serializePortfolio(full) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/me/practice/portfolios/:portfolioId", async (req, res, next) => {
    try {
      const p = await getPortfolio(db, uid(req), req.params.portfolioId);
      if (!p) return sendError(res, "NOT_FOUND", "no such portfolio", req.requestId);
      res.json({ apiVersion: PRACTICE_API_VERSION, created: false, portfolio: serializePortfolio(p) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/me/practice/portfolios/:portfolioId/plans", async (req, res, next) => {
    try {
      const key = idempotencyKey(req, res, req.requestId);
      if (!key) return;
      const body = CreatePracticePlanRequestSchema.safeParse(req.body);
      if (!body.success) return sendError(res, "BAD_REQUEST", "body must be { tokenAddress, thesis (10–2000 characters), sizeNote?, exitNote? }", req.requestId);
      const r = await createPlan(db, { userId: uid(req), idempotencyKey: key, portfolioId: req.params.portfolioId, ...body.data });
      if (!r.ok) return failWith(res, req.requestId, r);
      res.status(r.created ? 201 : 200).json({ apiVersion: PRACTICE_API_VERSION, created: Boolean(r.created), plan: serializePlan({ ...r.value, review: null }) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/me/practice/portfolios/:portfolioId/trades", async (req, res, next) => {
    try {
      const key = idempotencyKey(req, res, req.requestId);
      if (!key) return;
      const body = CreatePracticeTradeRequestSchema.safeParse(req.body);
      if (!body.success) return sendError(res, "BAD_REQUEST", "body must be { quoteId, simulationId, planId? }", req.requestId);
      const r = await placePracticeTrade(db, { userId: uid(req), idempotencyKey: key, portfolioId: req.params.portfolioId, quoteId: body.data.quoteId, simulationId: body.data.simulationId, planId: body.data.planId ?? null });
      if (!r.ok) return failWith(res, req.requestId, r);
      res.status(r.created ? 201 : 200).json({ apiVersion: PRACTICE_API_VERSION, created: Boolean(r.created), trade: serializeTrade(r.value) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/me/practice/plans/:planId/review", async (req, res, next) => {
    try {
      const body = ReviewPracticePlanRequestSchema.safeParse(req.body);
      if (!body.success) return sendError(res, "BAD_REQUEST", "body must be { outcome, notes (10–2000 characters) }", req.requestId);
      const r = await reviewPlan(db, { userId: uid(req), planId: req.params.planId, ...body.data });
      if (!r.ok) return failWith(res, req.requestId, r);
      const lesson = await getLessonProgress(db, uid(req));
      res.status(201).json({ apiVersion: PRACTICE_API_VERSION, lesson: lesson.value });
    } catch (err) {
      next(err);
    }
  });

  router.get("/me/practice/lesson", async (req, res, next) => {
    try {
      const lesson = await getLessonProgress(db, uid(req));
      res.json({ apiVersion: PRACTICE_API_VERSION, lesson: lesson.value });
    } catch (err) {
      next(err);
    }
  });

  router.post("/me/practice/lesson/compare-sizes", async (req, res, next) => {
    try {
      const body = CompareSizesRequestSchema.safeParse(req.body);
      if (!body.success) return sendError(res, "BAD_REQUEST", "body must be { quoteIds: [a, b] }", req.requestId);
      const r = await recordSizeComparison(db, { userId: uid(req), quoteIds: body.data.quoteIds });
      if (!r.ok) return failWith(res, req.requestId, r);
      const lesson = await getLessonProgress(db, uid(req));
      res.json({ apiVersion: PRACTICE_API_VERSION, lesson: lesson.value });
    } catch (err) {
      next(err);
    }
  });

  router.post("/me/practice/lesson/steps", async (req, res, next) => {
    try {
      const body = LessonStepRequestSchema.safeParse(req.body);
      if (!body.success) return sendError(res, "BAD_REQUEST", "only reading steps (preview-costs, track) are marked directly; the rest complete by doing them", req.requestId);
      const r = await acknowledgeLessonStep(db, { userId: uid(req), step: body.data.step });
      if (!r.ok) return failWith(res, req.requestId, r);
      res.json({ apiVersion: PRACTICE_API_VERSION, lesson: r.value });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
