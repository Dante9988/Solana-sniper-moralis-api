/**
 * Phase 7D.3.2 §5 — quotes, simulations, evidence snapshots and paper positions.
 *
 *   POST /api/v1/tokens/robinhood/:tokenAddress/quotes       public read (like /pool)
 *   POST /api/v1/tokens/robinhood/:tokenAddress/simulations  public read
 *   GET  /api/v1/evidence/:snapshotId                        public read
 *   POST /api/v1/me/paper-positions                          Supabase user, Idempotency-Key
 *   GET  /api/v1/me/paper-positions                          Supabase user
 *
 * Quoting a public token is not private data, so it follows API_PUBLIC_READS. Saved paper
 * positions are private and use the established Supabase authentication — there is no
 * bypass, and an internal API key cannot stand in for a user.
 *
 * "Unsupported" and "unavailable" are results, not HTTP errors: 200 with a status and a
 * reason, exactly like the pool-evidence route. Raw provider text never reaches a response.
 */

import type { EvidenceSnapshot, PrismaClient } from "@prisma/client";
import { Router } from "express";

import type { ApiConfig } from "../config";
import { sendError } from "../contracts/errors";
import {
  CreatePaperPositionRequestSchema,
  EvidenceSnapshotParamSchema,
  PAPER_TRADING_API_VERSION,
  QuoteRequestSchema,
  SimulationRequestSchema,
} from "../contracts/paperTrading";
import { AuthenticateDeps, createAuthenticateUnlessPublicReads, createRequireSupabaseUser } from "../middleware/authenticate";
import { createRateLimiter, createRateLimiterStore, rateLimitKey } from "../middleware/rateLimit";
import { validateRobinhoodAddress } from "../middleware/validateRobinhoodAddress";
import { createQuoteEngine, type QuoteEngine } from "../quoteEngineProvider";
import { logger } from "../lib/logger";
import { validateQuoteRequest } from "../../pons/quote/quoteService";
import {
  createPaperPosition,
  listPaperPositions,
  quoteFromSnapshot,
  saveQuoteSnapshot,
  saveSimulationSnapshot,
  type PaperPositionWithEvidence,
} from "../../services/paperTradingService";

/** Chain reads are the scarce resource; quoting is limited separately from ordinary reads. */
export const QUOTE_REQUESTS_PER_MINUTE = 20;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;

const PUBLIC_UNAVAILABLE: Record<string, string> = {
  RPC_UNAVAILABLE: "Chain data is temporarily unavailable, so no fresh quote can be produced. Retry shortly.",
  INCONSISTENT_SNAPSHOT: "The chain changed while the quote was being read. Retry to quote at a new block.",
  PROVIDER_CAPABILITY: "No configured chain provider supports the call this requires right now.",
  QUOTE_BLOCK_REORGED: "The quote's block is no longer canonical. Request a new quote.",
};

function unavailable(reason: string) {
  return {
    apiVersion: PAPER_TRADING_API_VERSION,
    status: "UNAVAILABLE" as const,
    reason,
    detail: PUBLIC_UNAVAILABLE[reason] ?? PUBLIC_UNAVAILABLE.RPC_UNAVAILABLE,
    retryable: true as const,
  };
}

export function serializeSnapshot(s: EvidenceSnapshot) {
  return {
    id: s.id,
    kind: s.kind,
    status: s.status,
    chain: s.chain,
    tokenAddress: s.tokenAddress,
    side: s.side,
    parentId: s.parentId,
    block:
      s.blockNumber !== null && s.blockHash && s.blockTimestamp
        ? { number: s.blockNumber.toString(), hash: s.blockHash, timestamp: Math.floor(s.blockTimestamp.getTime() / 1000).toString() }
        : null,
    observedAt: s.observedAt.toISOString(),
    expiresAt: s.expiresAt?.toISOString() ?? null,
    calculationVersion: s.calculationVersion,
    policyVersion: s.policyVersion,
    payloadSha256: s.payloadSha256,
    payload: s.payload as Record<string, unknown>,
    sourceReferences: s.sourceReferences as unknown[],
    missingEvidence: s.missingEvidence as unknown[],
    createdAt: s.createdAt.toISOString(),
  };
}

