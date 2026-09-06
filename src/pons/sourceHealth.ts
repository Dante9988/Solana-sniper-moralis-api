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
import { CheckpointStore, CheckpointHealthState } from "./checkpointStore";
import { DISCOVERY_CHECKPOINT_SOURCE } from "./discoveryListener";
import { TRADE_CHECKPOINT_SOURCE } from "./tradeListener";
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

export async function computeIngestionHealth(db: PrismaClient, config: Pick<RobinhoodChainConfig, "healthLaggingBlocks" | "healthStaleMs" | "healthErrorWindowMs">, now: Date = new Date()): Promise<IngestionHealth> {
  const store = new CheckpointStore(db);
  const [discoveryState, tradeState] = await Promise.all([store.getHealthState(DISCOVERY_CHECKPOINT_SOURCE), store.getHealthState(TRADE_CHECKPOINT_SOURCE)]);

  const discoveryStatus = classifySource(discoveryState, now, config);
  const tradeStatus = classifySource(tradeState, now, config);

  return {
    status: worstOf(discoveryStatus, tradeStatus),
    discovery: toDetail(DISCOVERY_CHECKPOINT_SOURCE, discoveryState, now, discoveryStatus),
    trades: toDetail(TRADE_CHECKPOINT_SOURCE, tradeState, now, tradeStatus),
    observedAt: now.toISOString(),
  };
}
