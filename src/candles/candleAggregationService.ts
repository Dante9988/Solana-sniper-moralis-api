/**
 * Phase 7B.5B §7/§8/§9/§11 — orchestrates one candle-worker tick:
 *
 *  1. Process pending CandleInvalidation rows (reorg recompute) — always
 *     first, so forward processing never builds on top of stale buckets a
 *     reorg has already invalidated but the worker hasn't yet recomputed.
 *  2. Forward-process a bounded batch of tokens: a token with no
 *     CandleAggregationCheckpoint yet is a first-time backfill (§11, reusing
 *     the exact same recompute engine — restart-safe, resumable across
 *     ticks); a token with a checkpoint only does work if genuinely new
 *     canonical trades exist since it.
 *
 * Never holds an unbounded in-memory trade history (§8): both paths bound
 * their trade-page size via recompute.ts's `cap`, and both bound how many
 * tokens one tick touches.
 */

import type { PrismaClient } from "@prisma/client";
import { currentSessionPrefix } from "../pons/ingestionSession";
import type { ChainReader } from "../pons/chainClient";
import { CheckpointStore } from "../pons/checkpointStore";
import { DISCOVERY_CHECKPOINT_SOURCE } from "../pons/discoveryListener";
import { TRADE_CHECKPOINT_SOURCE } from "../pons/tradeListener";
import { TRADE_V2_CHECKPOINT_SOURCE } from "../pons/tradeV2Listener";
import { CURVE_TRADE_CHECKPOINT_SOURCE } from "../pons/curveTradeListener";
import { DISCOVERY_V2_CHECKPOINT_SOURCE } from "../pons/discoveryV2Listener";
import { recomputeCandlesFromTimestamp } from "./recompute";
import type { QuoteUsdRateProvider } from "./usdPricing";
import type { FinalityInputs } from "./finality";
import type { PersistedCandleChange } from "./persistCandles";
import { CANDLE_RESOLUTIONS, CandleResolutionId, RESOLUTION_SECONDS, resolutionIdToDb } from "./resolutions";

export interface CandleAggregationServiceDeps {
  readonly db: PrismaClient;
  readonly chainClient: ChainReader;
  readonly chain: string;
  readonly venue: string;
  readonly usdRateProvider: QuoteUsdRateProvider;
  readonly maxInvalidationTokensPerTick: number;
  readonly maxForwardTokensPerTick: number;
  readonly tradePageCap: number;
  readonly logger: { info: (msg: string, fields?: Record<string, unknown>) => void; warn: (msg: string, fields?: Record<string, unknown>) => void; error: (msg: string, fields?: Record<string, unknown>) => void };
  /** Realtime optimization only (§14) — called only for genuine steady-state forward progress, never during bulk backfill/reorg recompute. */
  onCandleUpdated?: (event: { chain: string; tokenAddress: string; quoteAddress: string; resolution: CandleResolutionId; candle: PersistedCandleChange }) => Promise<void>;
  /**
   * Phase 7D.6 — restrict this tick to these token addresses, and skip the invalidation pass.
   *
   * The fleet tick is fair but slow: it takes ~100 tokens at a time and, with first-time
   * backfills in the queue, a pass costs 70–120s. A token someone has open in the terminal must
   * not wait behind that, so the worker runs a second, tiny loop that passes the watched set
   * here (docs/phase-7d6/root-cause.md). Empty array means "nothing watched" — not "no filter".
   */
  readonly restrictToTokens?: readonly string[];
}

export interface CandleAggregationTickSummary {
  readonly tokensProcessed: number;
  readonly candlesWritten: number;
  readonly bucketsRecomputed: number;
  readonly invalidationsProcessed: number;
  readonly durationMs: number;
  readonly errors: string[];
}

/**
 * Trade streams that must all have confirmed progress before a bucket can be final, per venue.
 * Pons V1 has one stream; Pons V2 has two (bonding-curve trades and Uniswap V4 swaps after
 * graduation). A venue with no tokens contributes nothing.
 */
export const TRADE_SOURCES_BY_VENUE: Record<string, readonly string[]> = {
  pons: [TRADE_CHECKPOINT_SOURCE],
  pons_v2: [TRADE_V2_CHECKPOINT_SOURCE, CURVE_TRADE_CHECKPOINT_SOURCE],
};
const DISCOVERY_SOURCES = [DISCOVERY_CHECKPOINT_SOURCE, DISCOVERY_V2_CHECKPOINT_SOURCE];

/**
 * Fails closed: finality is the *least* advanced confirmed time across every required stream, and
 * null (everything provisional) if any required stream has never committed. Previously only the
 * V1 trade checkpoint was consulted, so V2 buckets could be finalized by an unrelated stream.
 */
