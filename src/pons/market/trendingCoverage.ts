/**
 * Phase 7E.4 §6 — is Trending rankable right now?
 *
 * The old answer was "only if every trade stream's finality reaches within ten minutes of
 * now", which conflates two unrelated things. A backfill repairing a gap from six hours ago
 * says nothing about whether the last five minutes are complete — but under the old rule it
 * switched Trending off entirely, and the whole list vanished for a reason no user could act
 * on.
 *
 * So the two are separated:
 *
 *   LIVE HEAD        how far behind the chain tip the trade streams are right now. This is
 *                    what decides whether the current 5m and 1h windows can be trusted.
 *   HISTORICAL LAG   how far behind the oldest unrepaired range is. Reported, never a reason
 *                    to disable a live ranking.
 *
 * Availability depends on the windows the score actually reads, and nothing else. A gap
 * INSIDE a scoring window still disables Trending — correctness is not weakened, only the
 * coupling to unrelated repair work is removed.
 */

import type { PrismaClient } from "@prisma/client";

import { loadFinality } from "../../candles/candleAggregationService";
import type { TrendingConfig } from "./trendingConfig";

export interface TrendingHealth {
  trendingAvailable: boolean;
  trendingUnavailableReason: string | null;
  /** Milliseconds between the newest indexed trade and now. Drives availability. */
  liveHeadLagMs: number | null;
  /** Whether the rolling window the score reads (default 1h) has no known gap. */
  rollingWindowCoverage: boolean;
  /** Whether the baseline window (default 6h before that) is complete enough to compare against. */
  baselineCoverage: boolean;
  /**
   * How far behind the oldest unrepaired historical range is, when known.
   * Reported for operators. Never a reason to disable Trending.
   */
  historicalBackfillLagMs: number | null;
  indexedUntil: string | null;
  computedAt: string;
}

function formatLag(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 120) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 72 ? `${hours} h` : `${Math.round(hours / 24)} days`;
}

/**
 * Assess coverage for the exact windows the scoring formula reads.
 *
 * `backfillLagMs` is supplied by the caller rather than derived here, because what counts as
 * "historical repair" is a property of the ingestion system and not of trending.
 */
export async function assessTrendingHealth(
  db: PrismaClient,
  config: TrendingConfig,
  now: Date,
  options: { backfillLagMs?: number | null } = {}
): Promise<TrendingHealth> {
  const finality = await loadFinality(db, "robinhood");
  const indexedUntil = finality.tradeLastHeightTimestamp;
  const liveHeadLagMs = indexedUntil ? Math.max(0, now.getTime() - indexedUntil.getTime()) : null;

  const base: TrendingHealth = {
    trendingAvailable: false,
    trendingUnavailableReason: null,
    liveHeadLagMs,
    rollingWindowCoverage: false,
    baselineCoverage: false,
    historicalBackfillLagMs: options.backfillLagMs ?? null,
    indexedUntil: indexedUntil?.toISOString() ?? null,
    computedAt: now.toISOString(),
  };

  if (finality.unresolvedReorg) {
    return { ...base, trendingUnavailableReason: "Trade indexing is paused on an unresolved chain reorganisation." };
  }
  if (indexedUntil === null || liveHeadLagMs === null) {
    return { ...base, trendingUnavailableReason: "Trade indexing has not reached recent blocks for every Pons trade stream yet." };
  }

  // The rolling window is covered when the live head is inside it. If indexing is further
  // behind than the window is long, the window cannot be complete by definition.
  const rollingWindowCoverage = liveHeadLagMs <= config.coverage.maxLiveHeadLagMs;
  // The baseline sits entirely in the past, so it is covered whenever indexing has reached
  // at least the end of it. Historical repair further back does not affect this.
  const baselineCoverage = liveHeadLagMs <= config.coverage.baselineWindowMs;

  if (!rollingWindowCoverage) {
    return {
      ...base,
      rollingWindowCoverage,
      baselineCoverage,
      trendingUnavailableReason: `Trades are indexed up to ${indexedUntil.toISOString()}, ${formatLag(liveHeadLagMs)} behind the chain, so the current window is incomplete.`,
    };
  }

  return { ...base, trendingAvailable: true, rollingWindowCoverage, baselineCoverage, trendingUnavailableReason: null };
}
