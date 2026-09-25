/**
 * Phase 7E.1 §13/§14/§15 — real execution endpoints.
 *
 *   POST /api/v1/me/executions                      Supabase user, Idempotency-Key
 *   POST /api/v1/me/executions/:intentId/submissions Supabase user
 *   GET  /api/v1/me/executions                      Supabase user
 *   GET  /api/v1/me/executions/:intentId            Supabase user
 *
 * Every one of these is private and uses the established Supabase authentication. Unlike
 * quotes, there is no public-read bypass and an internal API key cannot stand in for a
 * user: these rows describe someone's money.
 *
 * Three refusals are results rather than HTTP errors, matching the rest of this API:
 * real trading disabled, an unusable route, and a quote that has gone stale — each a 200
 * with a stable `reason` a client can branch on.
 *
 * Nothing here accepts a private key, a seed phrase or a signed payload. The only thing a
 * wallet sends back is a transaction hash.
 */

import type { PrismaClient } from "@prisma/client";
import { Router } from "express";

import type { ApiConfig } from "../config";
import { sendError } from "../contracts/errors";
import {
  CreateIntentRequestSchema,
  CreateSubmissionRequestSchema,
  EXECUTIONS_API_VERSION,
  ExecutionIdParamSchema,
} from "../contracts/executions";
import { createExecutionEngine, type ExecutionEngine } from "../executionEngineProvider";
import { logger } from "../lib/logger";
import { AuthenticateDeps, createRequireSupabaseUser } from "../middleware/authenticate";
import { createRateLimiter, createRateLimiterStore, rateLimitKey } from "../middleware/rateLimit";
import { EXECUTION_STATE_LABELS } from "../../pons/execution/lifecycle";
import { quoteFromSnapshot } from "../../services/paperTradingService";
import { createExecutionIntent, getExecution, listExecutions, recordSubmission } from "../../services/executionService";

/** Building calldata costs several chain reads, so it is limited more tightly than a read. */
export const EXECUTION_REQUESTS_PER_MINUTE = 10;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;

type ExecutionRow = Awaited<ReturnType<typeof getExecution>>;

function serializeExecution(row: NonNullable<ExecutionRow>) {
  return {
    id: row.id,
    state: row.state,
    stateLabel: EXECUTION_STATE_LABELS[row.state],
    chain: row.chain,
    chainId: row.chainId,
    walletAddress: row.walletAddress,
    tokenAddress: row.tokenAddress,
    side: row.side,
    venue: row.venue,
    route: row.route,
    input: { currency: row.inputCurrency, symbol: row.inputSymbol, decimals: row.inputDecimals, amount: row.inputAmount.toFixed() },
    output: { currency: row.outputCurrency, symbol: row.outputSymbol, decimals: row.outputDecimals },
    expectedOutput: row.expectedOutput.toFixed(),
    minimumOutput: row.minimumOutput.toFixed(),
    slippageBps: row.slippageBps,
    quoteSnapshotId: row.quoteSnapshotId,
    simulationSnapshotId: row.simulationSnapshotId,
    failureReason: row.failureReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    submissions: row.submissions.map((submission) => ({
      id: submission.id,
      transactionHash: submission.transactionHash,
      submittedAt: submission.submittedAt.toISOString(),
      receipt: submission.receipt
        ? {
            status: submission.receipt.status,
            blockNumber: submission.receipt.blockNumber.toString(),
            blockHash: submission.receipt.blockHash,
            gasUsed: submission.receipt.gasUsed.toFixed(),
            effectiveGasPrice: submission.receipt.effectiveGasPrice?.toFixed() ?? null,
            actualInput: submission.receipt.actualInput?.toFixed() ?? null,
            actualOutput: submission.receipt.actualOutput?.toFixed() ?? null,
            matchedWallet: submission.receipt.matchedWallet,
            failureReason: submission.receipt.failureReason,
            reconciledAt: submission.receipt.reconciledAt.toISOString(),
          }
        : null,
    })),
    // Never omitted and never true: a client must not have to infer that this is real money.
    paper: false as const,
  };
}

