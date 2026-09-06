/**
 * Phase 7B.4 §4.5 — checkpoint persistence. Nothing in this repo implemented
 * this before Phase 7B.4 (confirmed by grep during Step 0). The database is
 * the source of truth: a restart reads the last committed checkpoint and
 * resumes from there rather than re-scanning from genesis or silently
 * skipping the gap.
 */

import type { Prisma, PrismaClient } from "@prisma/client";

export interface Checkpoint {
  readonly lastHeight: bigint;
  readonly lastHash: string;
}

type DbClient = PrismaClient | Prisma.TransactionClient;

export class CheckpointStore {
  constructor(private readonly db: DbClient) {}

  async get(source: string): Promise<Checkpoint | null> {
    const row = await this.db.chainIngestionCheckpoint.findUnique({ where: { source } });
    if (!row) return null;
    return { lastHeight: row.lastHeight, lastHash: row.lastHash };
  }

  /** Upsert within whatever transaction this store was constructed with — callers that need atomicity with other writes should construct a CheckpointStore from a `tx` client inside `prisma.$transaction`. */
  async set(source: string, checkpoint: Checkpoint): Promise<void> {
    await this.db.chainIngestionCheckpoint.upsert({
      where: { source },
      create: { source, lastHeight: checkpoint.lastHeight, lastHash: checkpoint.lastHash },
      update: { lastHeight: checkpoint.lastHeight, lastHash: checkpoint.lastHash },
    });
  }
}
