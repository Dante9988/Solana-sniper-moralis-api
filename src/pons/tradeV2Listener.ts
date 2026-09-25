import { WakeableLoop } from "./wakeableLoop";
/**
 * Phase 7D §2 — Pons V2 transaction history: real trades on graduated
 * tokens' Uniswap V4 pools.
 *
 * Modeled directly on tradeListener.ts's checkpointed/reorg-aware/chunked
 * loop, but queries the Uniswap V4 singleton PoolManager filtered by the
 * `id` (PoolId) topic instead of iterating per-pool contract addresses —
 * V4 has no discrete per-pool contract the way V3 does (verified live,
 * see abiV2.ts's header). Only tokens that have actually graduated (and
 * whose PoolId was captured — see discoveryV2Listener.ts's Initialize
 * lookup) are ever tracked; pre-graduation bonding-curve trades stay out
 * of scope (the curve contract is unverified — see abiV2.ts/discovery/types.ts).
 *
 * Same discovery-before-trades barrier discipline as tradeListener.ts,
 * barriered against DISCOVERY_V2_CHECKPOINT_SOURCE (V2's own discovery
 * checkpoint, independent of V1's).
 */

import type { PrismaClient } from "@prisma/client";
import { nextTickDelayMs, processedWidth } from "./tickPacing";
import { getAbiItem } from "viem";
import { ChainReader } from "./chainClient";
import { RobinhoodChainConfig } from "./config";
import { PonsV2Config } from "./config";
import { CheckpointStore, recordChainBlockCheckpoint } from "./checkpointStore";
import { ponsV2Adapter } from "./ponsV2Adapter";
import { PONS_V2_FACTORY_ABI, UNISWAP_V4_POOL_MANAGER_ABI } from "./abiV2";
import { NormalizedTradeExecuted } from "../discovery/types";
import { chunk, mapWithConcurrency } from "./concurrency";
import { attemptReorgRecovery } from "./reorgRecovery";
import { ROBINHOOD_CHAIN } from "./discoveryListener";
import { DISCOVERY_V2_CHECKPOINT_SOURCE } from "./discoveryV2Listener";
import type { RawEvmLog } from "./ponsAdapter";

export const TRADE_V2_CHECKPOINT_SOURCE = "robinhood:pons_v2:trades";
const VENUE = "pons_v2" as const;
const SWAP_EVENT_NAME = "Swap" as const;

export type TradeV2TickResult =
  | { status: "UP_TO_DATE"; safeTip: bigint }
  | { status: "NO_POOLS_TRACKED" }
  | { status: "WAITING_ON_DISCOVERY"; reason: string }
  | { status: "PROCESSED"; fromBlock: bigint; toBlock: bigint; tradesRecorded: number; poolsQueried: number; rpcLogCalls: number }
  | { status: "UNAVAILABLE"; reason: string }
  | { status: "REORG_RECOVERED"; ancestorHeight: bigint }
  | { status: "REORG_UNRESOLVED"; reason: string };

export interface TradeV2ListenerLogger {
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
}

const noopLogger: TradeV2ListenerLogger = { info: () => {}, warn: () => {}, error: () => {} };

export interface TradeV2ListenerDeps {
  chainClient: ChainReader;
  db: PrismaClient;
  config: RobinhoodChainConfig;
  v2Config: PonsV2Config;
  logger?: TradeV2ListenerLogger;
  /**
   * Phase 7D.5 — namespace for this listener's checkpoints. Set in `live-head` mode to
   * `session:<id>:`, which keeps the durable `robinhood:*` rows untouched. Empty in
   * `resume` mode, which is the pre-existing behaviour.
   */
  sessionPrefix?: string;
  /**
   * Phase 7D.5 — where to begin when this source has no checkpoint yet. In `live-head` mode
   * this is the shared session boundary, so every stream starts from the same block instead
   * of each picking its own lookback behind the tip.
   */
  freshStartHeight?: bigint;
}

export class TradeV2Listener {
  private readonly chainClient: ChainReader;
  private readonly db: PrismaClient;
  private readonly config: RobinhoodChainConfig;
  private readonly v2Config: PonsV2Config;
  private readonly logger: TradeV2ListenerLogger;
  private stopping = false;
  private timer: NodeJS.Timeout | null = null;
  private currentTick: Promise<void> = Promise.resolve();

  private readonly sessionPrefix: string;
  private readonly freshStartHeight: bigint | null;

