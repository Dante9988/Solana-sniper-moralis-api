/**
 * Phase 7D.5 — on-demand trade history for ONE token.
 *
 * The chain-wide curve-trade listener asks for every `CurveBuy`/`CurveSell` in a block
 * range, across every token. That is a topic-only query with no address filter: an indexer
 * workload, ~10.5 MB per 10,000 blocks, and the thing that spent days crawling.
 *
 * A chart does not need that. It needs one token's logs, which is an address-filtered query
 * the node answers from an index. Measured on the live chain 2026-09-20 against a token
 * launched 5,147,728 blocks earlier:
 *
 *     11 requests, 9,781 trade logs, 7.0 seconds — its entire lifetime.
 *
 * This is how a trading UI shows a full chart without replaying the chain: fetch a token's
 * history when someone opens it, write it once, then follow the head.
 *
 * Deliberately reuses the listener's decoding (`selectCurveTrades`) and its exact write
 * shape, so a backfilled trade is indistinguishable from a live-ingested one — same unique
 * key, same dedup, same provenance columns. Running this while the live listener is running
 * is safe: both upsert on `(chain, sourceTxHash, sourceIndex)`.
 *
 * Covers both venues a Pons token trades on: its bonding curve before graduation, and its
 * Uniswap V4 pool after. Both are index-backed filters — the curve by contract address, the
 * pool by its `poolId` topic — so neither is a scan.
 */

import type { PrismaClient } from "@prisma/client";

import type { ChainReader, EventLogReader } from "../chainClient";
import type { RobinhoodChainConfig } from "../config";
import { getAbiItem } from "viem";

import { PONS_V2_CURVE_ABI, PONS_V2_FACTORY_ABI, UNISWAP_V4_POOL_MANAGER_ABI } from "../abiV2";
import { ponsV2Adapter } from "../ponsV2Adapter";
import { selectCurveTrades } from "../curveTradeListener";
import { classifyWindowFailure } from "../curveTradeListener";
import { ROBINHOOD_CHAIN } from "../discoveryListener";
import { mapWithConcurrency } from "../concurrency";

const VENUE = "pons_v2" as const;

/** Widest window to ask for. The upgraded Alchemy key serves 500k; narrower providers make us halve. */
const DEFAULT_MAX_RANGE = 500_000n;
const MIN_RANGE = 2_000n;

export type BackfillStatus = "COMPLETE" | "PARTIAL" | "FAILED";

export interface BackfillResult {
  readonly status: BackfillStatus;
  readonly tokenAddress: string;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  /** Highest block actually covered. Equals `toBlock` only when status is COMPLETE. */
  readonly cursor: bigint;
  readonly tradesWritten: number;
  readonly logsScanned: number;
  readonly requests: number;
  readonly elapsedMs: number;
  /** Set when a bounded run stopped early, or when it failed. */
  readonly stoppedReason: string | null;
  /** What this backfill can and cannot account for — never implies a complete history. */
  readonly coveredVenues: readonly string[];
  readonly uncoveredVenues: readonly string[];
}

export interface BackfillLogger {
  info(message: string): void;
  warn(message: string): void;
}

const noopLogger: BackfillLogger = { info: () => undefined, warn: () => undefined };

export interface BackfillDeps {
  db: PrismaClient;
  chainClient: ChainReader & EventLogReader;
  config: RobinhoodChainConfig;
  logger?: BackfillLogger;
  /** Stop after this many blocks of progress. Bounds a pathological token, not a normal one. */
  maxBlocks?: bigint;
  /** Stop after this long. A UI request must not hang on a token with a huge history. */
  deadlineMs?: number;
  maxRange?: bigint;
  now?: () => number;
  /**
   * The Pons V2 factory, used to resolve the Uniswap V4 PoolManager for the swap leg.
   * Injected rather than read from the environment inside the backfill, so a test can
   * exercise the V4 path without a configured process env.
   */
  v2FactoryAddress?: string;
}

/**
 * Backfill one token's bonding-curve trades.
 *
 * Idempotent: a completed token returns immediately from stored state, and a partial run
 * resumes from its cursor rather than rescanning. Safe to call from a request handler.
 */
