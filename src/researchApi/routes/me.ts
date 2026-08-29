/**
 * Phase 6/7B.1/7B.2 — GET /api/v1/me (phase7b1.txt §6): a minimal, safe user
 * representation derived from the verified Supabase identity. Returns only
 * the immutable subject id and (if present) email — never raw token claims.
 *
 * Phase 7B.2 adds GET/DELETE /api/v1/me/wallets (phase7b2.txt §2) — listing
 * and unlinking this user's own verified wallets. Both strictly
 * Supabase-authenticated, same as /me itself.
 */

import { PrismaClient } from "@prisma/client";
import { Router } from "express";
import { AuthenticateDeps, createRequireSupabaseUser } from "../middleware/authenticate";
import { sendError } from "../contracts/errors";
import { listVerifiedWallets, unlinkVerifiedWallet } from "../../services/walletVerificationService";

export function createMeRouter(db: PrismaClient, deps: AuthenticateDeps): Router {
  const router = Router();
  const requireSupabaseUser = createRequireSupabaseUser(deps);

  router.get("/me", requireSupabaseUser, (req, res) => {
    if (req.auth?.type !== "supabase") {
      // createRequireSupabaseUser guarantees this, but keep the type guard
      // explicit rather than asserting — a defensive 401, never a crash.
      sendError(res, "UNAUTHORIZED", "missing bearer token", req.requestId);
      return;
    }
    res.json({ userId: req.auth.userId, email: req.auth.email });
  });

  router.get("/me/wallets", requireSupabaseUser, async (req, res, next) => {
    try {
      const wallets = await listVerifiedWallets(db, (req.auth as { userId: string }).userId);
      res.json(wallets.map((w) => ({ id: w.id, address: w.address, network: w.network, verifiedAt: w.verifiedAt.toISOString() })));
    } catch (err) {
      next(err);
    }
  });

  router.delete("/me/wallets/:walletId", requireSupabaseUser, async (req, res, next) => {
    try {
      const removed = await unlinkVerifiedWallet(db, (req.auth as { userId: string }).userId, req.params.walletId);
      if (!removed) {
        sendError(res, "NOT_FOUND", "no such verified wallet for this account", req.requestId);
        return;
      }
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