export function createExecutionsRouter(
  db: PrismaClient,
  config: ApiConfig,
  deps: AuthenticateDeps,
  // Injectable so route tests never touch an RPC.
  engine: ExecutionEngine = createExecutionEngine(config.realTrading),
  options: { requestsPerMinute?: number } = {}
): Router {
  const router = Router();
  const requireUser = createRequireSupabaseUser(deps);
  const store = createRateLimiterStore(config.rateLimit);
  const buildLimiter = createRateLimiter({ windowMs: 60_000, max: options.requestsPerMinute ?? EXECUTION_REQUESTS_PER_MINUTE, keyFn: rateLimitKey, store });
  const readLimiter = createRateLimiter({ windowMs: 60_000, max: config.rateLimitPerMinute, keyFn: rateLimitKey, store });

  router.post("/me/executions", requireUser, buildLimiter, async (req, res, next) => {
    try {
      // requireUser already guaranteed this; narrowing here keeps the type honest and
      // means a future middleware reorder cannot silently widen who may trade.
      if (req.auth?.type !== "supabase") {
        sendError(res, "UNAUTHORIZED", "a signed-in user is required", req.requestId);
        return;
      }
      const idempotencyKey = req.header("Idempotency-Key");
      if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
        sendError(res, "IDEMPOTENCY_KEY_REQUIRED", "an Idempotency-Key header of 8–128 characters [A-Za-z0-9_-] is required", req.requestId);
        return;
      }
      const parsed = CreateIntentRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(res, "BAD_REQUEST", "body must be { quoteId, walletAddress, simulationId? }", req.requestId);
        return;
      }

      const snapshot = await db.evidenceSnapshot.findUnique({ where: { id: parsed.data.quoteId } });
      if (!snapshot || snapshot.kind !== "QUOTE") {
        sendError(res, "NOT_FOUND", "no such quote", req.requestId);
        return;
      }
      const quote = quoteFromSnapshot(snapshot);
      if (!quote) {
        sendError(res, "QUOTE_NOT_FILLABLE", "this quote did not produce a price, so there is nothing to execute", req.requestId);
        return;
      }

      // §2: a simulation, when one exists, must have succeeded. A quote whose route
      // reverts in simulation must never reach a wallet prompt.
      if (parsed.data.simulationId) {
        const simulation = await db.evidenceSnapshot.findUnique({ where: { id: parsed.data.simulationId } });
        if (!simulation || simulation.kind !== "SIMULATION" || simulation.parentId !== snapshot.id) {
          sendError(res, "NOT_FOUND", "no such simulation for this quote", req.requestId);
          return;
        }
        if (simulation.status !== "SIMULATED") {
          res.json({
            apiVersion: EXECUTIONS_API_VERSION,
            status: "REFUSED",
            reason: "SIMULATION_FAILED",
            detail: "this trade did not succeed when it was run against the real route, so it will not be prepared for signing",
          });
          return;
        }
      }

      const outcome = await engine.buildTransaction({ quote, walletAddress: parsed.data.walletAddress });
      if (outcome.status === "UNAVAILABLE") {
        logger.warn({ requestId: req.requestId, reason: outcome.reason }, "[executions] unavailable");
        res.json({ apiVersion: EXECUTIONS_API_VERSION, status: "UNAVAILABLE", reason: outcome.reason, detail: outcome.detail, retryable: true });
        return;
      }
      if (outcome.status === "REFUSED") {
        res.json({ apiVersion: EXECUTIONS_API_VERSION, status: "REFUSED", reason: outcome.reason, detail: outcome.detail });
        return;
      }

      const created = await createExecutionIntent(db, {
        userId: req.auth.userId,
        idempotencyKey,
        plan: outcome.plan,
        quote,
        quoteSnapshotId: snapshot.id,
        simulationSnapshotId: parsed.data.simulationId ?? null,
      });
      if (!created.ok) {
        sendError(res, created.code === "QUOTE_NOT_FOUND" ? "NOT_FOUND" : "IDEMPOTENCY_KEY_REUSED", created.message, req.requestId);
        return;
      }

      const row = await getExecution(db, req.auth.userId, created.intentId);
      res.status(created.created ? 201 : 200).json({
        apiVersion: EXECUTIONS_API_VERSION,
        status: "READY",
        intentId: created.intentId,
        state: row?.state ?? "READY_FOR_REVIEW",
        plan: outcome.plan,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/me/executions/:intentId/submissions", requireUser, buildLimiter, async (req, res, next) => {
    try {
      // requireUser already guaranteed this; narrowing here keeps the type honest and
      // means a future middleware reorder cannot silently widen who may trade.
      if (req.auth?.type !== "supabase") {
        sendError(res, "UNAUTHORIZED", "a signed-in user is required", req.requestId);
        return;
      }
      const params = ExecutionIdParamSchema.safeParse(req.params);
      if (!params.success) {
        sendError(res, "BAD_REQUEST", "intentId must be a uuid", req.requestId);
        return;
      }
      const parsed = CreateSubmissionRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(res, "BAD_REQUEST", "body must be { transactionHash }", req.requestId);
        return;
      }

      const result = await recordSubmission(db, {
        userId: req.auth.userId,
        intentId: params.data.intentId,
        transactionHash: parsed.data.transactionHash,
      });
      if (!result.ok) {
        // A hash already claimed by another trade, or a trade past the point where it can
        // accept one, are both conflicts a client must resolve by re-reading state.
        const code = result.code === "INTENT_NOT_FOUND" ? "NOT_FOUND" : result.code === "INVALID_HASH" ? "BAD_REQUEST" : "EXECUTION_CONFLICT";
        sendError(res, code, result.message, req.requestId);
        return;
      }

      const row = await getExecution(db, req.auth.userId, params.data.intentId);
      res.status(result.created ? 201 : 200).json({ apiVersion: EXECUTIONS_API_VERSION, execution: serializeExecution(row!) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/me/executions", requireUser, readLimiter, async (req, res, next) => {
    try {
      // requireUser already guaranteed this; narrowing here keeps the type honest and
      // means a future middleware reorder cannot silently widen who may trade.
      if (req.auth?.type !== "supabase") {
        sendError(res, "UNAUTHORIZED", "a signed-in user is required", req.requestId);
        return;
      }
      const rows = await listExecutions(db, req.auth.userId);
      res.json({ apiVersion: EXECUTIONS_API_VERSION, executions: rows.map(serializeExecution) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/me/executions/:intentId", requireUser, readLimiter, async (req, res, next) => {
    try {
      // requireUser already guaranteed this; narrowing here keeps the type honest and
      // means a future middleware reorder cannot silently widen who may trade.
      if (req.auth?.type !== "supabase") {
        sendError(res, "UNAUTHORIZED", "a signed-in user is required", req.requestId);
        return;
      }
      const params = ExecutionIdParamSchema.safeParse(req.params);
      if (!params.success) {
        sendError(res, "BAD_REQUEST", "intentId must be a uuid", req.requestId);
        return;
      }
      const row = await getExecution(db, req.auth.userId, params.data.intentId);
      if (!row) {
        sendError(res, "NOT_FOUND", "no such trade", req.requestId);
        return;
      }
      res.json({ apiVersion: EXECUTIONS_API_VERSION, execution: serializeExecution(row) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
