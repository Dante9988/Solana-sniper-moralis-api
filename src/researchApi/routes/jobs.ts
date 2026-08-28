/**
 * Phase 6/7B.1 — `/api/v1/jobs/:jobKey` polling route (phase6.txt §3, phase7b1.txt §6). Read-only.
 */

import { PrismaClient } from "@prisma/client";
import { Router } from "express";
import { loadJobStatus } from "../../services/riskViewLoader";
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