export async function loadFinality(db: PrismaClient, chain = "robinhood"): Promise<FinalityInputs> {
  // Phase 7D.5 — finality follows the live session's trade streams.
  const store = new CheckpointStore(db, await currentSessionPrefix(db, chain));
  const venuesPresent = (
    await db.discoveredToken.groupBy({ by: ["venue"], where: { chain, canonicalStatus: "CANONICAL" } })
  ).map((r) => r.venue);
  const required = [...new Set(venuesPresent.flatMap((v) => TRADE_SOURCES_BY_VENUE[v] ?? []))];
  const [trades, discoveries] = await Promise.all([
    Promise.all(required.map((source) => store.getFinalityState(source))),
    Promise.all(DISCOVERY_SOURCES.map((source) => store.getFinalityState(source))),
  ]);

  let confirmed: Date | null = required.length > 0 ? new Date(8.64e15) : null;
  for (const state of trades) {
    if (!state?.lastHeightTimestamp) {
      confirmed = null;
      break;
    }
    if (confirmed && state.lastHeightTimestamp < confirmed) confirmed = state.lastHeightTimestamp;
  }
  return {
    tradeLastHeightTimestamp: confirmed,
    unresolvedReorg: [...trades, ...discoveries].some((state) => Boolean(state?.reorgUnresolvedAt)),
  };
}

async function processInvalidations(deps: CandleAggregationServiceDeps, finality: FinalityInputs, errors: string[]): Promise<{ processed: number; bucketsRecomputed: number; candlesWritten: number }> {
  const pending = await deps.db.candleInvalidation.findMany({
    where: { chain: deps.chain, processedAt: null },
    orderBy: { createdAt: "asc" },
    take: deps.maxInvalidationTokensPerTick * 8, // several rows can share one token; cap tokens, not raw rows
  });
  if (pending.length === 0) return { processed: 0, bucketsRecomputed: 0, candlesWritten: 0 };

  const byToken = new Map<string, { minTimestamp: Date; ids: string[] }>();
  for (const row of pending) {
    const existing = byToken.get(row.tokenAddress);
    if (!existing) byToken.set(row.tokenAddress, { minTimestamp: row.invalidatedFromTimestamp, ids: [row.id] });
    else {
      if (row.invalidatedFromTimestamp < existing.minTimestamp) existing.minTimestamp = row.invalidatedFromTimestamp;
      existing.ids.push(row.id);
    }
    if (byToken.size >= deps.maxInvalidationTokensPerTick) break;
  }

  let processed = 0;
  let bucketsRecomputed = 0;
  let candlesWritten = 0;

  for (const [tokenAddress, { minTimestamp, ids }] of byToken) {
    const token = await deps.db.discoveredToken.findUnique({ where: { chain_tokenAddress: { chain: deps.chain, tokenAddress } }, select: { quoteAddress: true, venue: true } });
    if (!token) {
      deps.logger.warn("candle invalidation references an unknown token — leaving unprocessed", { tokenAddress });
      continue;
    }

    const result = await recomputeCandlesFromTimestamp({
      db: deps.db,
      chainClient: deps.chainClient,
      chain: deps.chain,
      venue: token.venue,
      tokenAddress,
      quoteAddress: token.quoteAddress,
      fromTimestamp: minTimestamp,
      usdRateProvider: deps.usdRateProvider,
      finality,
      cap: deps.tradePageCap,
    });

    if (result.status === "DECIMALS_UNAVAILABLE") {
      errors.push(`invalidation recompute for ${tokenAddress}: ${result.reason}`);
      continue; // leave CandleInvalidation rows unprocessed — retried next tick
    }

    if (result.lastProcessed) {
      await deps.db.candleAggregationCheckpoint.upsert({
        where: { chain_tokenAddress: { chain: deps.chain, tokenAddress } },
        create: { chain: deps.chain, tokenAddress, lastSourceHeight: result.lastProcessed.sourceHeight, lastSourceIndex: result.lastProcessed.sourceIndex },
        update: { lastSourceHeight: result.lastProcessed.sourceHeight, lastSourceIndex: result.lastProcessed.sourceIndex },
      });
    } else {
      // Every canonical trade in the recomputed window is gone (fully
      // orphaned, nothing replayed yet) — the old checkpoint may now
      // reference orphaned history. Reset it so the next forward tick
      // re-derives progress from whatever is genuinely canonical, rather
      // than silently trusting a checkpoint a reorg has invalidated.
      await deps.db.candleAggregationCheckpoint.deleteMany({ where: { chain: deps.chain, tokenAddress } });
    }

    if (result.truncated) {
      deps.logger.warn("invalidation recompute window truncated by the bounded trade-page cap — will continue converging on later ticks", { tokenAddress, cap: deps.tradePageCap });
    }

    await deps.db.candleInvalidation.updateMany({ where: { id: { in: ids } }, data: { processedAt: new Date() } });

    processed += 1;
    bucketsRecomputed += result.bucketsRecomputed;
    candlesWritten += result.changes.length;
  }

  return { processed, bucketsRecomputed, candlesWritten };
}

