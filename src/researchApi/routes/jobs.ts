/**
 * Phase 6/7B.1/7B.2 — `/api/v1/jobs/:jobKey` polling route (phase6.txt §3,
 * phase7b1.txt §6). Read-only.
 *
 * Phase 7B.2 (phase7b2.txt §3): the underlying SolanaForensicsJob may be
 * shared/deduplicated across users, but a Supabase-authenticated caller may
 * only read a job they themselves requested — checked via
 * scanOwnershipService.userOwnsJob before returning anything. An internal
 * API-key caller (admin/server-to-server, no Supabase user id) keeps the
 * prior, unscoped access — that's the intended difference between an
 * end-user credential and an internal one. A caller with no access gets a
 * plain 404, identical to an unknown jobKey, so this never confirms that a
 * job exists for someone who isn't allowed to see it.
 */

import { PrismaClient } from "@prisma/client";
import { Router } from "express";
import { loadJobStatus } from "../../services/riskViewLoader";
import { userOwnsJob } from "../../services/scanOwnershipService";
import { ApiConfig } from "../config";
import { AuthenticateDeps, createAuthenticateUnlessPublicReads } from "../middleware/authenticate";
import { sendError } from "../contracts/errors";
import { createRateLimiter, createRateLimiterStore, rateLimitKey } from "../middleware/rateLimit";

export function createJobsRouter(db: PrismaClient, config: ApiConfig, deps: AuthenticateDeps): Router {
  const router = Router();
  const readAuth = createAuthenticateUnlessPublicReads(config, deps);
  const store = createRateLimiterStore(config.rateLimit);
  const readLimiter = createRateLimiter({ windowMs: 60_000, max: config.rateLimitPerMinute, keyFn: rateLimitKey, store });

  router.get("/:jobKey", readAuth, readLimiter, async (req, res, next) => {
    try {
      if (req.auth?.type === "supabase") {
        const owns = await userOwnsJob(db, req.auth.userId, req.params.jobKey);
        if (!owns) {
          sendError(res, "NOT_FOUND", "unknown job", req.requestId);
          return;
        }
      }
      // req.auth is undefined only when API_PUBLIC_READS=true and no token
      // was presented — same fully-public behavior Phase 6 already had.

      const job = await loadJobStatus(db, req.params.jobKey);
      if (!job) {
        sendError(res, "NOT_FOUND", "unknown job", req.requestId);
        return;
      }
      res.json(job);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
