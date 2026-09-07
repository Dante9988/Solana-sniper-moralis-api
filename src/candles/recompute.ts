/**
 * Phase 7B.5B §9/§11 — the ONE recompute engine. Both ordinary forward
 * aggregation progress and reorg-driven invalidation call this exact same
 * function: "fully recompute every affected bucket from `ChainTrade WHERE
 * canonicalStatus = CANONICAL`" is a single invariant, not two different
 * code paths with two different correctness arguments (phase7b5b.txt §9:
 * "Do NOT attempt fragile arithmetic such as 'subtract the orphaned trade
 * from the old candle.' ... When canonical state changes, fully recompute
 * every affected bucket").
 *
 * Sharing this function also gives §11 (historical backfill/rebuild) and
 * restart-idempotency for free: a token with no CandleAggregationCheckpoint
 * yet is just "recompute from the beginning," bounded/paginated across
 * ticks exactly like any other recompute window.
 *
 * Bounded (phase7b5b.txt §8/§17): the window is aligned down to the
 * coarsest resolution's bucket boundary so every finer bucket inside it is
 * cleanly covered, trades are read in a bounded page (never an unbounded
 * in-memory history), and a truncated page is reported rather than silently
 * dropping trades — the caller decides whether to continue in a later tick.
 */

import type { PrismaClient } from "@prisma/client";
import type { ChainReader } from "../pons/chainClient";
import { loadCandleTradeInputs } from "../pons/candleFeed";
import type { QuoteUsdRateProvider } from "./usdPricing";
import { aggregateTrades } from "./aggregate";
import { deleteCandlesFrom, persistCandleBuckets, PersistedCandleChange } from "./persistCandles";
import { COARSEST_RESOLUTION_SECONDS, CANDLE_RESOLUTIONS } from "./resolutions";
import type { FinalityInputs } from "./finality";

export interface RecomputeParams {
  readonly db: PrismaClient;
  readonly chainClient: ChainReader;
  readonly chain: string;
  readonly venue: string;
  readonly tokenAddress: string;
  readonly quoteAddress: string;
  readonly fromTimestamp: Date;
  readonly usdRateProvider: QuoteUsdRateProvider;
  readonly finality: FinalityInputs;
  /** Bounded trade-page cap for this recompute call (phase7b5b.txt §17). */
  readonly cap: number;
}

export type RecomputeResult =
  | {
      status: "OK";
      bucketsRecomputed: number;
      tradesProcessed: number;
      truncated: boolean;
      changes: PersistedCandleChange[];
      /** The (sourceHeight, sourceIndex) of the last trade actually processed, if any — the caller advances CandleAggregationCheckpoint to this on the ordinary forward path. */
      lastProcessed: { sourceHeight: bigint; sourceIndex: number } | null;
    }
  | { status: "DECIMALS_UNAVAILABLE"; reason: string };

function alignToCoarsestBucket(date: Date): number {
  const seconds = Math.floor(date.getTime() / 1000);
  return Math.floor(seconds / COARSEST_RESOLUTION_SECONDS) * COARSEST_RESOLUTION_SECONDS;
}

export async function recomputeCandlesFromTimestamp(params: RecomputeParams): Promise<RecomputeResult> {
  const alignedStartSeconds = alignToCoarsestBucket(params.fromTimestamp);
  const alignedStart = new Date(alignedStartSeconds * 1000);

  const feed = await loadCandleTradeInputs({
    db: params.db,
    chainClient: params.chainClient,
    chain: params.chain,
    tokenAddress: params.tokenAddress,
    quoteAddress: params.quoteAddress,
    fromTimestamp: alignedStart,
    cap: params.cap,
    usdRateProvider: params.usdRateProvider,
  });

  if (feed.status === "DECIMALS_UNAVAILABLE") {
    return { status: "DECIMALS_UNAVAILABLE", reason: feed.reason };
  }

  // Clean slate for the whole aligned window, then reinsert only buckets
  // still supported by canonical trades — a bucket that lost every trade
  // to orphaning is genuinely removed (§5's "no-trade interval = no
  // candle" invariant applies to recompute too), never left stale.
  await deleteCandlesFrom(params.db, params.chain, params.tokenAddress, alignedStartSeconds);

  if (feed.trades.length === 0) {
    return { status: "OK", bucketsRecomputed: 0, tradesProcessed: 0, truncated: feed.truncated, changes: [], lastProcessed: null };
  }

  const buckets = aggregateTrades(feed.trades, CANDLE_RESOLUTIONS);
  const persistResult = await persistCandleBuckets({
    db: params.db,
    chain: params.chain,
    venue: params.venue,
    tokenAddress: params.tokenAddress,
    quoteAddress: params.quoteAddress,
    buckets,
    finality: params.finality,
  });

  const last = feed.trades[feed.trades.length - 1];
  const totalBuckets = [...buckets.values()].reduce((sum, arr) => sum + arr.length, 0);

  return {
    status: "OK",
    bucketsRecomputed: totalBuckets,
    tradesProcessed: feed.trades.length,
    truncated: feed.truncated,
    changes: persistResult.changes,
    lastProcessed: { sourceHeight: last.sourceHeight, sourceIndex: last.sourceIndex },
  };
}
