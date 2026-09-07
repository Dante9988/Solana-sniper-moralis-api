/**
 * Phase 7B.5B §1 — `npm run pons:backfill-timestamps`.
 *
 * `ChainTrade.sourceTimestamp` is additive/nullable specifically so this
 * script can exist: a row persisted by a pre-7B.5B trade listener (or one
 * whose per-tick timestamp resolution failed and was skipped — see
 * tradeListener.ts) has `sourceTimestamp: null` and is invisible to the
 * candle feed (src/pons/candleFeed.ts only reads rows where it's set) until
 * a controlled backfill resolves it from the row's own `sourceHeight`.
 *
 * Never fabricates a timestamp for a row it can't resolve (a failed
 * getBlockRef leaves that row unresolved for the next run) — bounded batch,
 * idempotent/resumable (re-running only ever touches remaining
 * `sourceTimestamp: null` rows), independently runnable from `pons:worker`.
 */

import { PrismaClient } from "@prisma/client";
import { loadRobinhoodChainConfig } from "../config";
import { PonsChainClient } from "../chainClient";
import { ROBINHOOD_CHAIN } from "../discoveryListener";
import { ponsLogger } from "../logger";

const BATCH_SIZE = 500;

export async function backfillTradeTimestamps(db: PrismaClient, chainClient: PonsChainClient, chain: string = ROBINHOOD_CHAIN): Promise<{ resolved: number; failed: number }> {
  let resolved = 0;
  let failed = 0;

  for (;;) {
    const rows = await db.chainTrade.findMany({
      where: { chain, sourceTimestamp: null },
      select: { id: true, sourceHeight: true },
      orderBy: { sourceHeight: "asc" },
      take: BATCH_SIZE,
    });
    if (rows.length === 0) break;

    const uniqueHeights = [...new Set(rows.map((r) => r.sourceHeight.toString()))];
    const heightTimestamps = new Map<string, Date>();
    for (const heightStr of uniqueHeights) {
      const ref = await chainClient.getBlockRef(BigInt(heightStr));
      if (ref.status === "UNAVAILABLE") {
        ponsLogger.warn({ height: heightStr, reason: ref.reason }, "[backfillTradeTimestamps] could not resolve block timestamp, leaving row(s) unresolved for a later run");
        continue;
      }
      heightTimestamps.set(heightStr, new Date(Number(ref.data.timestamp) * 1000));
    }

    let progressedThisBatch = 0;
    for (const row of rows) {
      const ts = heightTimestamps.get(row.sourceHeight.toString());
      if (!ts) {
        failed += 1;
        continue;
      }
      await db.chainTrade.update({ where: { id: row.id }, data: { sourceTimestamp: ts } });
      resolved += 1;
      progressedThisBatch += 1;
    }

    // Every row in this batch failed to resolve — stop rather than loop
    // forever re-reading the same unresolved rows.
    if (progressedThisBatch === 0) break;
  }

  return { resolved, failed };
}

async function main(): Promise<void> {
  const config = loadRobinhoodChainConfig();
  const chainClient = new PonsChainClient({ config });
  const db = new PrismaClient();
  try {
    const result = await backfillTradeTimestamps(db, chainClient);
    ponsLogger.info(result, "[backfillTradeTimestamps] complete");
  } finally {
    await db.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    ponsLogger.error({ err: err instanceof Error ? err.message : String(err) }, "[backfillTradeTimestamps] FATAL");
    process.exit(1);
  });
}