  constructor(deps: TradeV2ListenerDeps) {
    this.sessionPrefix = deps.sessionPrefix ?? "";
    this.freshStartHeight = deps.freshStartHeight ?? null;
    this.chainClient = deps.chainClient;
    this.db = deps.db;
    this.config = deps.config;
    this.v2Config = deps.v2Config;
    this.logger = deps.logger ?? noopLogger;
  }

  private poolManagerAddressPromise: Promise<string | null> | null = null;
  private async getPoolManagerAddress(): Promise<string | null> {
    if (!this.poolManagerAddressPromise) {
      this.poolManagerAddressPromise = this.chainClient
        .readContract<string>({ address: this.v2Config.factoryAddress, abi: PONS_V2_FACTORY_ABI, functionName: "poolManager", args: [] })
        .then((r) => (r.status === "AVAILABLE" ? r.data : null));
    }
    return this.poolManagerAddressPromise;
  }

  async runOnce(): Promise<TradeV2TickResult> {
    const checkpointStore = new CheckpointStore(this.db, this.sessionPrefix);

    const trackedTokens = await this.db.discoveredToken.findMany({
      where: { chain: ROBINHOOD_CHAIN, venue: VENUE, graduated: true, poolId: { not: null }, canonicalStatus: "CANONICAL" },
      select: { tokenAddress: true, poolId: true, quoteAddress: true, isToken0: true },
    });
    if (trackedTokens.length === 0) {
      return { status: "NO_POOLS_TRACKED" };
    }
    const byPoolId = new Map(trackedTokens.map((t) => [t.poolId!.toLowerCase(), t]));
    const poolIds = [...byPoolId.keys()];

    const poolManager = await this.getPoolManagerAddress();
    if (!poolManager) {
      await checkpointStore.recordFailure(TRADE_V2_CHECKPOINT_SOURCE, "poolManager() unavailable from the V2 factory");
      return { status: "UNAVAILABLE", reason: "poolManager() unavailable from the V2 factory" };
    }

    const latestResult = await this.chainClient.getBlockNumber();
    if (latestResult.status === "UNAVAILABLE") {
      await checkpointStore.recordFailure(TRADE_V2_CHECKPOINT_SOURCE, `getBlockNumber: ${latestResult.reason}`);
      return { status: "UNAVAILABLE", reason: `getBlockNumber: ${latestResult.reason}` };
    }
    const observedChainHeight = latestResult.data;
    const safeTip = observedChainHeight - BigInt(this.config.confirmationLagBlocks);
    if (safeTip < 0n) {
      await checkpointStore.recordUpToDate(TRADE_V2_CHECKPOINT_SOURCE, observedChainHeight);
      return { status: "UP_TO_DATE", safeTip: 0n };
    }

    const checkpoint = await checkpointStore.get(TRADE_V2_CHECKPOINT_SOURCE);

    if (checkpoint) {
      const checkpointBlock = await this.chainClient.getBlockRef(checkpoint.lastHeight);
      if (checkpointBlock.status === "UNAVAILABLE") {
        await checkpointStore.recordFailure(TRADE_V2_CHECKPOINT_SOURCE, `reorg check getBlockRef: ${checkpointBlock.reason}`);
        return { status: "UNAVAILABLE", reason: `reorg check getBlockRef: ${checkpointBlock.reason}` };
      }
      if (checkpointBlock.data.hash.toLowerCase() !== checkpoint.lastHash.toLowerCase()) {
        this.logger.error(`reorg detected (pons_v2 trades) at height ${checkpoint.lastHeight}: expected ${checkpoint.lastHash}, chain now reports ${checkpointBlock.data.hash}. Attempting bounded recovery.`);
        const recovery = await attemptReorgRecovery({ chainClient: this.chainClient, db: this.db, chain: ROBINHOOD_CHAIN });
        if (recovery.status === "UNAVAILABLE") {
          await checkpointStore.recordFailure(TRADE_V2_CHECKPOINT_SOURCE, `reorg recovery unavailable: ${recovery.reason}`);
          return { status: "UNAVAILABLE", reason: `reorg recovery: ${recovery.reason}` };
        }
        if (recovery.status === "UNRESOLVED") {
          this.logger.error(`reorg recovery UNRESOLVED (pons_v2 trades) — halting.`, { searchedDepth: recovery.searchedDepth });
          await checkpointStore.markReorgUnresolved(TRADE_V2_CHECKPOINT_SOURCE, recovery.reason);
          return { status: "REORG_UNRESOLVED", reason: recovery.reason };
        }
        this.logger.info(`reorg RECOVERED (pons_v2 trades) at ancestor height ${recovery.ancestorHeight}.`);
        return { status: "REORG_RECOVERED", ancestorHeight: recovery.ancestorHeight };
      }
    }

    // Discovery-before-trades barrier — same rationale as tradeListener.ts,
    // barriered against V2's own discovery checkpoint so V1 and V2
    // progress independently. Simpler than V1's barrier: V2 has no
    // separate enrichment-pending state gating trade-readiness (a row only
    // ever appears in trackedTokens once graduated=true AND poolId is set,
    // both written atomically by discoveryV2Listener in the same tick).
    const discoveryCheckpoint = await checkpointStore.get(DISCOVERY_V2_CHECKPOINT_SOURCE);
    if (!discoveryCheckpoint) {
      await checkpointStore.recordUpToDate(TRADE_V2_CHECKPOINT_SOURCE, observedChainHeight);
      return { status: "WAITING_ON_DISCOVERY", reason: "no pons_v2 discovery checkpoint yet" };
    }
    const barrierHeight = discoveryCheckpoint.lastHeight;

    const freshStart = checkpoint === null;
    const fromBlock = checkpoint
      ? checkpoint.lastHeight + 1n
      : (() => {
          if (this.freshStartHeight !== null) return this.freshStartHeight;
          const lookback = BigInt(this.config.freshStartLookbackBlocks);
          const start = safeTip - lookback + 1n;
          return start > 0n ? start : 0n;
        })();

    const effectiveTip = safeTip < barrierHeight ? safeTip : barrierHeight;
    if (fromBlock > effectiveTip) {
      // Phase 7D.5: this branch persists no `lastHeight` — deliberately, because nothing
      // was scanned — so on a fresh start it recomputes `fromBlock` from the tip on every
      // tick. Announcing a "starting fresh at height N" that never happens, once per tick,
      // buried the real signal: 37 such warnings in 4 minutes while V2 discovery, the
      // barrier this is waiting on, was the thing that was actually stuck.
      await checkpointStore.recordUpToDate(TRADE_V2_CHECKPOINT_SOURCE, observedChainHeight);
      if (barrierHeight < safeTip) {
        return { status: "WAITING_ON_DISCOVERY", reason: `barrier height ${barrierHeight} (pons_v2 discovery checkpoint) is behind the next block to scan` };
      }
      return { status: "UP_TO_DATE", safeTip: effectiveTip };
    }

    const toBlock = (() => {
      const maxRange = BigInt(this.config.maxBlockRangePerPoll);
      const candidate = fromBlock + maxRange - 1n;
      return candidate < effectiveTip ? candidate : effectiveTip;
    })();

    const swapEvent = getAbiItem({ abi: UNISWAP_V4_POOL_MANAGER_ABI, name: SWAP_EVENT_NAME });
    if (freshStart) {
      this.logger.warn(`No pons_v2 trade checkpoint found — starting fresh at height ${fromBlock}.`);
    }
    // At the live head a narrow range over this one known PoolManager is
    // cheaper than ~38 separate pool-topic requests. Unknown pools are still
    // discarded below. Wide catch-up retains the established bounded chunks.
    const narrowLiveRange = toBlock - fromBlock < 1000n;
    const poolIdChunks = narrowLiveRange ? [poolIds] : chunk(poolIds, this.config.tradePoolChunkSize);
    const chunkOutcomes = await mapWithConcurrency(poolIdChunks, this.config.tradeQueryConcurrency, (ids) =>
      this.chainClient.getLogs({ address: poolManager, event: swapEvent, args: narrowLiveRange ? undefined : { id: ids }, fromBlock, toBlock })
    );

    const allLogs: RawEvmLog[] = [];
    for (const outcome of chunkOutcomes) {
      if (outcome.status === "rejected") {
        await checkpointStore.recordFailure(TRADE_V2_CHECKPOINT_SOURCE, `getLogs chunk threw: ${String(outcome.reason)}`);
        return { status: "UNAVAILABLE", reason: `getLogs chunk threw: ${String(outcome.reason)}` };
      }
      const result = outcome.value;
      if (result.status === "UNAVAILABLE") {
        await checkpointStore.recordFailure(TRADE_V2_CHECKPOINT_SOURCE, `getLogs: ${result.reason}`);
        return { status: "UNAVAILABLE", reason: `getLogs: ${result.reason}` };
      }
      allLogs.push(...result.data);
    }

    const trades: Array<NormalizedTradeExecuted & { poolId: string }> = [];
    for (const log of allLogs) {
      const poolId = log.topics[1]?.toLowerCase();
      const tracked = poolId ? byPoolId.get(poolId) : undefined;
      if (!tracked || !poolId) continue; // shouldn't happen (server-filtered by these exact ids), fail closed rather than guess
      const normalized = ponsV2Adapter.decodeTrade({ log, tokenAddress: tracked.tokenAddress, quoteAddress: tracked.quoteAddress, isToken0: tracked.isToken0! });
      if (normalized) trades.push({ ...normalized, poolId });
    }

    const toBlockRef = await this.chainClient.getBlockRef(toBlock);
    if (toBlockRef.status === "UNAVAILABLE") {
      await checkpointStore.recordFailure(TRADE_V2_CHECKPOINT_SOURCE, `getBlockRef(toBlock): ${toBlockRef.reason}`);
      return { status: "UNAVAILABLE", reason: `getBlockRef(toBlock): ${toBlockRef.reason}` };
    }

    const heightTimestamps = new Map<string, Date>([[toBlock.toString(), new Date(Number(toBlockRef.data.timestamp) * 1000)]]);
    const uniqueTradeHeights = [...new Set(trades.map((t) => t.provenance.sourceHeight))].filter((h) => !heightTimestamps.has(h));
    for (const heightStr of uniqueTradeHeights) {
      const ref = await this.chainClient.getBlockRef(BigInt(heightStr));
      if (ref.status === "UNAVAILABLE") {
        await checkpointStore.recordFailure(TRADE_V2_CHECKPOINT_SOURCE, `getBlockRef(timestamp @ ${heightStr}): ${ref.reason}`);
        return { status: "UNAVAILABLE", reason: `getBlockRef(timestamp @ ${heightStr}): ${ref.reason}` };
      }
      heightTimestamps.set(heightStr, new Date(Number(ref.data.timestamp) * 1000));
    }

    await this.db.$transaction(
      async (tx) => {
        for (const trade of trades) {
          await tx.chainTrade.upsert({
            where: { chain_sourceTxHash_sourceIndex: { chain: trade.chain, sourceTxHash: trade.provenance.sourceTxHash, sourceIndex: trade.provenance.sourceIndex } },
            create: {
              chain: trade.chain,
              venue: trade.venue,
              tokenAddress: trade.tokenAddress.toLowerCase(),
              poolAddress: null,
              poolId: trade.poolId,
              side: trade.side,
              normalizationVersion: 2,
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
              sourceTimestamp: heightTimestamps.get(trade.provenance.sourceHeight) ?? null,
            },
            update: { side: trade.side, normalizationVersion: 2, canonicalStatus: "CANONICAL", orphanedAt: null, sourceTimestamp: heightTimestamps.get(trade.provenance.sourceHeight) ?? null },
          });
        }
        const checkpointStoreTx = new CheckpointStore(tx, this.sessionPrefix);
        await checkpointStoreTx.set(TRADE_V2_CHECKPOINT_SOURCE, { lastHeight: toBlock, lastHash: toBlockRef.data.hash }, observedChainHeight, heightTimestamps.get(toBlock.toString()));
        await recordChainBlockCheckpoint(tx, ROBINHOOD_CHAIN, toBlock, toBlockRef.data.hash, this.config.reorgMaxDepthBlocks);
      },
      { timeout: 60_000 }
    );

    this.logger.info(`pons_v2 trade tick: processed blocks ${fromBlock}-${toBlock} across ${poolIds.length} pool(s) in ${poolIdChunks.length} chunk(s), ${trades.length} trade(s) recorded.`);
    return { status: "PROCESSED", fromBlock, toBlock, tradesRecorded: trades.length, poolsQueried: poolIds.length, rpcLogCalls: poolIdChunks.length };
  }

  private wakeable: WakeableLoop | null = null;
  wake(): void { this.wakeable?.wake(); }
  start(): void {
    if (this.wakeable) return;
    this.stopping = false;
    this.wakeable = new WakeableLoop(async () => {
      let result: TradeV2TickResult | undefined;
      this.currentTick = (async () => {
        try { result = await this.runOnce(); }
        catch (err) { this.logger.error(`pons_v2 trade tick failed: ${err instanceof Error ? err.message : String(err)}`); }
      })();
      await this.currentTick;
      return { delay: nextTickDelayMs({ processedWidth: processedWidth(result), maxRangePerPoll: this.config.maxBlockRangePerPoll, pollIntervalMs: this.config.pollIntervalMs }),
        failed: !result || result.status === "UNAVAILABLE" };
    });
    this.wakeable.start();
  }

  stop(): void {
    this.wakeable?.stop();
    this.wakeable = null;
    this.stopping = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async waitForIdle(): Promise<void> {
    await this.currentTick;
  }
}
