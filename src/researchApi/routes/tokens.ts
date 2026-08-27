/**
 * Phase 6 — `/api/v1/tokens/:mint/*` routes (phase6.txt §3).
 *
 * Pure Prisma reads (via `src/services/riskViewLoader.ts`), plus one
 * idempotent job enqueue on `POST /scan`. Never writes report content, never
 * mutates eligibility, never signs anything.
 */

import { PrismaClient } from "@prisma/client";
import { Router } from "express";
import { computeJobKey, enqueueSolanaForensicsJob } from "../../forensics/forensicsJobService";
import { FORENSICS_POLICY_VERSION } from "../../forensics/thresholds";
import { toApiJson } from "../../presentation/toApiJson";
import { loadRiskViewForMint } from "../../services/riskViewLoader";
import { ApiConfig } from "../config";
import { requireApiKey, requireApiKeyUnlessPublicReads } from "../middleware/auth";
import { createRateLimiter, rateLimitKey } from "../middleware/rateLimit";
import { validateMint } from "../middleware/validateMint";

export function createTokensRouter(db: PrismaClient, config: ApiConfig): Router {
  const router = Router();
  const readAuth = requireApiKeyUnlessPublicReads(config);
  const scanAuth = requireApiKey(config);
  const readLimiter = createRateLimiter({ windowMs: 60_000, max: config.rateLimitPerMinute, keyFn: rateLimitKey });
  const scanLimiter = createRateLimiter({
    windowMs: 60 * 60_000,
    max: config.scanEnqueueLimitPerHour,
    keyFn: rateLimitKey,
  });

  router.get("/:mint/report", readAuth, readLimiter, validateMint, async (req, res, next) => {
    try {
      const view = await loadRiskViewForMint(db, req.normalizedMint!);
      if (!view) {
        res.status(404).json({ error: "token has never been analysed" });
        return;
      }
      res.json(toApiJson(view));
    } catch (err) {
      next(err);
    }
  });

  router.get("/:mint/forensics", readAuth, readLimiter, validateMint, async (req, res, next) => {
    try {
      const run = await db.solanaForensicsRun.findFirst({
        where: { mint: req.normalizedMint },
        orderBy: { createdAt: "desc" },
        include: {
          eligibility: true,
          clusters: { include: { members: true } },
          evidence: true,
        },
      });
      if (!run) {
        res.status(404).json({ error: "no forensics run for this token" });
        return;
      }
      res.json({
        apiVersion: 1,
        mint: run.mint,
        runId: run.id,
        analysisLevel: run.analysisLevel,
        policyVersion: run.policyVersion,
        runStatus: run.runStatus,
        coverageStatus: run.coverageStatus,
        eligibility: run.eligibility
          ? {
              eligibility: run.eligibility.eligibility,
              displaySeverity: run.eligibility.displaySeverity,
              reasonCodes: run.eligibility.reasonCodes,
              requiredEvidenceComplete: run.eligibility.requiredEvidenceComplete,
            }
          : null,
        clusters: run.clusters.map((c) => ({
          classification: c.classification,
          confidence: Number(c.confidence),
          reasonCodes: c.reasonCodes,
          members: c.members.map((m) => m.wallet),
        })),
        evidence: run.evidence.map((e) => ({
          category: e.category,
          reasonCode: e.reasonCode,
          source: e.source,
          signature: e.signature,
          slot: e.slot,
          wallets: e.wallets,
        })),
        startedAt: run.startedAt,
        completedAt: run.completedAt,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:mint/scan", scanAuth, scanLimiter, validateMint, async (req, res, next) => {
    try {
      const mint = req.normalizedMint!;
      const eventId = `api-scan:${mint}`;
      const jobKey = computeJobKey({
        normalizedMint: mint,
        eventId,
        analysisLevel: "FAST",
        policyVersion: FORENSICS_POLICY_VERSION,
      });
      const result = await enqueueSolanaForensicsJob(db, {
        mint,
        eventId,
        discoverySource: "UNKNOWN",
        analysisLevel: "FAST",
        policyVersion: FORENSICS_POLICY_VERSION,
      });
      res.json({ jobKey, status: result.status });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
