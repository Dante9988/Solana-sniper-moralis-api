/**
 * Phase 7D.4 §7 — vanity address availability, reservation and internal consumption.
 *
 *   GET    /vanity/availability?chain=           public-read rules
 *   GET    /me/vanity/reservation?chain=         Supabase user
 *   POST   /me/vanity/reservations               Supabase user, Idempotency-Key
 *   DELETE /me/vanity/reservations/:id           Supabase user
 *   POST   /internal/vanity/reservations/:id/consume   internal API key only, Idempotency-Key
 *
 * Nothing here signs, deploys or broadcasts.
 */

import type { PrismaClient } from "@prisma/client";
import { Router, type NextFunction, type Request, type Response } from "express";

import type { ApiConfig } from "../config";
import { sendError, type ErrorCode } from "../contracts/errors";
import { ReserveVanityRequestSchema, VanityChainQuerySchema } from "../contracts/vanity";
import { AuthenticateDeps, createAuthenticateUnlessPublicReads, createRequireSupabaseUser, extractBearerToken } from "../middleware/authenticate";
import { createRateLimiter, createRateLimiterStore, rateLimitKey } from "../middleware/rateLimit";
import { consumeReservation, getActiveReservation, getAvailability, releaseReservation, reserveVanityAddress, type VanityError } from "../../services/vanity/vanityService";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;
const ERROR_FOR: Record<VanityError, ErrorCode> = {
  UNSUPPORTED_CHAIN: "UNSUPPORTED_CHAIN",
  NONE_AVAILABLE: "VANITY_NONE_AVAILABLE",
  NOT_FOUND: "NOT_FOUND",
  RESERVATION_EXPIRED: "RESERVATION_EXPIRED",
  ALREADY_CONSUMED: "ALREADY_CONSUMED",
};

function uid(req: Request): string {
  if (req.auth?.type !== "supabase") throw new Error("vanity route reached without a Supabase user");
  return req.auth.userId;
}

export function createVanityRouter(db: PrismaClient, config: ApiConfig, deps: AuthenticateDeps): Router {
  const router = Router();
  const readAuth = createAuthenticateUnlessPublicReads(config, deps);
  const requireUser = createRequireSupabaseUser(deps);
  const limiter = createRateLimiter({ windowMs: 60_000, max: config.rateLimitPerMinute, keyFn: rateLimitKey, store: createRateLimiterStore(config.rateLimit) });
  const requireInternalKey = (req: Request, res: Response, next: NextFunction) => {
    const token = extractBearerToken(req);
    if (!token || !config.apiKeys.has(token)) return sendError(res, "UNAUTHORIZED", "internal API key required", req.requestId);
    req.auth = { type: "apiKey" };
    next();
  };
  const idempotencyKey = (req: Request, res: Response): string | null => {
    const key = req.header("idempotency-key");
    if (!key || !IDEMPOTENCY_KEY.test(key)) {
      sendError(res, "IDEMPOTENCY_KEY_REQUIRED", "send an Idempotency-Key header (8–128 characters: letters, digits, - or _)", req.requestId);
      return null;
    }
    return key;
  };

  router.get("/vanity/availability", readAuth, limiter, async (req, res, next) => {
    try {
      const q = VanityChainQuerySchema.safeParse(req.query);
      if (!q.success) return sendError(res, "BAD_REQUEST", "chain must be solana or robinhood", req.requestId);
      res.json(await getAvailability(db, q.data.chain));
    } catch (err) {
      next(err);
    }
  });

  router.use("/me/vanity", requireUser, limiter);

  router.get("/me/vanity/reservation", async (req, res, next) => {
    try {
      const q = VanityChainQuerySchema.safeParse(req.query);
      if (!q.success) return sendError(res, "BAD_REQUEST", "chain must be solana or robinhood", req.requestId);
      res.json({ reservation: await getActiveReservation(db, uid(req), q.data.chain) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/me/vanity/reservations", async (req, res, next) => {
    try {
      const key = idempotencyKey(req, res);
      if (!key) return;
      const body = ReserveVanityRequestSchema.safeParse(req.body);
      if (!body.success) return sendError(res, "BAD_REQUEST", "body must be { chain }", req.requestId);
      const r = await reserveVanityAddress(db, { userId: uid(req), chain: body.data.chain, idempotencyKey: key });
      if (!r.ok) return sendError(res, ERROR_FOR[r.code], r.message, req.requestId);
      res.status(r.created ? 201 : 200).json({ created: Boolean(r.created), reservation: r.value });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/me/vanity/reservations/:reservationId", async (req, res, next) => {
    try {
      const r = await releaseReservation(db, { userId: uid(req), reservationId: req.params.reservationId });
      if (!r.ok) return sendError(res, ERROR_FOR[r.code], r.message, req.requestId);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.post("/internal/vanity/reservations/:reservationId/consume", requireInternalKey, async (req, res, next) => {
    try {
      const key = idempotencyKey(req, res);
      if (!key) return;
      const r = await consumeReservation(db, { reservationId: req.params.reservationId, idempotencyKey: key });
      if (!r.ok) return sendError(res, ERROR_FOR[r.code], r.message, req.requestId);
      const { secretRef, ...reservation } = r.value;
      res.status(r.created ? 201 : 200).json({ created: Boolean(r.created), reservation, secretRef });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
