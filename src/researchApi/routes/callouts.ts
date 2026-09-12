/**
 * Phase 7F.2 — `/api/v1/callouts` (verifiable callouts & PnL sharing).
 *
 * Serves the PnL callouts that the tracker has already verified and shared to
 * Discord/Telegram, so the OnlyPump UI can show the same record the bot posted.
 *
 * Pure Prisma reads. This route never writes, never re-prices a token and never
 * invents a callout: a row only appears here after `tokenTrackingService` has
 * checked it against live market data and set `pnlPercentage`. That is what makes
 * the callouts *verifiable* — the UI renders recorded history, not a live claim.
 */

import { PrismaClient } from "@prisma/client";
import { Router } from "express";

import { ApiConfig } from "../config";
import { sendError } from "../contracts/errors";
import { AuthenticateDeps, createAuthenticateUnlessPublicReads } from "../middleware/authenticate";
import { createRateLimiter, createRateLimiterStore, rateLimitKey } from "../middleware/rateLimit";

export const API_CALLOUTS_VERSION = 1 as const;

/** The tracker shares a card at >= 50%; the public record uses the same bar. */
export const CALLOUT_MIN_PNL_PERCENTAGE = 50;

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export interface CalloutView {
  tokenAddress: string;
  tokenSymbol: string | null;
  tokenName: string | null;
  pnlPercentage: number;
  initialMarketCap: number;
  currentMarketCap: number | null;
  multiple: number | null;
  alertedAt: string;
  verifiedAt: string | null;
  shared: boolean;
}

/**
 * Parses `?limit=`, clamping to [1, MAX_LIMIT].
 * Returns null for input that is present but not a usable positive integer, so the
 * handler can 400 rather than silently serving a different page size than asked for.
 */
export function parseLimit(raw: unknown): number | null {
  if (raw === undefined) return DEFAULT_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return null;
  return Math.min(value, MAX_LIMIT);
}

/** Growth multiple (7.5x) alongside the percentage, which is how traders read these. */
export function toMultiple(initialMarketCap: number, currentMarketCap: number | null): number | null {
  if (currentMarketCap === null || !Number.isFinite(currentMarketCap)) return null;
  if (!Number.isFinite(initialMarketCap) || initialMarketCap <= 0) return null;
  return currentMarketCap / initialMarketCap;
}

export function toCalloutView(row: {
  tokenAddress: string;
  tokenSymbol: string | null;
  tokenName: string | null;
  pnlPercentage: number | null;
  initialMarketCap: number;
  currentMarketCap: number | null;
  alertTimestamp: Date;
  checkTimestamp: Date | null;
  pnlAlerted: boolean;
}): CalloutView {
  return {
    tokenAddress: row.tokenAddress,
    tokenSymbol: row.tokenSymbol,
    tokenName: row.tokenName,
    pnlPercentage: row.pnlPercentage ?? 0,
    initialMarketCap: row.initialMarketCap,
    currentMarketCap: row.currentMarketCap,
    multiple: toMultiple(row.initialMarketCap, row.currentMarketCap),
    alertedAt: row.alertTimestamp.toISOString(),
    verifiedAt: row.checkTimestamp?.toISOString() ?? null,
    shared: row.pnlAlerted,
  };
}

export function createCalloutsRouter(db: PrismaClient, config: ApiConfig, deps: AuthenticateDeps): Router {
  const router = Router();
  const readAuth = createAuthenticateUnlessPublicReads(config, deps);
  const store = createRateLimiterStore(config.rateLimit);
  const readLimiter = createRateLimiter({
    windowMs: 60_000,
    max: config.rateLimitPerMinute,
    keyFn: rateLimitKey,
    store,
  });

  /** GET /api/v1/callouts — verified PnL callouts, best first. */
  router.get("/", readAuth, readLimiter, async (req, res, next) => {
    try {
      const limit = parseLimit(req.query.limit);
      if (limit === null) {
        sendError(res, "BAD_REQUEST", "limit must be a positive integer", req.requestId);
        return;
      }

      const rows = await db.tokenAlert.findMany({
        where: {
          checked: true,
          pnlPercentage: { gte: CALLOUT_MIN_PNL_PERCENTAGE },
        },
        orderBy: [{ pnlPercentage: "desc" }, { alertTimestamp: "desc" }],
        take: limit,
      });

      res.json({ apiVersion: API_CALLOUTS_VERSION, callouts: rows.map(toCalloutView) });
    } catch (error) {
      next(error);
    }
  });

  /** GET /api/v1/callouts/:mint — the callout history for one token. */
  router.get("/:mint", readAuth, readLimiter, async (req, res, next) => {
    try {
      const rows = await db.tokenAlert.findMany({
        where: {
          tokenAddress: req.params.mint,
          checked: true,
          pnlPercentage: { gte: CALLOUT_MIN_PNL_PERCENTAGE },
        },
        orderBy: { alertTimestamp: "desc" },
        take: MAX_LIMIT,
      });

      if (rows.length === 0) {
        sendError(res, "NOT_FOUND", "no verified callouts for this token", req.requestId);
        return;
      }

      res.json({ apiVersion: API_CALLOUTS_VERSION, callouts: rows.map(toCalloutView) });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
