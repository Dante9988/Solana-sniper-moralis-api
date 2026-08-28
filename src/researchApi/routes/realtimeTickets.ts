/**
 * Phase 7B.2 — POST /api/v1/realtime/tickets (phase7b2.txt §4). Issues a
 * short-lived, single-use WebSocket connection ticket for the authenticated
 * caller. Never accepts a Supabase JWT directly on the WebSocket upgrade —
 * this REST call is where the JWT is actually verified; the ticket it
 * returns is a narrow, disposable credential good for one connection
 * attempt within a short window.
 */

import { Router } from "express";
import { AuthenticateDeps, createRequireSupabaseUser } from "../middleware/authenticate";
import { ApiConfig } from "../config";
import { TicketStore } from "../realtime/ticketStore";

export function createRealtimeTicketsRouter(config: ApiConfig, deps: AuthenticateDeps, ticketStore: TicketStore): Router {
  const router = Router();
  const requireSupabaseUser = createRequireSupabaseUser(deps);

  router.post("/tickets", requireSupabaseUser, async (req, res, next) => {
    try {
      const userId = (req.auth as { userId: string }).userId;
      const ticket = await ticketStore.issue(userId, config.realtime.ticketTtlMs);
      res.json({ ticket, expiresInMs: config.realtime.ticketTtlMs });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