async function processForward(deps: CandleAggregationServiceDeps, finality: FinalityInputs, errors: string[]): Promise<{ tokensProcessed: number; bucketsRecomputed: number; candlesWritten: number }> {
  // Only tokens with canonical trades past their candle checkpoint (or never aggregated). Taking the
  // first N discovered tokens instead, as before, re-checked the same handful forever once there were
  // more tokens than the per-tick budget, so most tokens never got candles.
  // `restrictToTokens: []` means the watched set is empty — there is genuinely nothing to do,
  // which is different from "no restriction". Returning early here keeps the fast loop free.
  if (deps.restrictToTokens?.length === 0) return { tokensProcessed: 0, bucketsRecomputed: 0, candlesWritten: 0 };
  const restricted = deps.restrictToTokens ? deps.restrictToTokens.map((a) => a.toLowerCase()) : null;

  const tokens = await deps.db.$queryRaw<Array<{ tokenAddress: string; quoteAddress: string; venue: string }>>`
    SELECT d."tokenAddress", d."quoteAddress", d.venue
    FROM (
      SELECT DISTINCT ON ("tokenAddress") "tokenAddress", "sourceHeight", "sourceIndex"
      FROM "ChainTrade"
      WHERE chain = ${deps.chain} AND "canonicalStatus" = 'CANONICAL' AND "sourceTimestamp" IS NOT NULL
        AND (${restricted}::text[] IS NULL OR lower("tokenAddress") = ANY(${restricted}::text[]))
      ORDER BY "tokenAddress", "sourceHeight" DESC, "sourceIndex" DESC
    ) latest
    JOIN "DiscoveredToken" d ON d.chain = ${deps.chain} AND lower(d."tokenAddress") = latest."tokenAddress" AND d."canonicalStatus" = 'CANONICAL'
    LEFT JOIN "CandleAggregationCheckpoint" c ON c.chain = ${deps.chain} AND c."tokenAddress" = d."tokenAddress"
    WHERE c."tokenAddress" IS NULL
       OR latest."sourceHeight" > c."lastSourceHeight"
       OR (latest."sourceHeight" = c."lastSourceHeight" AND latest."sourceIndex" > c."lastSourceIndex")
    ORDER BY latest."sourceHeight" DESC
    LIMIT ${deps.maxForwardTokensPerTick}`;

  let tokensProcessed = 0;
  let bucketsRecomputed = 0;
  let candlesWritten = 0;

  for (const token of tokens) {
    const checkpoint = await deps.db.candleAggregationCheckpoint.findUnique({ where: { chain_tokenAddress: { chain: deps.chain, tokenAddress: token.tokenAddress } } });

    let fromTimestamp: Date;
    const isFirstRun = !checkpoint;
    if (checkpoint) {
      const nextTrade = await deps.db.chainTrade.findFirst({
        where: {
          chain: deps.chain,
          tokenAddress: token.tokenAddress,
          canonicalStatus: "CANONICAL",
          sourceTimestamp: { not: null },
          OR: [{ sourceHeight: { gt: checkpoint.lastSourceHeight } }, { sourceHeight: checkpoint.lastSourceHeight, sourceIndex: { gt: checkpoint.lastSourceIndex } }],
        },
        orderBy: [{ sourceHeight: "asc" }, { sourceIndex: "asc" }],
        select: { sourceTimestamp: true },
      });
      if (!nextTrade) continue; // steady state — nothing new for this token
      fromTimestamp = nextTrade.sourceTimestamp as Date;
    } else {
      fromTimestamp = new Date(0); // first-ever run — doubles as historical backfill (§11), bounded/paginated by `cap`
    }

    const result = await recomputeCandlesFromTimestamp({
      db: deps.db,
      chainClient: deps.chainClient,
      chain: deps.chain,
      venue: token.venue,
      tokenAddress: token.tokenAddress,
      quoteAddress: token.quoteAddress,
      fromTimestamp,
      usdRateProvider: deps.usdRateProvider,
      finality,
      cap: deps.tradePageCap,
    });

    if (result.status === "DECIMALS_UNAVAILABLE") {
      errors.push(`forward recompute for ${token.tokenAddress}: ${result.reason}`);
      continue;
    }

    tokensProcessed += 1;
    bucketsRecomputed += result.bucketsRecomputed;
    candlesWritten += result.changes.length;

    if (result.lastProcessed) {
      await deps.db.candleAggregationCheckpoint.upsert({
        where: { chain_tokenAddress: { chain: deps.chain, tokenAddress: token.tokenAddress } },
        create: { chain: deps.chain, tokenAddress: token.tokenAddress, lastSourceHeight: result.lastProcessed.sourceHeight, lastSourceIndex: result.lastProcessed.sourceIndex },
        update: { lastSourceHeight: result.lastProcessed.sourceHeight, lastSourceIndex: result.lastProcessed.sourceIndex },
      });
    }

    if (result.truncated) {
      deps.logger.warn("forward recompute window truncated by the bounded trade-page cap — will continue converging on later ticks", { tokenAddress: token.tokenAddress, cap: deps.tradePageCap });
    }

    // Realtime (§14) — steady-state forward progress only, never a
    // first-time backfill (indistinguishable from bulk history) and never
    // the invalidation path (handled separately, deliberately silent —
    // reorg recompute of historical buckets is not "live" news).
    if (!isFirstRun && deps.onCandleUpdated && result.changes.length > 0) {
      const latestPerResolution = new Map<string, PersistedCandleChange>();
      for (const change of result.changes) {
        const current = latestPerResolution.get(change.resolution);
        if (!current || change.bucketStart > current.bucketStart) latestPerResolution.set(change.resolution, change);
      }
      for (const change of latestPerResolution.values()) {
        await deps.onCandleUpdated({ chain: deps.chain, tokenAddress: token.tokenAddress, quoteAddress: token.quoteAddress, resolution: change.resolution as CandleResolutionId, candle: change });
      }
    }
  }

  return { tokensProcessed, bucketsRecomputed, candlesWritten };
}

