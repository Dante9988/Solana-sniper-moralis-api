/**
 * Phase 7B.5A §5 — backend-owned ingestion source-health projection.
 *
 * The frontend/mobile app must distinguish LIVE / LAGGING / DEGRADED /
 * REORG_RECOVERY / UNAVAILABLE without inferring health itself from raw
 * data. This module is the single place that turns the persisted facts
 * each listener already records on every tick (checkpointStore.ts's
 * lastPollAt/lastSuccessAt/lastError/reorgUnresolvedAt) into that
 * classification — a pure read of already-committed Postgres rows, never a
 * live RPC call per API request (a health check must not itself be able to
 * make an already-degraded feed slower).
 */

import type { PrismaClient } from "@prisma/client";
import { findActiveSession, loadIngestionMode } from "./ingestionSession";
import { ROBINHOOD_CHAIN } from "./discoveryListener";
import { CheckpointStore, CheckpointHealthState } from "./checkpointStore";
import { DISCOVERY_CHECKPOINT_SOURCE } from "./discoveryListener";
import { TRADE_CHECKPOINT_SOURCE } from "./tradeListener";
import { DISCOVERY_V2_CHECKPOINT_SOURCE } from "./discoveryV2Listener";
import { TRADE_V2_CHECKPOINT_SOURCE } from "./tradeV2Listener";
import { CURVE_TRADE_CHECKPOINT_SOURCE } from "./curveTradeListener";
import { RobinhoodChainConfig } from "./config";

export type IngestionHealthStatus = "LIVE" | "LAGGING" | "DEGRADED" | "REORG_RECOVERY" | "UNAVAILABLE";

export interface SourceHealthDetail {
  readonly source: string;
  readonly status: IngestionHealthStatus;
  readonly lastHeight: string | null;
  readonly lastObservedChainHeight: string | null;
  readonly blocksBehind: string | null;
  readonly lastPollAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly secondsSinceLastSuccess: number | null;
  /** Redacted operational message only — never a raw provider URL, credential, or stack trace. */
  readonly lastError: string | null;
  readonly lastErrorAt: string | null;
  readonly unresolvedReorg: boolean;
}

export interface IngestionHealth {
  readonly status: IngestionHealthStatus;
  readonly discovery: SourceHealthDetail;
  readonly trades: SourceHealthDetail;
  /**
   * Phase 7D.5 — every ingestion stream, not just the two V1 ones this projection was
   * written around in 7B.5A. The product runs on `pons_v2`, so a status built only from
   * `pons` streams described something nobody was using.
   */
  readonly streams: readonly SourceHealthDetail[];
  /** The live observation session, or null in `resume` mode. */
  readonly session: {
    readonly mode: string;
    readonly id: string | null;
    readonly startBlock: string | null;
    readonly startTimestamp: string | null;
  };
  readonly observedAt: string;
}

const STATUS_SEVERITY: Record<IngestionHealthStatus, number> = {
  LIVE: 0,
  LAGGING: 1,
  DEGRADED: 2,
  REORG_RECOVERY: 3,
  UNAVAILABLE: 4,
};

function worstOf(a: IngestionHealthStatus, b: IngestionHealthStatus): IngestionHealthStatus {
  return STATUS_SEVERITY[a] >= STATUS_SEVERITY[b] ? a : b;
}

function classifySource(state: CheckpointHealthState | null, now: Date, config: Pick<RobinhoodChainConfig, "healthLaggingBlocks" | "healthStaleMs" | "healthErrorWindowMs">): IngestionHealthStatus {
  if (!state) return "UNAVAILABLE"; // never had a single successful tick

  if (state.reorgUnresolvedAt !== null) return "REORG_RECOVERY";

  const msSincePoll = state.lastPollAt ? now.getTime() - state.lastPollAt.getTime() : Number.POSITIVE_INFINITY;
  if (msSincePoll > config.healthStaleMs) return "UNAVAILABLE"; // the loop itself appears to have stopped ticking

  const msSinceSuccess = state.lastSuccessAt ? now.getTime() - state.lastSuccessAt.getTime() : Number.POSITIVE_INFINITY;
  if (msSinceSuccess > config.healthStaleMs) return "UNAVAILABLE";

  const hasRecentError = state.lastErrorAt !== null && now.getTime() - state.lastErrorAt.getTime() <= config.healthErrorWindowMs;
  const errorIsNewerThanSuccess = state.lastErrorAt !== null && (state.lastSuccessAt === null || state.lastErrorAt.getTime() > state.lastSuccessAt.getTime());
  if (hasRecentError && errorIsNewerThanSuccess) return "DEGRADED";

  if (state.lastObservedChainHeight !== null) {
    const blocksBehind = state.lastObservedChainHeight - state.lastHeight;
    if (blocksBehind > BigInt(config.healthLaggingBlocks)) return "LAGGING";
  }

  return "LIVE";
}

