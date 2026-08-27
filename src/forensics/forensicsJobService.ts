/**
 * Phase 5D — durable Solana forensics job service (phase5d.txt §§9, 12).
 *
 * Every function takes an explicit `PrismaClient` parameter rather than
 * importing the shared singleton, so unit tests inject a mock without a
 * real database (phase5d.txt §16: "Mock Prisma for unit tests").
 *
 * Job claiming uses a single-statement `SELECT ... FOR UPDATE SKIP LOCKED`
 * (Prisma tagged-template `$queryRaw`, fully parameterized — never
 * string-concatenated SQL) inside one `$transaction`, followed by a
 * type-safe `.update()` in the same transaction, so two worker processes can
 * never claim the same job.
 */

import { Prisma, PrismaClient } from "@prisma/client";
import { resolveAsset } from "../assets/assetResolver";
import { upsertAsset } from "../assets/assetStore";
import { AnalysisLevel, LaunchInfo } from "./types";

export type ForensicsJobStatus = "PENDING" | "RUNNING" | "COMPLETE" | "PARTIAL" | "FAILED";

export class ForensicsJobValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForensicsJobValidationError";
  }
}

export interface EnqueueSolanaForensicsJobInput {
  mint: string;
  eventId?: string;
  discoverySignature?: string;
  discoverySource: LaunchInfo["source"];
  analysisLevel: AnalysisLevel;
  policyVersion: string;
  priority?: number;
  maxAttempts?: number;
}

export interface EnqueueSolanaForensicsJobResult {
  jobId: string;
  created: boolean;
  status: ForensicsJobStatus;
}

/** solana-mainnet + normalized mint + discovery signature/event identity + analysis level + policy version. */
export function computeJobKey(input: {
  normalizedMint: string;
  discoverySignature?: string;
  eventId?: string;
  analysisLevel: AnalysisLevel;
  policyVersion: string;
}): string {
  const eventIdentity = input.discoverySignature ?? input.eventId ?? "no-event-identity";
  return `solana-mainnet:${input.normalizedMint}:${eventIdentity}:${input.analysisLevel}:${input.policyVersion}`;
}

/**
 * Idempotent: a duplicate enqueue (same jobKey) returns the existing job
 * instead of creating a second one, even under concurrent callers (a unique-
 * constraint race is caught and resolved by re-reading the row).
 */
export async function enqueueSolanaForensicsJob(
  db: PrismaClient,
  input: EnqueueSolanaForensicsJobInput
): Promise<EnqueueSolanaForensicsJobResult> {
  const resolved = resolveAsset({ address: input.mint, chain: "SOLANA" });
  if (resolved.status !== "RESOLVED") {
    const reason = "reason" in resolved ? resolved.reason : `resolution status ${resolved.status}`;
    throw new ForensicsJobValidationError(`Invalid Solana mint for forensics job: ${reason}`);
  }
  const asset = await upsertAsset(resolved.asset);

  const jobKey = computeJobKey({
    normalizedMint: resolved.asset.normalizedAddress,
    discoverySignature: input.discoverySignature,
    eventId: input.eventId,
    analysisLevel: input.analysisLevel,
    policyVersion: input.policyVersion,
  });

  try {
    const created = await db.solanaForensicsJob.create({
      data: {
        jobKey,
        assetId: asset.id,
        mint: resolved.asset.normalizedAddress,
        eventId: input.eventId,
        discoverySignature: input.discoverySignature,
        discoverySource: input.discoverySource,
        analysisLevel: input.analysisLevel,
        policyVersion: input.policyVersion,
        priority: input.priority ?? 0,
        maxAttempts: input.maxAttempts ?? 5,
      },
    });
    return { jobId: created.id, created: true, status: created.status as ForensicsJobStatus };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existing = await db.solanaForensicsJob.findUnique({ where: { jobKey } });
      if (existing) return { jobId: existing.id, created: false, status: existing.status as ForensicsJobStatus };
    }
    throw err;
  }
}

export interface ClaimedForensicsJob {
  id: string;
  jobKey: string;
  assetId: string;
  mint: string;
  eventId: string | null;
  discoverySignature: string | null;
  discoverySource: string;
  analysisLevel: string;
  policyVersion: string;
  attemptCount: number;
  maxAttempts: number;
}

/**
 * Atomically claims one available `PENDING` job or one `RUNNING` job whose
 * lease has expired (and still has attempts remaining), or returns `null` if
 * none is available. Deterministic ordering: highest priority, then oldest
 * first.
 */
