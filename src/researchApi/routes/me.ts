/**
 * Phase 7B.1 — GET /api/v1/me (phase7b1.txt §6): a minimal, safe user
 * representation derived from the verified Supabase identity. Returns only
 * the immutable subject id and (if present) email — never raw token claims.
 */

import { Router } from "express";
import { AuthenticateDeps, createRequireSupabaseUser } from "../middleware/authenticate";

export function createMeRouter(deps: AuthenticateDeps): Router {
  const router = Router();
  const requireSupabaseUser = createRequireSupabaseUser(deps);

  router.get("/me", requireSupabaseUser, (req, res) => {
    if (req.auth?.type !== "supabase") {
      // createRequireSupabaseUser guarantees this, but keep the type guard
      // explicit rather than asserting — a defensive 401, never a crash.
      res.status(401).json({ error: { code: "UNAUTHORIZED", message: "missing bearer token", requestId: req.requestId } });
      return;
    }
    res.json({ userId: req.auth.userId, email: req.auth.email });
  });

  return router;
}