export async function backfillTokenTrades(deps: BackfillDeps, tokenAddress: string): Promise<BackfillResult> {
  const logger = deps.logger ?? noopLogger;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const address = tokenAddress.toLowerCase();

  const token = await deps.db.discoveredToken.findUnique({
    where: { chain_tokenAddress: { chain: ROBINHOOD_CHAIN, tokenAddress: address } },
    select: {
      tokenAddress: true,
      curveAddress: true,
      quoteAddress: true,
      sourceHeight: true,
      graduated: true,
      canonicalStatus: true,
      poolId: true,
      isToken0: true,
      graduationSourceHeight: true,
    },
  });
  if (!token || token.canonicalStatus !== "CANONICAL") {
    return fail(address, "token is not a canonical discovered token", startedAt, now);
  }
  if (!token.curveAddress) {
    return fail(address, "token has no known curve address, so its curve trades cannot be located", startedAt, now);
  }

  const existing = await deps.db.tokenTradeBackfill.findUnique({
    where: { chain_tokenAddress: { chain: ROBINHOOD_CHAIN, tokenAddress: address } },
  });

  const head = await deps.chainClient.getBlockNumber();
  if (head.status === "UNAVAILABLE") return fail(address, `chain head unavailable: ${head.reason}`, startedAt, now);
  // Stay behind the confirmation lag: the live listener owns the unconfirmed tip.
  const target = head.data - BigInt(deps.config.confirmationLagBlocks);

  const fromBlock = existing && existing.status !== "FAILED" ? existing.cursor + 1n : token.sourceHeight;
  if (fromBlock > target) {
    return complete(address, token.sourceHeight, target, target, existing?.tradesWritten ?? 0, existing?.logsScanned ?? 0, 0, startedAt, now, token.graduated);
  }

  await deps.db.tokenTradeBackfill.upsert({
    where: { chain_tokenAddress: { chain: ROBINHOOD_CHAIN, tokenAddress: address } },
    create: { chain: ROBINHOOD_CHAIN, tokenAddress: address, status: "RUNNING", fromBlock: token.sourceHeight, toBlock: target, cursor: fromBlock - 1n },
    update: { status: "RUNNING", toBlock: target, lastError: null, stoppedReason: null },
  });

  const curves = new Map([[token.curveAddress.toLowerCase(), { tokenAddress: address, quoteAddress: token.quoteAddress }]]);
  const maxBlocks = deps.maxBlocks ?? 20_000_000n;
  const deadlineMs = deps.deadlineMs ?? 60_000;
  let range = deps.maxRange ?? DEFAULT_MAX_RANGE;

  let cursor = fromBlock - 1n;
  let tradesWritten = existing?.tradesWritten ?? 0;
  let logsScanned = existing?.logsScanned ?? 0;
  let requests = 0;
  let earliestTimestamp: Date | null = null;
  let stoppedReason: string | null = null;

  while (cursor < target) {
    if (now() - startedAt > deadlineMs) {
      stoppedReason = `stopped after ${deadlineMs}ms; resume to continue from block ${cursor}`;
      break;
    }
    if (cursor - (fromBlock - 1n) >= maxBlocks) {
      stoppedReason = `stopped after ${maxBlocks} blocks; resume to continue from block ${cursor}`;
      break;
    }

    const windowFrom = cursor + 1n;
    const windowTo = windowFrom + range - 1n > target ? target : windowFrom + range - 1n;
    const logs = await deps.chainClient.getLogsByEvents({ events: PONS_V2_CURVE_ABI, fromBlock: windowFrom, toBlock: windowTo, address: token.curveAddress });
    requests += 1;

    if (logs.status === "UNAVAILABLE") {
      const kind = classifyWindowFailure(logs.reason);
      if (kind !== "NONE" && range > MIN_RANGE) {
        range = range / 2n < MIN_RANGE ? MIN_RANGE : range / 2n;
        logger.warn(`backfill ${address}: window narrowed to ${range} after ${kind.toLowerCase()} — ${logs.reason.slice(0, 120)}`);
        continue;
      }
      await markStopped(deps.db, address, cursor, tradesWritten, logsScanned, requests, "FAILED", logs.reason.slice(0, 400));
      return fail(address, logs.reason, startedAt, now, cursor, tradesWritten, logsScanned, requests, token.graduated);
    }

    logsScanned += logs.data.length;
    const { trades } = selectCurveTrades(logs.data, curves);

    if (trades.length > 0) {
      const timestamps = await resolveTimestamps(deps, logs.data, trades);
      if (timestamps === null) {
        await markStopped(deps.db, address, cursor, tradesWritten, logsScanned, requests, "PARTIAL", "block timestamps unavailable");
        return partial(address, token.sourceHeight, target, cursor, tradesWritten, logsScanned, requests, "block timestamps unavailable", startedAt, now, token.graduated);
      }
      const rows = trades.map((trade) => {
        const ts = timestamps.get(trade.provenance.sourceHeight) ?? null;
        if (ts && (earliestTimestamp === null || ts < earliestTimestamp)) earliestTimestamp = ts;
        return {
          chain: trade.chain,
          venue: VENUE,
          tokenAddress: trade.tokenAddress.toLowerCase(),
          poolAddress: trade.curveAddress,
          poolId: null,
          side: trade.side,
          tokenAmount: trade.tokenAmount,
          quoteAmount: trade.quoteAmount,
          quoteAddress: trade.quoteAddress.toLowerCase(),
          priceQuote: trade.priceQuote,
          trader: trade.trader.toLowerCase(),
          sourceHeight: BigInt(trade.provenance.sourceHeight),
          sourceHash: trade.provenance.sourceHash,
          sourceTxHash: trade.provenance.sourceTxHash,
          sourceIndex: trade.provenance.sourceIndex,
          observedAt: new Date(),
          sourceTimestamp: ts,
        };
      });
      await writeTradesChunked(deps.db, rows as never);
      tradesWritten += trades.length;
    }

    cursor = windowTo;
    await deps.db.tokenTradeBackfill.update({
      where: { chain_tokenAddress: { chain: ROBINHOOD_CHAIN, tokenAddress: address } },
      data: { cursor, tradesWritten, logsScanned, requests },
    });
  }

  /**
   * Second leg: a graduated token's Uniswap V4 swaps.
   *
   * Also index-backed — the pool's `poolId` is an indexed topic on the PoolManager — so
   * this is another filtered query, not a scan. Only attempted once the curve leg has
   * reached the target, and only from the graduation block, because the pool did not exist
   * before it. A token whose pool identity was never resolved is reported as uncovered
   * rather than quietly presented as a complete history.
   */
  const tally = { trades: tradesWritten, logs: logsScanned, requests };
  const poolCovered =
    token.graduated && token.poolId !== null && token.isToken0 !== null && cursor >= target && stoppedReason === null
      ? await backfillPoolSwaps(
          deps,
          { ...token, poolId: token.poolId, isToken0: token.isToken0 },
          target,
          range,
          (ts) => {
            if (earliestTimestamp === null || ts < earliestTimestamp) earliestTimestamp = ts;
          },
          tally
        )
      : false;
  // Totals must cover both venues, or a graduated token reports only its curve trades —
  // 80 instead of 5,561 on the token this was first measured against.
  tradesWritten = tally.trades;
  logsScanned = tally.logs;
  requests = tally.requests;

  /**
   * Candles are rebuilt by the existing recompute engine rather than by a second
   * aggregation path here: one invalidation from the earliest backfilled trade makes the
   * worker recompute those buckets from the trades table, which now contains the history.
   */
  if (earliestTimestamp !== null) {
    await deps.db.candleInvalidation.create({
      data: { chain: ROBINHOOD_CHAIN, tokenAddress: address, invalidatedFromTimestamp: earliestTimestamp },
    });
  }

  const done = cursor >= target && stoppedReason === null;
  await markStopped(deps.db, address, cursor, tradesWritten, logsScanned, requests, done ? "COMPLETE" : "PARTIAL", null, stoppedReason);
  logger.info(
    `backfill ${address}: ${done ? "complete" : "partial"} — ${tradesWritten} trade(s) from ${logsScanned} log(s) in ${requests} request(s), blocks ${token.sourceHeight}-${cursor}, ${now() - startedAt}ms`
  );

  return done
    ? complete(address, token.sourceHeight, target, cursor, tradesWritten, logsScanned, requests, startedAt, now, token.graduated, poolCovered)
    : partial(address, token.sourceHeight, target, cursor, tradesWritten, logsScanned, requests, stoppedReason, startedAt, now, token.graduated, poolCovered);
}

