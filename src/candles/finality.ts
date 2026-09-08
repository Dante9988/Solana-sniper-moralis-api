/**
 * Phase 7B.5B §10 — the provisional/final invariant, defined precisely and
 * tested in isolation from persistence/aggregation.
 *
 * A bucket is FINAL only when the backend has *chain-ingestion* evidence
 * that trade ingestion has safely progressed beyond the bucket's end — never
 * merely "wall clock moved past bucket end" (a paused/degraded/stalled
 * worker or trade listener must never let old buckets silently "become
 * final" just because time passed). The evidence used here is the Pons
 * trade checkpoint's own confirmed source-chain time
 * (`ChainIngestionCheckpoint.lastHeightTimestamp`, set only by
 * tradeListener.ts — see checkpointStore.ts) — the trade listener only ever
 * advances that checkpoint after committing a real, confirmed
 * (`PONS_CONFIRMATION_LAG_BLOCKS`-lagged) block range, so its timestamp is
 * itself already a safe/confirmed chain-progress signal, not the live tip.
 *
 * An unresolved reorg (`reorgUnresolvedAt` set on either the discovery or
 * trade checkpoint) must never produce a newly FINAL candle — checked here
 * as an explicit, independent condition, not inferred from a stale
 * timestamp.
 */

import type { CandleResolutionId } from "./resolutions";
import { RESOLUTION_SECONDS } from "./resolutions";

export type CandleStatusId = "provisional" | "final";

export interface FinalityInputs {
  /** ChainIngestionCheckpoint.lastHeightTimestamp for robinhood:pons:trades — null if the trade listener has never yet committed a tick (nothing to prove progress with). */
  readonly tradeLastHeightTimestamp: Date | null;
  /** True if either the discovery or trade checkpoint currently has an unresolved reorg (reorgUnresolvedAt set). */
  readonly unresolvedReorg: boolean;
}

/**
 * `bucketStart` is Unix seconds (resolutions.ts's bucketStartFor output).
 * FINAL requires: no unresolved reorg, a known trade-checkpoint confirmed
 * time, and that confirmed time strictly at or past the bucket's own end
 * (bucketStart + resolution width) — i.e. ingestion has confirmed-progressed
 * to a point where no more trades can still arrive for this bucket.
 */
export function determineCandleStatus(bucketStart: number, resolution: CandleResolutionId, inputs: FinalityInputs): CandleStatusId {
  if (inputs.unresolvedReorg) return "provisional";
  if (inputs.tradeLastHeightTimestamp === null) return "provisional";

  const bucketEnd = bucketStart + RESOLUTION_SECONDS[resolution];
  const confirmedSeconds = Math.floor(inputs.tradeLastHeightTimestamp.getTime() / 1000);
  return confirmedSeconds >= bucketEnd ? "final" : "provisional";
}
