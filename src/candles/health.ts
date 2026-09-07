/**
 * Phase 7B.5B §15 — candle-service health, extending sourceHealth.ts's
 * pattern (same vocabulary: LIVE/LAGGING/DEGRADED/REORG_RECOVERY/
 * UNAVAILABLE; same "pure read of persisted state, never a live probe per
 * request" discipline) rather than building an unrelated second health
 * system. A separate table (`CandleWorkerRunState`) because this is a
 * whole-worker-tick operational summary, not per-source ingestion
 * checkpoint metadata like `ChainIngestionCheckpoint`.
 */

import type { PrismaClient } from "@prisma/client";
import type { CandleAggregationTickSummary } from "./candleAggregationService";
import type { CandleHealthThresholds } from "./config";

export type CandleHealthStatus = "LIVE" | "LAGGING" | "DEGRADED" | "REORG_RECOVERY" | "UNAVAILABLE";

export interface CandleHealthProjection {
  readonly status: CandleHealthStatus;
  readonly lastTickAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly secondsSinceLastSuccess: number | null;
  readonly lastError: string | null;
  readonly lastErrorAt: string | null;
  readonly lastTokensProcessed: number | null;
  readonly lastCandlesWritten: number | null;
  readonly lastBucketsRecomputed: number | null;
  readonly lastInvalidationsProcessed: number | null;
  readonly lastTickDurationMs: number | null;
  readonly pendingInvalidations: number;
  readonly observedAt: string;
}

/** Called once per worker tick (candlesWorkerMain.ts) — persists the whole-tick operational summary the health projection and §17 performance reporting both read. */
export async function recordCandleWorkerRunState(db: PrismaClient, chain: string, summary: CandleAggregationTickSummary): Promise<void> {
  const now = new Date();
  const firstError = summary.errors[0] ?? null;
  await db.candleWorkerRunState.upsert({
    where: { chain },
    create: {
      chain,
      lastTickAt: now,
      lastSuccessAt: now,
      lastError: firstError,
      lastErrorAt: firstError ? now : null,
      lastTokensProcessed: summary.tokensProcessed,
      lastCandlesWritten: summary.candlesWritten,
      lastBucketsRecomputed: summary.bucketsRecomputed,
      lastInvalidationsProcessed: summary.invalidationsProcessed,
      lastTickDurationMs: summary.durationMs,
    },
    update: {
      lastTickAt: now,
      lastSuccessAt: now, // reaching here means the tick completed without throwing — see candlesWorkerMain.ts's catch, which records a failed tick separately via recordCandleWorkerFailure
      lastError: firstError,
      lastErrorAt: firstError ? now : null,
      lastTokensProcessed: summary.tokensProcessed,
      lastCandlesWritten: summary.candlesWritten,
      lastBucketsRecomputed: summary.bucketsRecomputed,
      lastInvalidationsProcessed: summary.invalidationsProcessed,
      lastTickDurationMs: summary.durationMs,
    },
  });
}

/** A tick that threw before completing (e.g. a DB connectivity failure) — records the failure without a false lastSuccessAt bump. */
export async function recordCandleWorkerFailure(db: PrismaClient, chain: string, reason: string): Promise<void> {
  const now = new Date();
  await db.candleWorkerRunState
    .update({ where: { chain }, data: { lastTickAt: now, lastError: reason, lastErrorAt: now } })
    .catch(async (err: unknown) => {
      if (isRecordNotFoundError(err)) {
        await db.candleWorkerRunState.create({ data: { chain, lastTickAt: now, lastError: reason, lastErrorAt: now } });
        return;
      }
      throw err;
    });
}

function isRecordNotFoundError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "P2025";
}

export async function computeCandleHealth(db: PrismaClient, chain: string, thresholds: CandleHealthThresholds, now: Date = new Date()): Promise<CandleHealthProjection> {
  const [state, pendingInvalidations] = await Promise.all([
    db.candleWorkerRunState.findUnique({ where: { chain } }),
    db.candleInvalidation.count({ where: { chain, processedAt: null } }),
  ]);

  const status = classifyCandleHealth(state, pendingInvalidations, now, thresholds);
  const secondsSinceLastSuccess = state?.lastSuccessAt ? Math.floor((now.getTime() - state.lastSuccessAt.getTime()) / 1000) : null;

  return {
    status,
    lastTickAt: state?.lastTickAt?.toISOString() ?? null,
    lastSuccessAt: state?.lastSuccessAt?.toISOString() ?? null,
    secondsSinceLastSuccess,
    lastError: state?.lastError ?? null,
    lastErrorAt: state?.lastErrorAt?.toISOString() ?? null,
    lastTokensProcessed: state?.lastTokensProcessed ?? null,
    lastCandlesWritten: state?.lastCandlesWritten ?? null,
    lastBucketsRecomputed: state?.lastBucketsRecomputed ?? null,
    lastInvalidationsProcessed: state?.lastInvalidationsProcessed ?? null,
    lastTickDurationMs: state?.lastTickDurationMs ?? null,
    pendingInvalidations,
    observedAt: now.toISOString(),
  };
}

/**
 * `lastSuccessAt`/`lastErrorAt` are always written simultaneously by
 * recordCandleWorkerRunState (a tick reaching that call completed without
 * throwing, whether or not it accumulated per-token errors) — so unlike
 * sourceHealth.ts's "error newer than success" comparison, DEGRADED here is
 * simply "the most recent completed tick recorded a per-token error and
 * that tick was recent enough to still matter" (`lastError` is cleared to
 * null by any subsequent clean tick, so it always reflects the latest
 * tick's own outcome).
 *
 * LAGGING is a deliberately simple proxy — "the worker's last successful
 * tick isn't recent" — not yet a true measurement of aggregation lag behind
 * Pons trade ingestion (comparing the latest processed trade's
 * sourceTimestamp against the trade checkpoint's own confirmed height).
 * This is a documented simplification (ARCHITECTURE.md §21.16/NOT PROVEN):
 * the raw per-tick counters this projection also exposes
 * (lastTokensProcessed/lastCandlesWritten/lastBucketsRecomputed) are the
 * evidence a future phase would use to build the precise version, the same
 * "measure before building it" discipline ARCHITECTURE.md §20.3 used for
 * pool-set scaling.
 */
export function classifyCandleHealth(
  state: { lastTickAt: Date | null; lastSuccessAt: Date | null; lastError: string | null; lastErrorAt: Date | null } | null,
  pendingInvalidations: number,
  now: Date,
  thresholds: CandleHealthThresholds
): CandleHealthStatus {
  if (!state) return "UNAVAILABLE"; // worker has never completed a tick

  const msSinceTick = state.lastTickAt ? now.getTime() - state.lastTickAt.getTime() : Number.POSITIVE_INFINITY;
  if (msSinceTick > thresholds.healthStaleMs) return "UNAVAILABLE"; // the worker loop itself appears to have stopped

  // Still-unprocessed reorg invalidations mean some candles are known-stale
  // pending recompute — a distinct, worse state than ordinary lag.
  if (pendingInvalidations > 0) return "REORG_RECOVERY";

  const hasRecentError = state.lastErrorAt !== null && now.getTime() - state.lastErrorAt.getTime() <= thresholds.healthErrorWindowMs;
  if (state.lastError !== null && hasRecentError) return "DEGRADED";

  const msSinceSuccess = state.lastSuccessAt ? now.getTime() - state.lastSuccessAt.getTime() : Number.POSITIVE_INFINITY;
  if (msSinceSuccess > thresholds.healthLaggingMs) return "LAGGING";

  return "LIVE";
}