/**
 * Write trades in bounded transactions.
 *
 * A backfill window can carry far more trades than a live tick ever does — one V4 window
 * exceeded Prisma's default 5s transaction timeout outright. Chunking keeps each
 * transaction short and, because every row is an independent upsert on
 * `(chain, sourceTxHash, sourceIndex)`, a chunk boundary changes nothing about correctness:
 * a re-run simply upserts the same rows again.
 */
const WRITE_CHUNK = 250;
const WRITE_TIMEOUT_MS = 60_000;

async function writeTradesChunked(
  db: PrismaClient,
  rows: readonly Parameters<PrismaClient["chainTrade"]["create"]>[0]["data"][]
): Promise<void> {
  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    const slice = rows.slice(i, i + WRITE_CHUNK);
    await db.$transaction(
      async (tx) => {
        for (const data of slice) {
          await tx.chainTrade.upsert({
            where: {
              chain_sourceTxHash_sourceIndex: {
                chain: data.chain as string,
                sourceTxHash: data.sourceTxHash as string,
                sourceIndex: data.sourceIndex as number,
              },
            },
            create: data,
            // A live tick may have written this same trade already; leave it alone.
            update: {},
          });
        }
      },
      { timeout: WRITE_TIMEOUT_MS }
    );
  }
}