function serializePosition(p: PaperPositionWithEvidence) {
  return {
    id: p.id,
    chain: p.chain,
    tokenAddress: p.tokenAddress,
    side: p.side,
    venue: p.venue,
    fillBasis: p.fillBasis,
    input: { currency: p.inputCurrency, symbol: p.inputSymbol, decimals: p.inputDecimals, amount: p.inputAmount.toFixed() },
    output: { currency: p.outputCurrency, symbol: p.outputSymbol, decimals: p.outputDecimals, amount: p.outputAmount.toFixed() },
    minimumOutput: p.minimumOutput.toFixed(),
    createdAt: p.createdAt.toISOString(),
    quote: serializeSnapshot(p.quoteSnapshot),
    simulation: p.simulationSnapshot ? serializeSnapshot(p.simulationSnapshot) : null,
    paper: true as const,
  };
}

export function createPaperTradingRouter(
  db: PrismaClient,
  config: ApiConfig,
  deps: AuthenticateDeps,
  // Injectable so route tests never touch an RPC.
  engine: QuoteEngine = createQuoteEngine(),
  options: { quoteRequestsPerMinute?: number } = {}
): Router {
  const router = Router();
  const readAuth = createAuthenticateUnlessPublicReads(config, deps);
  const requireUser = createRequireSupabaseUser(deps);
  const store = createRateLimiterStore(config.rateLimit);
  const quoteLimiter = createRateLimiter({ windowMs: 60_000, max: options.quoteRequestsPerMinute ?? QUOTE_REQUESTS_PER_MINUTE, keyFn: rateLimitKey, store });
  const readLimiter = createRateLimiter({ windowMs: 60_000, max: config.rateLimitPerMinute, keyFn: rateLimitKey, store });

  router.post("/tokens/robinhood/:tokenAddress/quotes", readAuth, quoteLimiter, validateRobinhoodAddress, async (req, res, next) => {
    try {
      const parsed = QuoteRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(res, "BAD_REQUEST", "body must be { side, amount (base units, decimal string), slippageBps (1–5000) }", req.requestId);
        return;
      }
      const request = {
        tokenAddress: req.normalizedTokenAddress!,
        side: parsed.data.side,
        amountIn: BigInt(parsed.data.amount),
        slippageBps: parsed.data.slippageBps,
      };
      const invalid = validateQuoteRequest(request);
      if (invalid) {
        sendError(res, "BAD_REQUEST", invalid, req.requestId);
        return;
      }

      const outcome = await engine.quote(request);
      if (outcome.status === "UNAVAILABLE") {
        logger.warn({ requestId: req.requestId, reason: outcome.reason, detail: outcome.detail }, "[quotes] unavailable");
        res.json(unavailable(outcome.reason));
        return;
      }

      const snapshot = await saveQuoteSnapshot(db, outcome, {
        tokenAddress: request.tokenAddress,
        side: request.side,
        amountIn: parsed.data.amount,
        slippageBps: request.slippageBps,
      });
      if (outcome.status === "QUOTED") {
        res.json({ apiVersion: PAPER_TRADING_API_VERSION, status: "QUOTED", snapshotId: snapshot.id, quote: outcome.quote });
        return;
      }
      res.json({
        apiVersion: PAPER_TRADING_API_VERSION,
        status: "UNSUPPORTED",
        snapshotId: snapshot.id,
        reason: outcome.reason,
        detail: outcome.detail,
        venue: outcome.venue,
        block: outcome.block,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/tokens/robinhood/:tokenAddress/simulations", readAuth, quoteLimiter, validateRobinhoodAddress, async (req, res, next) => {
    try {
      const parsed = SimulationRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(res, "BAD_REQUEST", "body must be { quoteId }", req.requestId);
        return;
      }
      const quoteSnapshot = await db.evidenceSnapshot.findUnique({ where: { id: parsed.data.quoteId } });
      if (!quoteSnapshot || quoteSnapshot.kind !== "QUOTE" || quoteSnapshot.tokenAddress !== req.normalizedTokenAddress!.toLowerCase()) {
        sendError(res, "NOT_FOUND", "no such quote for this token", req.requestId);
        return;
      }
      const quote = quoteFromSnapshot(quoteSnapshot);
      if (!quote) {
        sendError(res, "QUOTE_NOT_FILLABLE", "this quote did not produce a price, so there is nothing to simulate", req.requestId);
        return;
      }
      if (!quoteSnapshot.expiresAt || quoteSnapshot.expiresAt.getTime() <= Date.now()) {
        sendError(res, "QUOTE_EXPIRED", "the quote has expired; request a new quote", req.requestId);
        return;
      }

      const outcome = await engine.simulate(quote);
      if (outcome.status === "UNAVAILABLE") {
        logger.warn({ requestId: req.requestId, reason: outcome.reason, detail: outcome.detail }, "[simulations] unavailable");
        res.json(unavailable(outcome.reason));
        return;
      }
      const snapshot = await saveSimulationSnapshot(db, quoteSnapshot, outcome);
      if (outcome.status === "UNSUPPORTED") {
        res.json({ apiVersion: PAPER_TRADING_API_VERSION, status: "UNSUPPORTED", snapshotId: snapshot.id, quoteId: quoteSnapshot.id, reason: outcome.reason, detail: outcome.detail });
        return;
      }
      res.json({ apiVersion: PAPER_TRADING_API_VERSION, status: outcome.status, snapshotId: snapshot.id, quoteId: quoteSnapshot.id, simulation: outcome });
    } catch (err) {
      next(err);
    }
  });

  router.get("/evidence/:snapshotId", readAuth, readLimiter, async (req, res, next) => {
    try {
      const parsed = EvidenceSnapshotParamSchema.safeParse(req.params);
      if (!parsed.success) {
        sendError(res, "BAD_REQUEST", "snapshotId must be a UUID", req.requestId);
        return;
      }
      const snapshot = await db.evidenceSnapshot.findUnique({ where: { id: parsed.data.snapshotId } });
      if (!snapshot) {
        sendError(res, "NOT_FOUND", "no such evidence snapshot", req.requestId);
        return;
      }
      res.json(serializeSnapshot(snapshot));
    } catch (err) {
      next(err);
    }
  });

  router.post("/me/paper-positions", requireUser, readLimiter, async (req, res, next) => {
    try {
      if (req.auth?.type !== "supabase") {
        sendError(res, "UNAUTHORIZED", "a signed-in user is required", req.requestId);
        return;
      }
      const key = req.header("idempotency-key");
      if (!key || !IDEMPOTENCY_KEY.test(key)) {
        sendError(res, "IDEMPOTENCY_KEY_REQUIRED", "send an Idempotency-Key header (8–128 characters: letters, digits, - or _)", req.requestId);
        return;
      }
      const parsed = CreatePaperPositionRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(res, "BAD_REQUEST", "body must be { quoteId, simulationId }", req.requestId);
        return;
      }

      const result = await createPaperPosition(db, {
        userId: req.auth.userId,
        idempotencyKey: key,
        quoteId: parsed.data.quoteId,
        simulationId: parsed.data.simulationId,
      });
      if (!result.ok) {
        const code = result.code === "QUOTE_NOT_FOUND" || result.code === "SIMULATION_NOT_FOUND" ? "NOT_FOUND" : result.code;
        sendError(res, code, result.message, req.requestId);
        return;
      }
      res.status(result.created ? 201 : 200).json({
        apiVersion: PAPER_TRADING_API_VERSION,
        created: result.created,
        position: serializePosition(result.position),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/me/paper-positions", requireUser, readLimiter, async (req, res, next) => {
    try {
      if (req.auth?.type !== "supabase") {
        sendError(res, "UNAUTHORIZED", "a signed-in user is required", req.requestId);
        return;
      }
      const positions = await listPaperPositions(db, req.auth.userId);
      res.json({ apiVersion: PAPER_TRADING_API_VERSION, positions: positions.map(serializePosition), observedAt: new Date().toISOString() });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
