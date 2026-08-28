/**
 * Phase 7B.1 — GET /api/v1/health (liveness) and GET /api/v1/ready
 * (readiness), per phase7b1.txt §6: "Health should only prove the process
 * is alive. Readiness should check required dependencies safely without
 * leaking credentials or internal connection details."
 */

import { PrismaClient } from "@prisma/client";
import { Router } from "express";

export function createHealthRouter(db: PrismaClient): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  router.get("/ready", async (_req, res) => {
    try {
      await db.$queryRaw`SELECT 1`;
      res.json({ status: "ready", checks: { database: "ok" } });
    } catch {
      // Never include the underlying error (may contain the connection
      // string, host, or credentials) in the response — only in server logs.
      res.status(503).json({ status: "not_ready", checks: { database: "error" } });
    }
  });

  return router;
}