export async function claimNextForensicsJob(
  db: PrismaClient,
  workerId: string,
  leaseMs: number
): Promise<ClaimedForensicsJob | null> {
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);

  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT "id" FROM "SolanaForensicsJob"
      WHERE (
        ("status" = 'PENDING' AND "availableAt" <= ${now})
        OR ("status" = 'RUNNING' AND "leaseExpiresAt" IS NOT NULL AND "leaseExpiresAt" < ${now} AND "attemptCount" < "maxAttempts")
      )
      ORDER BY "priority" DESC, "createdAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `);
    const row = rows[0];
    if (!row) return null;

    const updated = await tx.solanaForensicsJob.update({
      where: { id: row.id },
      data: {
        status: "RUNNING",
        leaseOwner: workerId,
        leaseExpiresAt,
        attemptCount: { increment: 1 },
        startedAt: now,
      },
    });

    return {
      id: updated.id,
      jobKey: updated.jobKey,
      assetId: updated.assetId,
      mint: updated.mint,
      eventId: updated.eventId,
      discoverySignature: updated.discoverySignature,
      discoverySource: updated.discoverySource,
      analysisLevel: updated.analysisLevel,
      policyVersion: updated.policyVersion,
      attemptCount: updated.attemptCount,
      maxAttempts: updated.maxAttempts,
    };
  });
}

/** Only the current lease owner may extend it. Returns false if the lease was lost (reclaimed by another worker or job no longer RUNNING). */
export async function extendForensicsJobLease(
  db: PrismaClient,
  jobId: string,
  workerId: string,
  leaseMs: number
): Promise<boolean> {
  const result = await db.solanaForensicsJob.updateMany({
    where: { id: jobId, leaseOwner: workerId, status: "RUNNING" },
    data: { leaseExpiresAt: new Date(Date.now() + leaseMs) },
  });
  return result.count === 1;
}

/** Releases the lease and returns the job to PENDING immediately (e.g. on graceful shutdown). No-op if this worker no longer holds the lease. */
export async function releaseForensicsJobLease(db: PrismaClient, jobId: string, workerId: string): Promise<void> {
  await db.solanaForensicsJob.updateMany({
    where: { id: jobId, leaseOwner: workerId },
    data: { status: "PENDING", leaseOwner: null, leaseExpiresAt: null },
  });
}

function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/https?:\/\/[^\s"']+/gi, "[redacted-url]")
    .replace(/api[-_]?key["'=:\s]+[^\s"'&]+/gi, "api-key=[redacted]")
    .slice(0, 500);
}

/** Marks a job COMPLETE or PARTIAL. Budget-exhausted/coverage-limited usable results persist as PARTIAL and do NOT automatically retry (phase5d.txt §10). */
export async function completeForensicsJob(
  db: PrismaClient,
  jobId: string,
  workerId: string,
  status: "COMPLETE" | "PARTIAL"
): Promise<boolean> {
  const result = await db.solanaForensicsJob.updateMany({
    where: { id: jobId, leaseOwner: workerId },
    data: { status, leaseOwner: null, leaseExpiresAt: null, completedAt: new Date() },
  });
  return result.count === 1;
}

/** Retryable failure: returns to PENDING with bounded exponential backoff (only if attempts remain — caller decides via `shouldRetry`). */
export async function retryForensicsJob(
  db: PrismaClient,
  jobId: string,
  workerId: string,
  errorCode: string,
  errorMessage: string,
  backoffMs: number
): Promise<boolean> {
  const result = await db.solanaForensicsJob.updateMany({
    where: { id: jobId, leaseOwner: workerId },
    data: {
      status: "PENDING",
      leaseOwner: null,
      leaseExpiresAt: null,
      availableAt: new Date(Date.now() + backoffMs),
      lastErrorCode: errorCode,
      lastErrorMessage: sanitizeErrorMessage(errorMessage),
    },
  });
  return result.count === 1;
}

/** Permanent failure: input/schema errors, or retries exhausted. */
export async function failForensicsJob(
  db: PrismaClient,
  jobId: string,
  workerId: string,
  errorCode: string,
  errorMessage: string
): Promise<boolean> {
  const result = await db.solanaForensicsJob.updateMany({
    where: { id: jobId, leaseOwner: workerId },
    data: {
      status: "FAILED",
      leaseOwner: null,
      leaseExpiresAt: null,
      completedAt: new Date(),
      lastErrorCode: errorCode,
      lastErrorMessage: sanitizeErrorMessage(errorMessage),
    },
  });
  return result.count === 1;
}

/** Bounded exponential backoff with a hard cap, no jitter needed at this scale (single-worker default concurrency). */
export function computeBackoffMs(attemptNumber: number, baseBackoffMs: number, capMs = 10 * 60_000): number {
  return Math.min(capMs, baseBackoffMs * 2 ** Math.max(0, attemptNumber - 1));
}