/**
 * Provisional -> final is purely a function of (bucketStart, resolution,
 * trade-checkpoint confirmed time, unresolved-reorg) — src/candles/
 * finality.ts — never of whether new trades arrived for a given token. A
 * bucket written PROVISIONAL can therefore only ever become FINAL later if
 * something re-evaluates it once ingestion confirms enough progress, even
 * when that specific token sees no further trades for a while. Forward/
 * invalidation processing above only touches tokens with genuinely new
 * work, so this is a separate, cheap, bounded sweep (one `updateMany` per
 * resolution — never per-row, never per-token) run every tick regardless.
 * Never promotes anything while a reorg is unresolved (finality.ts's own
 * invariant, re-applied here since this path bypasses determineCandleStatus
 * entirely for cost reasons — the condition is identical, just expressed as
 * a bounded SQL predicate instead of a per-row function call).
 */
async function promoteFinalizedCandles(deps: CandleAggregationServiceDeps, finality: FinalityInputs): Promise<number> {
  if (finality.unresolvedReorg || finality.tradeLastHeightTimestamp === null) return 0;
  const confirmedSeconds = Math.floor(finality.tradeLastHeightTimestamp.getTime() / 1000);

  let promoted = 0;
  for (const resolution of CANDLE_RESOLUTIONS) {
    const cutoffSeconds = confirmedSeconds - RESOLUTION_SECONDS[resolution];
    if (cutoffSeconds < 0) continue;
    const result = await deps.db.marketCandle.updateMany({
      where: { chain: deps.chain, resolution: resolutionIdToDb(resolution), status: "PROVISIONAL", bucketStart: { lte: new Date(cutoffSeconds * 1000) } },
      data: { status: "FINAL" },
    });
    promoted += result.count;
  }
  return promoted;
}

export async function runCandleAggregationTick(deps: CandleAggregationServiceDeps): Promise<CandleAggregationTickSummary> {
  const start = Date.now();
  const errors: string[] = [];

  const finality = await loadFinality(deps.db, deps.chain);

  // The watched-token loop does forward progress only. Invalidation recompute and the
  // finalisation sweep are fleet-wide work with fleet-wide cost — running them every few
  // seconds would rebuild the very backlog this loop exists to skip, and neither is "live"
  // news for the token someone is looking at.
  const restricted = deps.restrictToTokens !== undefined;
  const invalidationResult = restricted
    ? { processed: 0, bucketsRecomputed: 0, candlesWritten: 0 }
    : await processInvalidations(deps, finality, errors);
  const forwardResult = await processForward(deps, finality, errors);
  if (!restricted) await promoteFinalizedCandles(deps, finality);

  return {
    tokensProcessed: forwardResult.tokensProcessed,
    candlesWritten: invalidationResult.candlesWritten + forwardResult.candlesWritten,
    bucketsRecomputed: invalidationResult.bucketsRecomputed + forwardResult.bucketsRecomputed,
    invalidationsProcessed: invalidationResult.processed,
    durationMs: Date.now() - start,
    errors,
  };
}
