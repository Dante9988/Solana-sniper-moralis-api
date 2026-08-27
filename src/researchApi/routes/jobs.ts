/**
 * Phase 6 — `/api/v1/jobs/:jobKey` polling route (phase6.txt §3). Read-only.
 */

import { PrismaClient } from "@prisma/client";
import { Router } from "express";
import { loadJobStatus } from "../../services/riskViewLoader";
import { ApiConfig } from "../config";
import { requireApiKeyUnlessPublicReads } from "../middleware/auth";
import { createRateLimiter, rateLimitKey } from "../middleware/rateLimit";

export function createJobsRouter(db: PrismaClient, config: ApiConfig): Router {
  const router = Router();
  const readAuth = requireApiKeyUnlessPublicReads(config);
  const readLimiter = createRateLimiter({ windowMs: 60_000, max: config.rateLimitPerMinute, keyFn: rateLimitKey });

  router.get("/:jobKey", readAuth, readLimiter, async (req, res, next) => {
    try {
      const job = await loadJobStatus(db, req.params.jobKey);
      if (!job) {
        res.status(404).json({ error: "unknown job" });
        return;
      }
      res.json(job);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
