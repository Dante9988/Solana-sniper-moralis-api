/**
 * Phase 7B.4 §4.5 — checkpoint persistence. Nothing in this repo implemented
 * this before Phase 7B.4 (confirmed by grep during Step 0). The database is
 * the source of truth: a restart reads the last committed checkpoint and
 * resumes from there rather than re-scanning from genesis or silently
 * skipping the gap.
 *
 * Phase 7B.5A extends this with:
 *  - the persisted poll/error/reorg metadata the source-health projection
 *    (sourceHealth.ts) reads (§5) — never inferred from a live RPC call per
 *    API request;
 *  - a bounded per-chain (height, hash) history (`ChainBlockCheckpoint`),
 *    independent of either listener's single-point checkpoint, that reorg
 *    recovery (reorgRecovery.ts) walks to find a common canonical ancestor
 *    (§2).
 */

import type { Prisma, PrismaClient } from "@prisma/client";

export interface Checkpoint {
  readonly lastHeight: bigint;
  readonly lastHash: string;
}

/** Phase 7B.5B §10 — the trade checkpoint's own confirmed source-chain time (never wall clock), read by src/candles/finality.ts to decide whether a bucket can become FINAL. */
export interface CheckpointFinalityState {
  readonly lastHeight: bigint;
  readonly lastHeightTimestamp: Date | null;
  readonly reorgUnresolvedAt: Date | null;
}

export interface CheckpointHealthState {
  readonly lastHeight: bigint;
  readonly lastHash: string;
  readonly updatedAt: Date;
  readonly lastObservedChainHeight: bigint | null;
  readonly lastPollAt: Date | null;
  readonly lastSuccessAt: Date | null;
  readonly lastError: string | null;
  readonly lastErrorAt: Date | null;
  readonly lastReorgAt: Date | null;
  readonly reorgUnresolvedAt: Date | null;
  readonly reorgUnresolvedReason: string | null;
}

type DbClient = PrismaClient | Prisma.TransactionClient;

export class CheckpointStore {
  constructor(private readonly db: DbClient) {}

  async get(source: string): Promise<Checkpoint | null> {
    const row = await this.db.chainIngestionCheckpoint.findUnique({ where: { source } });
    if (!row) return null;
    return { lastHeight: row.lastHeight, lastHash: row.lastHash };
  }

  async getHealthState(source: string): Promise<CheckpointHealthState | null> {
    const row = await this.db.chainIngestionCheckpoint.findUnique({ where: { source } });
    if (!row) return null;
    return {
      lastHeight: row.lastHeight,
      lastHash: row.lastHash,
      updatedAt: row.updatedAt,
      lastObservedChainHeight: row.lastObservedChainHeight,
      lastPollAt: row.lastPollAt,
      lastSuccessAt: row.lastSuccessAt,
      lastError: row.lastError,
      lastErrorAt: row.lastErrorAt,
      lastReorgAt: row.lastReorgAt,
      reorgUnresolvedAt: row.reorgUnresolvedAt,
      reorgUnresolvedReason: row.reorgUnresolvedReason,
    };
  }

  /**
   * Upsert within whatever transaction this store was constructed with —
   * callers that need atomicity with other writes should construct a
   * CheckpointStore from a `tx` client inside `prisma.$transaction`. Also
   * records a successful poll (§5 health metadata).
   *
   * `lastHeightTimestamp` (Phase 7B.5B §10) is the real source-chain time of
   * `checkpoint.lastHeight` — set only by the trade listener (see
   * ChainIngestionCheckpoint.lastHeightTimestamp's schema comment: "the
   * trade source only; discovery never sets this"), since it is the trade
   * checkpoint's confirmed progress that gates a candle bucket becoming
   * FINAL (src/candles/finality.ts), never discovery's.
   */
  async set(source: string, checkpoint: Checkpoint, observedChainHeight?: bigint, lastHeightTimestamp?: Date): Promise<void> {
    const now = new Date();
    await this.db.chainIngestionCheckpoint.upsert({
      where: { source },
      create: {
        source,
        lastHeight: checkpoint.lastHeight,
        lastHash: checkpoint.lastHash,
        lastObservedChainHeight: observedChainHeight ?? null,
        lastHeightTimestamp: lastHeightTimestamp ?? null,
        lastPollAt: now,
        lastSuccessAt: now,
      },
      update: {
        lastHeight: checkpoint.lastHeight,
        lastHash: checkpoint.lastHash,
        lastObservedChainHeight: observedChainHeight ?? undefined,
        lastHeightTimestamp: lastHeightTimestamp ?? undefined,
        lastPollAt: now,
        lastSuccessAt: now,
        lastError: null,
        lastErrorAt: null,
      },
    });
  }

