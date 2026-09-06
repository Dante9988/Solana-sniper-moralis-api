/**
 * Phase 7B.4 §4.4/§4.5/§4.8 — Pons trade listener.
 *
 * Polls eth_getLogs for Swap across every pool address the discovery
 * listener has recorded. Candle/OHLCV aggregation is explicitly out of
 * scope for this phase — this only persists raw, deduplicated trades.
 *
 * Phase 7B.5A hardens this with:
 *  - a discovery-before-trades barrier that makes the historical
 *    discovery/trade race (§1) structurally impossible: trade ingestion
 *    may only advance its checkpoint to a height that discovery has (a)
 *    already committed a checkpoint for, and (b) fully enriched every pool
 *    discovered at or before. See computeBarrierHeight() below;
 *  - chunked, bounded-concurrency pool-address queries instead of one
 *    ever-growing address array (§3);
 *  - real bounded reorg rollback/replay instead of detect-and-halt (§2);
 *  - persisted poll/error/reorg metadata for the source-health projection
 *    (§5), plus operational metrics (pools queried, RPC log calls, blocks
 *    scanned, trades decoded).
 */

import type { PrismaClient } from "@prisma/client";
import { getAbiItem } from "viem";
import { ChainReader } from "./chainClient";
import { RobinhoodChainConfig } from "./config";
import { CheckpointStore, recordChainBlockCheckpoint } from "./checkpointStore";
import { ponsAdapter } from "./ponsAdapter";
import { UNISWAP_V3_POOL_ABI } from "./abi";
import { NormalizedTradeExecuted } from "../discovery/types";
import { chunk, mapWithConcurrency } from "./concurrency";
import { attemptReorgRecovery } from "./reorgRecovery";
import { DISCOVERY_CHECKPOINT_SOURCE, ROBINHOOD_CHAIN } from "./discoveryListener";

export const TRADE_CHECKPOINT_SOURCE = "robinhood:pons:trades";

const SWAP_EVENT_NAME = "Swap" as const;

export type TradeTickResult =
  | { status: "UP_TO_DATE"; safeTip: bigint }
  | { status: "NO_POOLS_TRACKED" }
  | { status: "WAITING_ON_DISCOVERY"; reason: string }
  | {
      status: "PROCESSED";
      fromBlock: bigint;
      toBlock: bigint;
      tradesRecorded: number;
      poolsQueried: number;
      rpcLogCalls: number;
      retryEvents: number;
    }
  | { status: "UNAVAILABLE"; reason: string }
  | { status: "REORG_RECOVERED"; ancestorHeight: bigint }
  | { status: "REORG_UNRESOLVED"; reason: string };

export interface TradeListenerLogger {
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
}

const noopLogger: TradeListenerLogger = { info: () => {}, warn: () => {}, error: () => {} };

export interface TradeListenerDeps {
  chainClient: ChainReader;
  db: PrismaClient;
  config: RobinhoodChainConfig;
  logger?: TradeListenerLogger;
}

export class TradeListener {
  private readonly chainClient: ChainReader;
  private readonly db: PrismaClient;
  private readonly config: RobinhoodChainConfig;
  private readonly logger: TradeListenerLogger;
  private stopping = false;
  private timer: NodeJS.Timeout | null = null;
  /** Phase 7B.5A §7 — tracked so a graceful shutdown can await the in-flight tick (waitForIdle()) rather than disconnecting Prisma mid-transaction. */
  private currentTick: Promise<void> = Promise.resolve();

  constructor(deps: TradeListenerDeps) {
    this.chainClient = deps.chainClient;
    this.db = deps.db;
    this.config = deps.config;
    this.logger = deps.logger ?? noopLogger;
  }