/**
 * Backfill a graduated token's Uniswap V4 swaps, from its graduation block forward.
 *
 * Returns whether the pool was actually covered, so the caller can report it honestly
 * instead of assuming. Any failure here leaves the curve history intact and simply reports
 * V4 as uncovered — a partial history is a fact to state, not a reason to discard work.
 */
async function backfillPoolSwaps(
  deps: BackfillDeps,
  token: { tokenAddress: string; quoteAddress: string; poolId: string; isToken0: boolean; graduationSourceHeight: bigint | null; sourceHeight: bigint },
  target: bigint,
  maxRange: bigint,
  noteTimestamp: (ts: Date) => void,
  /** Counters are shared with the curve leg so the reported totals cover both venues. */
  tally: { trades: number; logs: number; requests: number }
): Promise<boolean> {
  const logger = deps.logger ?? noopLogger;
  if (!deps.v2FactoryAddress) {
    logger.warn(`backfill ${token.tokenAddress}: no V2 factory configured, V4 swaps not covered`);
    return false;
  }

  const poolManager = await deps.chainClient.readContract<string>({
    address: deps.v2FactoryAddress,
    abi: PONS_V2_FACTORY_ABI,
    functionName: "poolManager",
    args: [],
  });
  if (poolManager.status === "UNAVAILABLE") {
    logger.warn(`backfill ${token.tokenAddress}: poolManager() unavailable, V4 swaps not covered`);
    return false;
  }

  const swapEvent = getAbiItem({ abi: UNISWAP_V4_POOL_MANAGER_ABI, name: "Swap" });
  // The pool did not exist before graduation, so there is nothing to find below it.
  let cursor = (token.graduationSourceHeight ?? token.sourceHeight) - 1n;
  let range = maxRange;

  while (cursor < target) {
    const from = cursor + 1n;
    const to = from + range - 1n > target ? target : from + range - 1n;
    const logs = await deps.chainClient.getLogs({ address: poolManager.data, event: swapEvent, args: { id: [token.poolId] }, fromBlock: from, toBlock: to });
    tally.requests += 1;
    if (logs.status === "UNAVAILABLE") {
      if (classifyWindowFailure(logs.reason) !== "NONE" && range > MIN_RANGE) {
        range = range / 2n < MIN_RANGE ? MIN_RANGE : range / 2n;
        continue;
      }
      logger.warn(`backfill ${token.tokenAddress}: V4 swap query failed, pool not covered — ${logs.reason.slice(0, 120)}`);
      return false;
    }

    tally.logs += logs.data.length;
    const trades = logs.data
      .map((log) => ponsV2Adapter.decodeTrade({ log, tokenAddress: token.tokenAddress, quoteAddress: token.quoteAddress, isToken0: token.isToken0 }))
      .filter((t): t is NonNullable<typeof t> => t !== null);

    if (trades.length > 0) {
      const timestamps = await resolveTimestamps(deps, logs.data, trades);
      if (timestamps === null) return false;
      const rows = trades.map((trade) => {
        const ts = timestamps.get(trade.provenance.sourceHeight) ?? null;
        if (ts) noteTimestamp(ts);
        return {
          chain: trade.chain,
          venue: trade.venue,
          tokenAddress: trade.tokenAddress.toLowerCase(),
          poolAddress: null,
          poolId: token.poolId.toLowerCase(),
          side: trade.side,
          tokenAmount: trade.tokenAmount,
          quoteAmount: trade.quoteAmount,
          quoteAddress: trade.quoteAddress.toLowerCase(),
          priceQuote: trade.priceQuote,
          trader: trade.trader.toLowerCase(),
          sourceHeight: BigInt(trade.provenance.sourceHeight),
          sourceHash: trade.provenance.sourceHash,
          sourceTxHash: trade.provenance.sourceTxHash,
          sourceIndex: trade.provenance.sourceIndex,
          observedAt: new Date(),
          sourceTimestamp: ts,
        };
      });
      await writeTradesChunked(deps.db, rows as never);
      tally.trades += trades.length;
    }
    cursor = to;
  }
  return true;
}

