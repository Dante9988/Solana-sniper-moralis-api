/**
 * Phase 7B.5B §7/§17 — durable materialization of aggregate.ts's output
 * into `MarketCandle`. Identity is `(chain, tokenAddress, resolution,
 * bucketStart)` — stable and idempotent, matching the unique index. Writes
 * are batched (bounded chunk size, one small transaction per chunk) rather
 * than one giant transaction over an unbounded candle set (phase7b5b.txt
 * §17: "Avoid one database transaction containing an arbitrary unbounded
 * history").
 *
 * An unchanged bucket (same OHLC/volumes/tradeCount/uniqueTraders/status as
 * what's already persisted) is skipped entirely — no spurious `revision`
 * bump, no spurious realtime event, and no wasted write. `revision` only
 * increases when a bucket's values genuinely change, which is exactly what
 * lets a realtime consumer (§14) tell a real update from a redundant one.
 */

import type { CandleStatus as DbCandleStatus, Prisma, PrismaClient } from "@prisma/client";
import { resolutionIdToDb, CandleResolutionId } from "./resolutions";
import { determineCandleStatus, FinalityInputs } from "./finality";
import type { CandleBucket } from "./types";

const CHUNK_SIZE = 200;

export interface PersistCandlesParams {
  readonly db: PrismaClient;
  readonly chain: string;
  readonly venue: string;
  readonly tokenAddress: string;
  readonly quoteAddress: string;
  readonly buckets: Map<CandleResolutionId, CandleBucket[]>;
  readonly finality: FinalityInputs;
}

export interface PersistedCandleChange {
  readonly resolution: string;
  readonly bucketStart: number;
  readonly candle: CandleBucket;
  readonly status: DbCandleStatus;
  readonly revision: number;
  readonly isNew: boolean;
}

export interface PersistCandlesResult {
  readonly inserted: number;
  readonly updated: number;
  readonly unchanged: number;
  /** Every bucket whose persisted value actually changed, in the order processed — the caller (candleAggregationService.ts) uses this to decide what (if anything) to publish as a realtime update. */
  readonly changes: PersistedCandleChange[];
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function candleValuesEqual(existing: { open: Prisma.Decimal; high: Prisma.Decimal; low: Prisma.Decimal; close: Prisma.Decimal; volumeToken: Prisma.Decimal; volumeQuote: Prisma.Decimal; volumeUsd: Prisma.Decimal | null; tradeCount: number; uniqueTraders: number; status: DbCandleStatus; firstSourceHeight: bigint; lastSourceHeight: bigint }, bucket: CandleBucket, status: DbCandleStatus): boolean {
  return (
    existing.open.toFixed() === bucket.open &&
    existing.high.toFixed() === bucket.high &&
    existing.low.toFixed() === bucket.low &&
    existing.close.toFixed() === bucket.close &&
    existing.volumeToken.toFixed() === bucket.volumeToken &&
    existing.volumeQuote.toFixed() === bucket.volumeQuote &&
    (existing.volumeUsd === null ? bucket.volumeUsd === null : existing.volumeUsd.toFixed() === bucket.volumeUsd) &&
    existing.tradeCount === bucket.tradeCount &&
    existing.uniqueTraders === bucket.uniqueTraders &&
    existing.status === status &&
    existing.firstSourceHeight === bucket.firstSourceHeight &&
    existing.lastSourceHeight === bucket.lastSourceHeight
  );
}

export async function persistCandleBuckets(params: PersistCandlesParams): Promise<PersistCandlesResult> {
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  const changes: PersistedCandleChange[] = [];

  const flat: Array<{ resolutionId: CandleResolutionId; bucket: CandleBucket }> = [];
  for (const [resolutionId, buckets] of params.buckets) {
    for (const bucket of buckets) flat.push({ resolutionId, bucket });
  }

  for (const group of chunk(flat, CHUNK_SIZE)) {
    await params.db.$transaction(async (tx) => {
      for (const { resolutionId, bucket } of group) {
        const resolutionDb = resolutionIdToDb(bucket.resolution);
        const bucketStartDate = new Date(bucket.bucketStart * 1000);
        const status: DbCandleStatus = determineCandleStatus(bucket.bucketStart, bucket.resolution, params.finality) === "final" ? "FINAL" : "PROVISIONAL";

        const existing = await tx.marketCandle.findUnique({
          where: { chain_tokenAddress_resolution_bucketStart: { chain: params.chain, tokenAddress: params.tokenAddress, resolution: resolutionDb, bucketStart: bucketStartDate } },
        });

        if (existing && candleValuesEqual(existing, bucket, status)) {
          unchanged += 1;
          continue;
        }

        const data = {
          open: bucket.open,
          high: bucket.high,
          low: bucket.low,
          close: bucket.close,
          volumeToken: bucket.volumeToken,
          volumeQuote: bucket.volumeQuote,
          volumeUsd: bucket.volumeUsd,
          tradeCount: bucket.tradeCount,
          uniqueTraders: bucket.uniqueTraders,
          status,
          firstSourceHeight: bucket.firstSourceHeight,
          lastSourceHeight: bucket.lastSourceHeight,
        };

        const revision = (existing?.revision ?? 0) + 1;

        await tx.marketCandle.upsert({
          where: { chain_tokenAddress_resolution_bucketStart: { chain: params.chain, tokenAddress: params.tokenAddress, resolution: resolutionDb, bucketStart: bucketStartDate } },
          create: { chain: params.chain, venue: params.venue, tokenAddress: params.tokenAddress, quoteAddress: params.quoteAddress, resolution: resolutionDb, bucketStart: bucketStartDate, revision: 1, ...data },
          update: { ...data, revision },
        });

        if (existing) updated += 1;
        else inserted += 1;
        changes.push({ resolution: resolutionId, bucketStart: bucket.bucketStart, candle: bucket, status, revision, isNew: !existing });
      }
    });
  }

  return { inserted, updated, unchanged, changes };
}

/**
 * Deletes every MarketCandle row for (chain, tokenAddress) at or after
 * `fromBucketStart` (Unix seconds), across all resolutions — the "clean
 * slate" half of a full recompute (src/candles/recompute.ts), so a bucket
 * that no longer has ANY canonical trade after reorg recovery is genuinely
 * removed rather than left stale ("No-trade interval = no candle" applies
 * to recompute too, not only first-time aggregation).
 */
export async function deleteCandlesFrom(db: PrismaClient, chain: string, tokenAddress: string, fromBucketStart: number): Promise<number> {
  const result = await db.marketCandle.deleteMany({
    where: { chain, tokenAddress, bucketStart: { gte: new Date(fromBucketStart * 1000) } },
  });
  return result.count;
}