  async runOnce(): Promise<TradeTickResult> {
    const checkpointStore = new CheckpointStore(this.db);

    // Pools tracked *right now* — deliberately checked before anything else,
    // matching Phase 7B.4's original short-circuit: with nothing discovered
    // yet there's nothing this tick can do, independent of the discovery
    // checkpoint's state. Only CANONICAL (not reorg-orphaned) and COMPLETE
    // (enrichment finished — isToken0 is required to decode a Swap's signed
    // amounts) pools are ever queried.
    const trackedTokens = await this.db.discoveredToken.findMany({
      where: { chain: ROBINHOOD_CHAIN, poolAddress: { not: null }, canonicalStatus: "CANONICAL", enrichmentStatus: "COMPLETE" },
      select: { tokenAddress: true, poolAddress: true, quoteAddress: true, isToken0: true },
    });
    if (trackedTokens.length === 0) {
      return { status: "NO_POOLS_TRACKED" };
    }
    const byPool = new Map(trackedTokens.map((t) => [t.poolAddress!.toLowerCase(), t]));
    const poolAddresses = [...byPool.keys()];

    const latestResult = await this.chainClient.getBlockNumber();
    if (latestResult.status === "UNAVAILABLE") {
      await checkpointStore.recordFailure(TRADE_CHECKPOINT_SOURCE, `getBlockNumber: ${latestResult.reason}`);
      return { status: "UNAVAILABLE", reason: `getBlockNumber: ${latestResult.reason}` };
    }
    const observedChainHeight = latestResult.data;
    const safeTip = observedChainHeight - BigInt(this.config.confirmationLagBlocks);
    if (safeTip < 0n) {
      await checkpointStore.recordUpToDate(TRADE_CHECKPOINT_SOURCE, observedChainHeight);
      return { status: "UP_TO_DATE", safeTip: 0n };
    }

    const checkpoint = await checkpointStore.get(TRADE_CHECKPOINT_SOURCE);

    if (checkpoint) {
      // §2/§4.8 — same detect-and-recover discipline as the discovery
      // listener; see discoveryListener.ts and reorgRecovery.ts for the
      // full rationale. Reorg recovery is chain-scoped (both discovery and
      // trade checkpoints roll back together), so it is safe and idempotent
      // for either listener to be the one that detects and triggers it.
      const checkpointBlock = await this.chainClient.getBlockRef(checkpoint.lastHeight);
      if (checkpointBlock.status === "UNAVAILABLE") {
        await checkpointStore.recordFailure(TRADE_CHECKPOINT_SOURCE, `reorg check getBlockRef: ${checkpointBlock.reason}`);
        return { status: "UNAVAILABLE", reason: `reorg check getBlockRef: ${checkpointBlock.reason}` };
      }
      if (checkpointBlock.data.hash.toLowerCase() !== checkpoint.lastHash.toLowerCase()) {
        this.logger.error(`reorg detected (trades) at height ${checkpoint.lastHeight}: expected ${checkpoint.lastHash}, chain now reports ${checkpointBlock.data.hash}. Attempting bounded recovery.`);
        const recovery = await attemptReorgRecovery({ chainClient: this.chainClient, db: this.db, chain: ROBINHOOD_CHAIN });
        if (recovery.status === "UNAVAILABLE") {
          await checkpointStore.recordFailure(TRADE_CHECKPOINT_SOURCE, `reorg recovery unavailable: ${recovery.reason}`);
          return { status: "UNAVAILABLE", reason: `reorg recovery: ${recovery.reason}` };
        }
        if (recovery.status === "UNRESOLVED") {
          this.logger.error(`reorg recovery UNRESOLVED (trades) — halting.`, { searchedDepth: recovery.searchedDepth });
          await checkpointStore.markReorgUnresolved(TRADE_CHECKPOINT_SOURCE, recovery.reason);
          return { status: "REORG_UNRESOLVED", reason: recovery.reason };
        }
        this.logger.info(`reorg RECOVERED (trades) at ancestor height ${recovery.ancestorHeight}.`);
        return { status: "REORG_RECOVERED", ancestorHeight: recovery.ancestorHeight };
      }
    }

    // §1/§9 — the discovery-before-trades barrier. Trade ingestion may only
    // advance to a height that discovery has (a) already committed a
    // checkpoint for, so any pool launched at or before that height is
    // guaranteed already persisted (discovery commits its token upserts and
    // its own checkpoint atomically in one transaction — see
    // discoveryListener.ts), and (b) fully enriched every pool discovered
    // at or before that height, so a still-PENDING pool's trades are never
    // skipped over just because a different, already-COMPLETE pool is
    // ready. This makes the historical race (§1) structurally impossible
    // rather than merely less likely: trades can never be scanned past a
    // block that discovery/enrichment hasn't already made fully knowable.
    const discoveryCheckpoint = await checkpointStore.get(DISCOVERY_CHECKPOINT_SOURCE);
    if (!discoveryCheckpoint) {
      await checkpointStore.recordUpToDate(TRADE_CHECKPOINT_SOURCE, observedChainHeight);
      return { status: "WAITING_ON_DISCOVERY", reason: "no discovery checkpoint yet — trade ingestion cannot safely determine which pools are complete" };
    }
    const earliestPending = await this.db.discoveredToken.findFirst({
      where: { chain: ROBINHOOD_CHAIN, canonicalStatus: "CANONICAL", enrichmentStatus: "PENDING", sourceHeight: { lte: discoveryCheckpoint.lastHeight } },
      orderBy: { sourceHeight: "asc" },
      select: { sourceHeight: true },
    });
    const barrierHeight = earliestPending ? (earliestPending.sourceHeight - 1n < discoveryCheckpoint.lastHeight ? earliestPending.sourceHeight - 1n : discoveryCheckpoint.lastHeight) : discoveryCheckpoint.lastHeight;

    const fromBlock = checkpoint
      ? checkpoint.lastHeight + 1n
      : (() => {
          const lookback = BigInt(this.config.freshStartLookbackBlocks);
          const start = safeTip - lookback + 1n;
          this.logger.warn(`No trade checkpoint found — starting fresh at height ${start > 0n ? start : 0n}.`);
          return start > 0n ? start : 0n;
        })();

    const effectiveTip = safeTip < barrierHeight ? safeTip : barrierHeight;
    if (fromBlock > effectiveTip) {
      await checkpointStore.recordUpToDate(TRADE_CHECKPOINT_SOURCE, observedChainHeight);
      if (barrierHeight < safeTip) {
        return { status: "WAITING_ON_DISCOVERY", reason: `barrier height ${barrierHeight} (discovery checkpoint ${discoveryCheckpoint.lastHeight}${earliestPending ? `, pending enrichment at ${earliestPending.sourceHeight}` : ""}) is behind the next block to scan` };
      }
      return { status: "UP_TO_DATE", safeTip: effectiveTip };
    }

    const toBlock = (() => {
      const maxRange = BigInt(this.config.maxBlockRangePerPoll);
      const candidate = fromBlock + maxRange - 1n;
      return candidate < effectiveTip ? candidate : effectiveTip;
    })();

    // §3 — chunked, bounded-concurrency pool queries rather than one
    // ever-growing address array. Preserves full completeness (no pool is
    // ever aged out or dropped) while keeping any single eth_getLogs call's
    // address-array size bounded and configurable.
    const swapEvent = getAbiItem({ abi: UNISWAP_V3_POOL_ABI, name: SWAP_EVENT_NAME });
    const poolChunks = chunk(poolAddresses, this.config.tradePoolChunkSize);
    const chunkOutcomes = await mapWithConcurrency(poolChunks, this.config.tradeQueryConcurrency, (addresses) =>
      this.chainClient.getLogs({ address: addresses, event: swapEvent, fromBlock, toBlock })
    );

    let retryEvents = 0;
    const allLogs: import("./ponsAdapter").RawEvmLog[] = [];
    for (const outcome of chunkOutcomes) {
      if (outcome.status === "rejected") {
        await checkpointStore.recordFailure(TRADE_CHECKPOINT_SOURCE, `getLogs chunk threw: ${String(outcome.reason)}`);
        return { status: "UNAVAILABLE", reason: `getLogs chunk threw: ${String(outcome.reason)}` };
      }
      const result = outcome.value;
      if (result.status === "UNAVAILABLE") {
        await checkpointStore.recordFailure(TRADE_CHECKPOINT_SOURCE, `getLogs: ${result.reason}`);
        return { status: "UNAVAILABLE", reason: `getLogs: ${result.reason}` };
      }
      if (result.attempts > 1) retryEvents += 1;
      allLogs.push(...result.data);
    }

    const trades: NormalizedTradeExecuted[] = [];
    for (const log of allLogs) {
      const tracked = byPool.get(log.address.toLowerCase());
      if (!tracked) continue; // shouldn't happen (we filtered by these exact addresses), but fail closed rather than guess
      const normalized = ponsAdapter.decodeTrade({
        log,
        tokenAddress: tracked.tokenAddress,
        quoteAddress: tracked.quoteAddress,
        isToken0: tracked.isToken0!,
      });
      if (normalized) trades.push(normalized);
    }

    const toBlockRef = await this.chainClient.getBlockRef(toBlock);
    if (toBlockRef.status === "UNAVAILABLE") {
      await checkpointStore.recordFailure(TRADE_CHECKPOINT_SOURCE, `getBlockRef(toBlock): ${toBlockRef.reason}`);
      return { status: "UNAVAILABLE", reason: `getBlockRef(toBlock): ${toBlockRef.reason}` };
    }

    await this.db.$transaction(async (tx) => {
      for (const trade of trades) {
        // Same case-normalization rationale as discoveryListener.ts — keep
        // every address lowercase in Postgres regardless of the casing the
        // decoder or log happened to produce.
        await tx.chainTrade.upsert({
          where: { chain_sourceTxHash_sourceIndex: { chain: trade.chain, sourceTxHash: trade.provenance.sourceTxHash, sourceIndex: trade.provenance.sourceIndex } },
          create: {
            chain: trade.chain,
            venue: trade.venue,
            tokenAddress: trade.tokenAddress.toLowerCase(),
            poolAddress: trade.poolAddress?.toLowerCase() ?? null,
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
            observedAt: new Date(trade.observedAt),
          },
          // §2/§9 — revive a same-(txHash,logIndex) row that had been
          // orphaned by reorg recovery back to canonical on replay (see
          // discoveryListener.ts's upsert for the same rationale).
          update: { canonicalStatus: "CANONICAL", orphanedAt: null },
        });
      }
      const checkpointStoreTx = new CheckpointStore(tx);
      await checkpointStoreTx.set(TRADE_CHECKPOINT_SOURCE, { lastHeight: toBlock, lastHash: toBlockRef.data.hash }, observedChainHeight);
      await recordChainBlockCheckpoint(tx, ROBINHOOD_CHAIN, toBlock, toBlockRef.data.hash, this.config.reorgMaxDepthBlocks);
      // See discoveryListener.ts's matching comment — Prisma's 5s default
      // interactive-transaction timeout doesn't scale with how many trades
      // a large catch-up range or genuine trade burst can decode.
    }, { timeout: 60_000 });

    this.logger.info(
      `trade tick: processed blocks ${fromBlock}-${toBlock} across ${poolAddresses.length} pool(s) in ${poolChunks.length} chunk(s), ${trades.length} trade(s) recorded, ${retryEvents} chunk(s) needed a retry.`
    );
    return { status: "PROCESSED", fromBlock, toBlock, tradesRecorded: trades.length, poolsQueried: poolAddresses.length, rpcLogCalls: poolChunks.length, retryEvents };
  }

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    const tick = async () => {
      if (this.stopping) return;
      this.currentTick = (async () => {
        try {
          await this.runOnce();
        } catch (err) {
          this.logger.error(`Trade listener tick threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
      await this.currentTick;
      if (!this.stopping) {
        this.timer = setTimeout(tick, this.config.pollIntervalMs);
      }
    };
    this.timer = setTimeout(tick, 0);
  }

  stop(): void {
    this.stopping = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Phase 7B.5A §7 — graceful shutdown: await this after stop() so the process never disconnects Prisma while a tick's transaction is still in flight. Resolves immediately if no tick is currently running. */
  async waitForIdle(): Promise<void> {
    await this.currentTick;
  }
}