/**
 * Block timestamps, preferring the ones the logs already carry. All logs of a block must
 * agree, and a trade's recorded block hash must match the block we read, or this returns
 * null and the caller stops — the same fail-closed rule the live listener uses.
 */
async function resolveTimestamps(
  deps: BackfillDeps,
  logs: readonly { blockNumber: bigint; blockHash: string; blockTimestamp?: bigint | null }[],
  trades: readonly { provenance: { sourceHeight: string; sourceHash: string } }[]
): Promise<Map<string, Date> | null> {
  const timestamps = new Map<string, Date>();
  const seen = new Map<string, { hash: string; timestamp: bigint }>();
  for (const log of logs) {
    if (log.blockTimestamp === null || log.blockTimestamp === undefined) continue;
    const h = log.blockNumber.toString();
    const prior = seen.get(h);
    if (prior && (prior.hash.toLowerCase() !== log.blockHash.toLowerCase() || prior.timestamp !== log.blockTimestamp)) return null;
    seen.set(h, { hash: log.blockHash, timestamp: log.blockTimestamp });
  }
  for (const [h, ref] of seen) timestamps.set(h, new Date(Number(ref.timestamp) * 1000));

  const missing = [...new Set(trades.map((t) => t.provenance.sourceHeight))].filter((h) => !timestamps.has(h));
  if (missing.length === 0) return timestamps;

  const refs = await mapWithConcurrency(missing, deps.config.tradeQueryConcurrency, (h) => deps.chainClient.getBlockRef(BigInt(h)));
  for (let i = 0; i < missing.length; i += 1) {
    const outcome = refs[i];
    if (outcome.status !== "fulfilled" || outcome.value.status !== "AVAILABLE") return null;
    const expected = trades.find((t) => t.provenance.sourceHeight === missing[i])?.provenance.sourceHash;
    if (expected && expected.toLowerCase() !== outcome.value.data.hash.toLowerCase()) return null;
    timestamps.set(missing[i], new Date(Number(outcome.value.data.timestamp) * 1000));
  }
  return timestamps;
}