function toDetail(source: string, state: CheckpointHealthState | null, now: Date, status: IngestionHealthStatus): SourceHealthDetail {
  const blocksBehind = state && state.lastObservedChainHeight !== null ? (state.lastObservedChainHeight - state.lastHeight).toString() : null;
  const secondsSinceLastSuccess = state?.lastSuccessAt ? Math.floor((now.getTime() - state.lastSuccessAt.getTime()) / 1000) : null;
  return {
    source,
    status,
    lastHeight: state ? state.lastHeight.toString() : null,
    lastObservedChainHeight: state?.lastObservedChainHeight?.toString() ?? null,
    blocksBehind,
    lastPollAt: state?.lastPollAt?.toISOString() ?? null,
    lastSuccessAt: state?.lastSuccessAt?.toISOString() ?? null,
    secondsSinceLastSuccess,
    lastError: state?.lastError ?? null,
    lastErrorAt: state?.lastErrorAt?.toISOString() ?? null,
    unresolvedReorg: state?.reorgUnresolvedAt !== null && state?.reorgUnresolvedAt !== undefined,
  };
}

/** Every stream this deployment can run, in the order an operator reads them. */
const ALL_SOURCES = [
  DISCOVERY_CHECKPOINT_SOURCE,
  TRADE_CHECKPOINT_SOURCE,
  DISCOVERY_V2_CHECKPOINT_SOURCE,
  TRADE_V2_CHECKPOINT_SOURCE,
  CURVE_TRADE_CHECKPOINT_SOURCE,
] as const;

export async function computeIngestionHealth(db: PrismaClient, config: Pick<RobinhoodChainConfig, "healthLaggingBlocks" | "healthStaleMs" | "healthErrorWindowMs">, now: Date = new Date()): Promise<IngestionHealth> {
  // Phase 7D.5 — report against the live session, not an abandoned durable checkpoint. In
  // live-head mode the durable V2 rows sat 1.3M blocks behind while the session ran at the
  // tip; reading them would have called a healthy stack badly degraded.
  const mode = loadIngestionMode();
  const session = mode === "live-head" ? await findActiveSession(db, ROBINHOOD_CHAIN) : null;
  const store = new CheckpointStore(db, session ? `session:${session.id}:` : "");

  const states = await Promise.all(ALL_SOURCES.map((source) => store.getHealthState(source)));
  const streams = ALL_SOURCES.map((source, i) => toDetail(source, states[i], now, classifySource(states[i], now, config)));

  /**
   * Overall status covers the streams that have actually committed something under the
   * current mode. A stream that never started is not evidence of ill health — the V1 trade
   * listener legitimately idles when no `venue = "pons"` token exists, and letting that
   * report UNAVAILABLE made a fully live stack look down. If nothing has run at all, the
   * old pessimistic answer is still the right one.
   */
  const started = streams.filter((s, i) => states[i] !== null);
  const status = started.length > 0 ? started.map((s) => s.status).reduce(worstOf) : "UNAVAILABLE";

  const byName = (source: string) => streams[ALL_SOURCES.indexOf(source as (typeof ALL_SOURCES)[number])];
  return {
    status,
    // Kept for compatibility with clients written against 7B.5A.
    discovery: byName(DISCOVERY_CHECKPOINT_SOURCE),
    trades: byName(TRADE_CHECKPOINT_SOURCE),
    streams,
    session: {
      mode,
      id: session?.id ?? null,
      startBlock: session ? session.startBlock.toString() : null,
      startTimestamp: session ? session.startTimestamp.toISOString() : null,
    },
    observedAt: now.toISOString(),
  };
}
