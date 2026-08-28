/**
 * Phase 6/7B.1 — `/api/v1/tokens/:mint/*` routes (phase6.txt §3, phase7b1.txt §6).
 *
 * Pure Prisma reads (via `src/services/riskViewLoader.ts`), plus one
 * idempotent job enqueue on `POST /scans`. Never writes report content,
 * never mutates eligibility, never signs anything. All persistence and
 * intelligence logic is reused from existing services — nothing is
 * duplicated in these handlers.
 */

import { PrismaClient } from "@prisma/client";
import { Router } from "express";
import { computeJobKey, enqueueSolanaForensicsJob } from "../../forensics/forensicsJobService";
import { FORENSICS_POLICY_VERSION } from "../../forensics/thresholds";
import { toApiJson } from "../../presentation/toApiJson";
import { loadRiskViewForMint } from "../../services/riskViewLoader";
import { recordScanRequest } from "../../services/scanOwnershipService";
import { ApiConfig } from "../config";
import { AuthenticateDeps, createAuthenticate, createAuthenticateUnlessPublicReads } from "../middleware/authenticate";
import { sendError } from "../contracts/errors";
import { createRateLimiter, createRateLimiterStore, rateLimitKey } from "../middleware/rateLimit";
import { validateMint } from "../middleware/validateMint";
import { EventBus } from "../realtime/eventBus";
import { publishJobEvent } from "../realtime/eventPublisher";

export function createTokensRouter(db: PrismaClient, config: ApiConfig, deps: AuthenticateDeps, eventBus: EventBus): Router {
  const router = Router();
  const readAuth = createAuthenticateUnlessPublicReads(config, deps);
  const scanAuth = createAuthenticate(config, deps);
  const store = createRateLimiterStore(config.rateLimit);
  const readLimiter = createRateLimiter({ windowMs: 60_000, max: config.rateLimitPerMinute, keyFn: rateLimitKey, store });
  const scanLimiter = createRateLimiter({
    windowMs: 60 * 60_000,
    max: config.scanEnqueueLimitPerHour,
    keyFn: rateLimitKey,
    store,
  });

  router.get("/:mint/report", readAuth, readLimiter, validateMint, async (req, res, next) => {
    try {
      const view = await loadRiskViewForMint(db, req.normalizedMint!);
      if (!view) {
        sendError(res, "NOT_FOUND", "token has never been analysed", req.requestId);
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
        sendError(res, "NOT_FOUND", "no forensics run for this token", req.requestId);
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

  // Renamed from /scan (Phase 6) to /scans (phase7b1.txt §6/§4) — POST
  // .../scans creates (or idempotently returns) one scan resource.
  router.post("/:mint/scans", scanAuth, scanLimiter, validateMint, async (req, res, next) => {
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

      // Record who asked, regardless of whether this call created the job or
      // joined an already-deduplicated one (phase7b2.txt §3) — an internal
      // API-key caller has no Supabase user id to scope this to, and keeps
      // its existing unscoped access via the auth check in jobs.ts instead.
      if (req.auth?.type === "supabase") {
        await recordScanRequest(db, { userId: req.auth.userId, mint, jobKey });
      }

      // Emitted only after the enqueue itself has genuinely succeeded
      // (phase7b2.txt §6 "emit events only after the relevant authoritative
      // state change succeeds") — including on the idempotent-repeat path,
      // since a second subscriber to the same job still needs to see it.
      await publishJobEvent(eventBus, "scan.accepted", { jobKey, mint, status: result.status });

      // 202 for a freshly queued job, 200 for an idempotent hit on one
      // already in flight/complete — both return the same jobKey either way.
      res.status(result.created ? 202 : 200).json({ jobKey, status: result.status });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
