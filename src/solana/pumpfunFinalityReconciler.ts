/**
 * Phase 7E.4.3 §8 — the finality half of the Solana model.
 *
 * Observation runs at `confirmed`, because that is where fast discovery lives: measured on
 * mainnet 2026-09-26, the confirmed head ran ~32 slots ahead of finalized, and `getBlock` at
 * `finalized` only answered from about 40 slots back. Waiting for finality before showing a new
 * token would put the product half a minute behind the chain.
 *
 * So rows arrive provisional and this reconciler settles them. It does exactly two things, both
 * behind the finalized head:
 *
 *   1. Promotes `PumpLifecycleEvent.status` provisional -> final once the containing slot is
 *      finalized AND the signature still resolves at `finalized` commitment. This is the gate
 *      §8/§13 require before anything irreversible — a migration announcement, a social post —
 *      may act on a lifecycle transition.
 *   2. Marks a transition, and every canonical fact from that transaction, ORPHANED if the
 *      signature is gone at finalized commitment.
 *
 * It also owns `ChainIngestionCheckpoint.lastHeightTimestamp` for this stream, for a specific
 * reason: that field is what src/candles/finality.ts reads to decide whether a candle bucket may
 * become FINAL. Advancing it from confirmed data would let a bucket finalize from trades that can
 * still change, so it is advanced only to a slot this reconciler has seen finalized.
 *
 * What it does NOT do: call X, post anything, or compute a valuation. §13 is explicit that the
 * ingestion worker must never call X; this file only makes the stored facts trustworthy enough
 * for something else to.
 */

import type { PrismaClient } from "@prisma/client";

import { CheckpointStore } from "../pons/checkpointStore";
import { PUMPFUN_CHECKPOINT_SOURCE } from "./pumpfunIngestionEngine";
import type { SolanaIngestionMetrics } from "./pumpfunMetrics";
import type { SolanaRpc } from "./rpc";

export interface ReconcileFinalityResult {
  readonly finalizedSlot: number | null;
  readonly examined: number;
  readonly promoted: number;
  readonly orphaned: number;
  readonly stillProvisional: number;
  readonly checkpointTimestampAdvancedTo: string | null;
  readonly errors: readonly string[];
}

export interface ReconcileFinalityParams {
  readonly db: PrismaClient;
  readonly rpc: SolanaRpc;
  readonly metrics?: SolanaIngestionMetrics;
  /** Cap per tick, so one sweep cannot monopolise the RPC budget. */
  readonly maxEvents?: number;
}

export async function reconcilePumpfunFinality(params: ReconcileFinalityParams): Promise<ReconcileFinalityResult> {
  const { db, rpc, metrics } = params;
  const maxEvents = params.maxEvents ?? 200;
  const errors: string[] = [];

  const finalizedHead = await rpc.getSlot("finalized");
  if (finalizedHead.status !== "OK") {
    return { finalizedSlot: null, examined: 0, promoted: 0, orphaned: 0, stillProvisional: 0, checkpointTimestampAdvancedTo: null, errors: [`finalized head unavailable: ${finalizedHead.reason}`] };
  }
  const finalizedSlot = finalizedHead.data;
  metrics?.observeHead({ finalized: finalizedSlot });

  const pending = await db.pumpLifecycleEvent.findMany({
    where: { status: "provisional", slot: { lte: BigInt(finalizedSlot) } },
    orderBy: { slot: "asc" },
    take: maxEvents,
  });

  let promoted = 0;
  let orphaned = 0;
  let stillProvisional = 0;
  /** The highest finalized slot we actually confirmed, and its chain time. */
  let settledSlot: bigint | null = null;
  let settledBlockTime: Date | null = null;

  // One RPC call per distinct signature, not per event: a create and its dev buy share a signature.
  const verdicts = new Map<string, "present" | "absent">();

  for (const event of pending) {
    let verdict = verdicts.get(event.signature);
    if (!verdict) {
      const fetched = await rpc.getTransaction(event.signature, "finalized");
      if (fetched.status === "UNSUPPORTED_TX_VERSION") {
        // Do not guess. A version we cannot parse is not evidence the transaction is gone.
        metrics?.increment("unsupportedTxVersion");
        errors.push(fetched.reason);
        stillProvisional += 1;
        continue;
      }
      if (fetched.status === "FAILED") {
        // An RPC failure is not evidence of absence either. Leave it provisional and retry later.
        errors.push(fetched.reason);
        stillProvisional += 1;
        continue;
      }
      verdict = fetched.data ? "present" : "absent";
      verdicts.set(event.signature, verdict);
    }

    if (verdict === "present") {
      await db.pumpLifecycleEvent.update({ where: { id: event.id }, data: { status: "final" } });
      promoted += 1;
      if (settledSlot === null || event.slot > settledSlot) {
        settledSlot = event.slot;
        settledBlockTime = event.blockTime;
      }
      continue;
    }

    // Gone at finalized commitment. Rows are marked, never deleted, so orphaned history stays
    // auditable — the same convention reorgRecovery.ts uses for Robinhood.
    await db.$transaction(async (tx) => {
      await tx.pumpLifecycleEvent.update({ where: { id: event.id }, data: { status: "orphaned" } });
      await tx.chainTrade.updateMany({
        where: { chain: "solana", sourceTxHash: event.signature, canonicalStatus: "CANONICAL" },
        data: { canonicalStatus: "ORPHANED", orphanedAt: new Date() },
      });
      await tx.discoveredToken.updateMany({
        where: { chain: "solana", sourceTxHash: event.signature, canonicalStatus: "CANONICAL" },
        data: { canonicalStatus: "ORPHANED", orphanedAt: new Date() },
      });
    });
    orphaned += 1;
  }

  // Advance the candle-finality clock only to a slot we just saw finalized, and only forwards.
  let checkpointTimestampAdvancedTo: string | null = null;
  if (settledSlot !== null && settledBlockTime !== null) {
    const store = new CheckpointStore(db);
    const existing = await db.chainIngestionCheckpoint.findUnique({ where: { source: PUMPFUN_CHECKPOINT_SOURCE } });
    if (existing && (existing.lastHeightTimestamp === null || existing.lastHeightTimestamp < settledBlockTime)) {
      await store.set(
        PUMPFUN_CHECKPOINT_SOURCE,
        { lastHeight: existing.lastHeight, lastHash: existing.lastHash },
        BigInt(finalizedSlot),
        settledBlockTime
      );
      checkpointTimestampAdvancedTo = settledBlockTime.toISOString();
    }
  }

  return { finalizedSlot, examined: pending.length, promoted, orphaned, stillProvisional, checkpointTimestampAdvancedTo, errors };
}