async function markStopped(
  db: PrismaClient,
  tokenAddress: string,
  cursor: bigint,
  tradesWritten: number,
  logsScanned: number,
  requests: number,
  status: string,
  lastError: string | null,
  stoppedReason: string | null = null
): Promise<void> {
  await db.tokenTradeBackfill
    .update({
      where: { chain_tokenAddress: { chain: ROBINHOOD_CHAIN, tokenAddress } },
      data: { status, cursor, tradesWritten, logsScanned, requests, lastError, stoppedReason, completedAt: status === "COMPLETE" ? new Date() : null },
    })
    .catch(() => undefined);
}

/**
 * What a run could actually account for. A graduated token whose pool identity is unknown
 * is reported as uncovered for V4 rather than silently presented as a complete history.
 */
function venues(graduated: boolean, poolCovered: boolean): { covered: string[]; uncovered: string[] } {
  const covered = ["PONS_V2_BONDING_CURVE"];
  if (graduated && poolCovered) covered.push("UNISWAP_V4_POOL");
  return { covered, uncovered: graduated && !poolCovered ? ["UNISWAP_V4_POOL"] : [] };
}

function base(tokenAddress: string, startedAt: number, now: () => number, graduated = false, poolCovered = false) {
  const v = venues(graduated, poolCovered);
  return { tokenAddress, elapsedMs: now() - startedAt, coveredVenues: v.covered, uncoveredVenues: v.uncovered };
}

function complete(tokenAddress: string, fromBlock: bigint, toBlock: bigint, cursor: bigint, tradesWritten: number, logsScanned: number, requests: number, startedAt: number, now: () => number, graduated: boolean, poolCovered = false): BackfillResult {
  return { status: "COMPLETE", fromBlock, toBlock, cursor, tradesWritten, logsScanned, requests, stoppedReason: null, ...base(tokenAddress, startedAt, now, graduated, poolCovered) };
}

function partial(tokenAddress: string, fromBlock: bigint, toBlock: bigint, cursor: bigint, tradesWritten: number, logsScanned: number, requests: number, stoppedReason: string | null, startedAt: number, now: () => number, graduated: boolean, poolCovered = false): BackfillResult {
  return { status: "PARTIAL", fromBlock, toBlock, cursor, tradesWritten, logsScanned, requests, stoppedReason, ...base(tokenAddress, startedAt, now, graduated, poolCovered) };
}

function fail(tokenAddress: string, reason: string, startedAt: number, now: () => number, cursor = 0n, tradesWritten = 0, logsScanned = 0, requests = 0, graduated = false): BackfillResult {
  return { status: "FAILED", fromBlock: 0n, toBlock: 0n, cursor, tradesWritten, logsScanned, requests, stoppedReason: reason, ...base(tokenAddress, startedAt, now, graduated) };
}

/**
 * What the API route calls. Injectable for the same reason `createPoolEvidenceProvider` is:
 * a route test must never construct a real RPC client.
 */
export type BackfillRunner = (tokenAddress: string) => Promise<BackfillResult>;

/**
 * The real runner. The chain client and config are built on first use, so importing this
 * module — which route tests do — never touches an endpoint.
 */
export function createBackfillRunner(db: PrismaClient): BackfillRunner {
  let deps: BackfillDeps | null = null;
  return async (tokenAddress: string) => {
    if (deps === null) {
      const { FailoverChainClient } = await import("../failoverChainClient");
      const { loadRobinhoodChainConfig, loadPonsV2Config } = await import("../config");
      const { ponsComponentLogger } = await import("../logger");
      const config = loadRobinhoodChainConfig();
      // A deployment without PONS_V2_FACTORY still backfills curve trades; it just reports
      // V4 as uncovered instead of failing.
      const v2FactoryAddress = (() => {
        try {
          return loadPonsV2Config().factoryAddress;
        } catch {
          return undefined;
        }
      })();
      deps = { db, chainClient: new FailoverChainClient({ config }), config, v2FactoryAddress, logger: ponsComponentLogger("pons:backfill") };
    }
    return backfillTokenTrades(deps, tokenAddress);
  };
}