  /** Phase 7B.5B §10 — read just what candle finality needs from a source's checkpoint, without pulling in the full health-state shape. */
  async getFinalityState(source: string): Promise<CheckpointFinalityState | null> {
    const row = await this.db.chainIngestionCheckpoint.findUnique({ where: { source } });
    if (!row) return null;
    return { lastHeight: row.lastHeight, lastHeightTimestamp: row.lastHeightTimestamp, reorgUnresolvedAt: row.reorgUnresolvedAt };
  }

  /**
   * Records a poll attempt that did not advance the checkpoint (e.g. the
   * tick found nothing new). No-op if the source has never had a
   * successful checkpoint yet — recording poll metadata against a source
   * with no `lastHeight`/`lastHash` would require fabricating a fake
   * checkpoint row, which risks a later `get()` misreading it as real
   * ingestion progress. A never-yet-successful source correctly reports
   * UNAVAILABLE from the health projection regardless.
   */
  async recordUpToDate(source: string, observedChainHeight?: bigint): Promise<void> {
    await this.db.chainIngestionCheckpoint
      .update({
        where: { source },
        data: { lastPollAt: new Date(), lastObservedChainHeight: observedChainHeight ?? undefined, lastError: null, lastErrorAt: null },
      })
      .catch((err: unknown) => {
        if (isRecordNotFoundError(err)) return;
        throw err;
      });
  }

  /** Same no-op-if-never-succeeded rule as recordUpToDate — see its comment. */
  async recordFailure(source: string, reason: string): Promise<void> {
    const now = new Date();
    await this.db.chainIngestionCheckpoint
      .update({ where: { source }, data: { lastPollAt: now, lastError: reason, lastErrorAt: now } })
      .catch((err: unknown) => {
        if (isRecordNotFoundError(err)) return;
        throw err;
      });
  }

  /** Marks (preserving the original detection time if already marked) that this source is halted on an unresolved reorg. */
  async markReorgUnresolved(source: string, reason: string): Promise<void> {
    const now = new Date();
    const existing = await this.db.chainIngestionCheckpoint.findUnique({ where: { source }, select: { reorgUnresolvedAt: true } });
    if (!existing) return; // see recordUpToDate's comment — no row to update against
    await this.db.chainIngestionCheckpoint.update({
      where: { source },
      data: {
        reorgUnresolvedAt: existing.reorgUnresolvedAt ?? now,
        reorgUnresolvedReason: reason,
        lastError: reason,
        lastErrorAt: now,
        lastPollAt: now,
      },
    });
  }
}

function isRecordNotFoundError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "P2025";
}

/**
 * Phase 7B.5A §2 — appends this tick's committed (height, hash) to the
 * chain-level history reorg recovery searches, and prunes entries older
 * than the configured recovery window so the table never grows unbounded.
 * Call from inside the same transaction as the checkpoint commit so history
 * and checkpoint never disagree about what was "just committed."
 */
export async function recordChainBlockCheckpoint(db: DbClient, chain: string, height: bigint, hash: string, maxDepthBlocks: number): Promise<void> {
  await db.chainBlockCheckpoint.upsert({
    where: { chain_height: { chain, height } },
    create: { chain, height, hash },
    update: { hash },
  });
  const cutoff = height - BigInt(maxDepthBlocks);
  if (cutoff > 0n) {
    await db.chainBlockCheckpoint.deleteMany({ where: { chain, height: { lt: cutoff } } });
  }
}
