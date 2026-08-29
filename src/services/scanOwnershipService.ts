/**
 * Phase 7B.2 — user-scoped scan/job ownership (phase7b2.txt §3). The
 * underlying SolanaForensicsJob stays globally deduplicated by mint +
 * analysis policy (Phase 5D/6) — this module only tracks *who asked*, so
 * `GET /api/v1/jobs/:jobKey` (and, later, realtime job events) can be
 * scoped to the requesting user without duplicating or un-deduplicating any
 * of the underlying forensics work. Multiple users requesting the same mint
 * safely share one job and each get their own row here.
 */

import { PrismaClient } from '@prisma/client';

/** Idempotent: re-requesting the same (user, jobKey) pair is a no-op, not a duplicate row (see the `@@unique([userId, jobKey])` constraint). */
export async function recordScanRequest(db: PrismaClient, input: { userId: string; mint: string; jobKey: string }): Promise<void> {
  await db.userScanRequest.upsert({
    where: { userId_jobKey: { userId: input.userId, jobKey: input.jobKey } },
    update: {},
    create: { userId: input.userId, mint: input.mint, jobKey: input.jobKey },
  });
}

/** True if `userId` has ever requested a scan that produced/joined this jobKey. Never leaks *who else* requested it — callers only ever ask about their own userId. */
export async function userOwnsJob(db: PrismaClient, userId: string, jobKey: string): Promise<boolean> {
  const row = await db.userScanRequest.findUnique({ where: { userId_jobKey: { userId, jobKey } } });
  return row !== null;
}

/** All jobKeys a user has ever requested — used to scope which realtime job channels a WebSocket connection may subscribe to. */
export async function listUserJobKeys(db: PrismaClient, userId: string): Promise<string[]> {
  const rows = await db.userScanRequest.findMany({ where: { userId }, select: { jobKey: true } });
  return rows.map((r) => r.jobKey);
}
