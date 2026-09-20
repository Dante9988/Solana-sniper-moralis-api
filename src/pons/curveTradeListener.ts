/**
 * Phase 7D.4 §3 — Pons V2 bonding-curve trades (pre-graduation).
 *
 * Until now only graduated tokens' Uniswap V4 swaps were ingested (tradeV2Listener.ts), so every
 * token still on its curve — most of them — had no trades, volume or candles at all.
 *
 * Each launch has its own PonsV2BondingCurve, so listing emitters in eth_getLogs is not
 * practical. The query is by event topic only (CurveBuy, CurveSell) and every log is then
 * accepted only if its emitter is the curve the factory registered for a discovered token
 * (DiscoveredToken.curveAddress, taken from TokenLaunched). Any contract can emit a look-alike
 * event; those are counted and dropped, never stored. So are real curves whose launch predates this
 * database's discovery history — until discovery is backfilled, their trades are not ingested.
 *
 * Same checkpoint / reorg / discovery-before-trades discipline as tradeV2Listener.ts, barriered
 * against the V2 discovery checkpoint so a trade is never recorded for a curve discovery has not
 * yet seen. A fresh start begins at the first V2 launch this database knows (or
 * PONS_CURVE_TRADES_START_HEIGHT), not at the tip, so history is complete back to discovery.
 */

import type { PrismaClient } from "@prisma/client";
import { nextTickDelayMs, processedWidth } from "./tickPacing";
import { isRangeLimitMessage } from "./rpcEndpoints";

import type { ChainReader, EventLogReader } from "./chainClient";
import type { RobinhoodChainConfig } from "./config";
import { CheckpointStore, recordChainBlockCheckpoint } from "./checkpointStore";
import { PONS_V2_CURVE_ABI } from "./abiV2";
import { ponsV2Adapter, type NormalizedCurveTrade } from "./ponsV2Adapter";
import { mapWithConcurrency } from "./concurrency";
import { attemptReorgRecovery } from "./reorgRecovery";
import { ROBINHOOD_CHAIN } from "./discoveryListener";
import { DISCOVERY_V2_CHECKPOINT_SOURCE } from "./discoveryV2Listener";

export const CURVE_TRADE_CHECKPOINT_SOURCE = "robinhood:pons_v2:curve-trades";
const VENUE = "pons_v2" as const;

export type CurveTradeTickResult =
  | { status: "UP_TO_DATE"; safeTip: bigint }
  | { status: "NO_CURVES_KNOWN" }
  | { status: "WAITING_ON_DISCOVERY"; reason: string }
  | { status: "PROCESSED"; fromBlock: bigint; toBlock: bigint; tradesRecorded: number; foreignLogsDropped: number }
  | { status: "UNAVAILABLE"; reason: string }
  | { status: "REORG_RECOVERED"; ancestorHeight: bigint }
  | { status: "REORG_UNRESOLVED"; reason: string };

export interface CurveTradeListenerLogger {
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
}

const noopLogger: CurveTradeListenerLogger = { info: () => {}, warn: () => {}, error: () => {} };

export interface CurveTradeListenerDeps {
  chainClient: ChainReader & EventLogReader;
  db: PrismaClient;
  config: RobinhoodChainConfig;
  /** First block to scan when no checkpoint exists. Defaults to the earliest known V2 launch. */
  startHeight?: bigint;
  /** Widest log window per tick (PONS_CURVE_TRADES_MAX_RANGE); defaults to PONS_MAX_BLOCK_RANGE_PER_POLL. */
  maxRange?: number;
  logger?: CurveTradeListenerLogger;
}

interface CurveInfo {
  tokenAddress: string;
  quoteAddress: string;
}

/** Keep only logs from registered curves, decoded. Pure, so the emitter rule is directly testable. */
export function selectCurveTrades(logs: Parameters<typeof ponsV2Adapter.decodeCurveTrade>[0]["log"][], curves: ReadonlyMap<string, CurveInfo>): { trades: NormalizedCurveTrade[]; foreign: number } {
  const trades: NormalizedCurveTrade[] = [];
  let foreign = 0;
  for (const log of logs) {
    const curve = curves.get(log.address.toLowerCase());
    if (!curve) {
      foreign += 1;
      continue;
    }
    const trade = ponsV2Adapter.decodeCurveTrade({ log, tokenAddress: curve.tokenAddress, curveAddress: log.address, quoteAddress: curve.quoteAddress });
    if (trade) trades.push(trade);
  }
  return { trades, foreign };
}

/**
 * How a failed `getLogs` should affect the window width.
 *
 * Phase 7D.5. The previous single boolean counted a bare "Request failed" — viem's
 * wording for *any* non-2xx — and any timeout as proof the window was too wide. Measured
 * on 2026-09-19 the window collapsed 1875 → 10 blocks and stayed pinned at the floor, so
 * curve-trade ingestion advanced ~35 blocks/s against a 6.3M-block backlog while the
 * provider was in fact happily serving 10,000-block windows at ~3,000 blocks/s.
 *
 * - `RANGE`  the provider named a range/result cap. Hard evidence: shrink and remember.
 * - `SOFT`   a timeout or cross-provider deadline. A window that is too wide can cause
 *            this, but so can congestion — shrink to make progress, remember nothing.
 * - `NONE`   rate limits, cooldowns, no usable endpoint, transport faults. Nothing to do
 *            with width: keep the window and let failover/backoff handle it.
 */
/** Never narrow below this: a 10-block window is the Alchemy free-tier cap, not a useful working width. */
const MIN_RANGE = 10n;
/** Clean ticks required before a remembered range cap is forgotten. */
const CEILING_SUCCESSES = 20;

export type WindowFailureKind = "RANGE" | "SOFT" | "NONE";

export function classifyWindowFailure(reason: string): WindowFailureKind {
  /**
   * "No capable endpoint *right now*" is transient, and stalling on it is worse than
   * narrowing. Measured 2026-09-19: once this case was excluded from narrowing entirely,
   * curve-trade ingestion made zero progress for 11 minutes — the wide-range endpoint was
   * being cooled down by timeouts under contention from the two discovery loops, leaving
   * only 10-block-capped keys, and the listener kept asking them for 10,000 blocks.
   *
   * SOFT is the right answer: squeeze through at a smaller width, remember no ceiling, and
   * spring straight back to full width on the first clean tick. A missing *configuration*
   * is a different thing and still narrows nothing.
   */
  if (/no usable RPC endpoint is configured/i.test(reason)) return "NONE";
  if (/no usable RPC endpoint for this request right now/i.test(reason)) return "SOFT";
  if (/rate.?limit|429|too many requests|quota|cool/i.test(reason)) return "NONE";
  if (isRangeLimitMessage(reason)) return "RANGE";
  if (/timeout|timed out|deadline/i.test(reason)) return "SOFT";
  return "NONE";
}

export class CurveTradeListener {
  private readonly chainClient: ChainReader & EventLogReader;
  private readonly db: PrismaClient;
  private readonly config: RobinhoodChainConfig;
  private readonly startHeight?: bigint;
  private readonly logger: CurveTradeListenerLogger;
  private stopping = false;
  private timer: NodeJS.Timeout | null = null;
  private currentTick: Promise<void> = Promise.resolve();
  /** Phase 7D.4 — adaptive log range: halves when a provider refuses a range, grows back on success. */
  private readonly maxRange: bigint;
  private range: bigint;
  /** After a window of this width failed, growth stops just below it for a while. */
  private ceiling: { width: bigint; successesLeft: number } | null = null;
  /** Block refs survive failed ticks, so a retry resumes instead of re-reading every block. */
  private readonly blockRefs = new Map<string, { hash: string; timestamp: bigint }>();

  constructor(deps: CurveTradeListenerDeps) {
    this.chainClient = deps.chainClient;
    this.db = deps.db;
    this.config = deps.config;
    this.startHeight = deps.startHeight;
    this.logger = deps.logger ?? noopLogger;
    this.maxRange = BigInt(deps.maxRange ?? this.config.maxBlockRangePerPoll);
    this.range = this.maxRange;
  }

  private rememberBlock(height: string, ref: { hash: string; timestamp: bigint }) {
    if (this.blockRefs.size >= 20_000) this.blockRefs.delete(this.blockRefs.keys().next().value as string);
    this.blockRefs.set(height, ref);
  }

  async runOnce(): Promise<CurveTradeTickResult> {
    const checkpointStore = new CheckpointStore(this.db);

    const latestResult = await this.chainClient.getBlockNumber();
    if (latestResult.status === "UNAVAILABLE") {
      await checkpointStore.recordFailure(CURVE_TRADE_CHECKPOINT_SOURCE, `getBlockNumber: ${latestResult.reason}`);
      return { status: "UNAVAILABLE", reason: `getBlockNumber: ${latestResult.reason}` };
    }
    const observedChainHeight = latestResult.data;
    const safeTip = observedChainHeight - BigInt(this.config.confirmationLagBlocks);
    if (safeTip < 0n) return { status: "UP_TO_DATE", safeTip: 0n };

    const checkpoint = await checkpointStore.get(CURVE_TRADE_CHECKPOINT_SOURCE);
    if (checkpoint) {
      const checkpointBlock = await this.chainClient.getBlockRef(checkpoint.lastHeight);
      if (checkpointBlock.status === "UNAVAILABLE") {
        await checkpointStore.recordFailure(CURVE_TRADE_CHECKPOINT_SOURCE, `reorg check getBlockRef: ${checkpointBlock.reason}`);
        return { status: "UNAVAILABLE", reason: `reorg check getBlockRef: ${checkpointBlock.reason}` };
      }
      if (checkpointBlock.data.hash.toLowerCase() !== checkpoint.lastHash.toLowerCase()) {
        this.logger.error(`reorg detected (pons_v2 curve trades) at height ${checkpoint.lastHeight}. Attempting bounded recovery.`);
        const recovery = await attemptReorgRecovery({ chainClient: this.chainClient, db: this.db, chain: ROBINHOOD_CHAIN });
        if (recovery.status === "UNAVAILABLE") {
          await checkpointStore.recordFailure(CURVE_TRADE_CHECKPOINT_SOURCE, `reorg recovery unavailable: ${recovery.reason}`);
          return { status: "UNAVAILABLE", reason: `reorg recovery: ${recovery.reason}` };
        }
        if (recovery.status === "UNRESOLVED") {
          await checkpointStore.markReorgUnresolved(CURVE_TRADE_CHECKPOINT_SOURCE, recovery.reason);
          return { status: "REORG_UNRESOLVED", reason: recovery.reason };
        }
        return { status: "REORG_RECOVERED", ancestorHeight: recovery.ancestorHeight };
      }
    }

    const discoveryCheckpoint = await checkpointStore.get(DISCOVERY_V2_CHECKPOINT_SOURCE);
    if (!discoveryCheckpoint) {
      return { status: "WAITING_ON_DISCOVERY", reason: "no pons_v2 discovery checkpoint yet" };
    }
    const barrierHeight = discoveryCheckpoint.lastHeight;

    let fromBlock: bigint;
    if (checkpoint) {
      fromBlock = checkpoint.lastHeight + 1n;
    } else {
      const earliest = this.startHeight ?? (await this.earliestLaunchHeight());
      if (earliest === null) return { status: "NO_CURVES_KNOWN" };
      fromBlock = earliest;
      this.logger.warn(`No curve-trade checkpoint found — starting at height ${fromBlock} (earliest known Pons V2 launch).`);
    }

    const effectiveTip = safeTip < barrierHeight ? safeTip : barrierHeight;
    if (fromBlock > effectiveTip) {
      if (checkpoint) await checkpointStore.recordUpToDate(CURVE_TRADE_CHECKPOINT_SOURCE, observedChainHeight);
      return barrierHeight < safeTip
        ? { status: "WAITING_ON_DISCOVERY", reason: `barrier height ${barrierHeight} (pons_v2 discovery checkpoint) is behind the next block to scan` }
        : { status: "UP_TO_DATE", safeTip: effectiveTip };
    }
    const toBlock = (() => {
      const candidate = fromBlock + this.range - 1n;
      return candidate < effectiveTip ? candidate : effectiveTip;
    })();

    const logsResult = await this.chainClient.getLogsByEvents({ events: PONS_V2_CURVE_ABI, fromBlock, toBlock });
    if (logsResult.status === "UNAVAILABLE") {
      // A window too large for the provider (result cap, response size, timeout) is retried smaller.
      // Rate limits and cooled-down endpoints are not about size: wait, keep the window.
      const width = toBlock - fromBlock + 1n;
      const kind = classifyWindowFailure(logsResult.reason);
      if (kind !== "NONE") {
        const next = width / 2n;
        this.range = next < MIN_RANGE ? MIN_RANGE : next;
        // Only hard evidence installs a ceiling. A ceiling must also never sit below the
        // width we just dropped to, or `range < cap` is false forever and the window is
        // pinned at the floor until 20 clean ticks happen to occur — which is exactly how
        // this listener got stuck at 10 blocks.
        if (kind === "RANGE") {
          const remembered = (width * 3n) / 4n;
          this.ceiling = { width: remembered > this.range ? remembered : this.range, successesLeft: CEILING_SUCCESSES };
        }
        this.logger.warn(
          `curve-trade log window ${width} → ${this.range} blocks after a ${kind === "RANGE" ? "provider range cap" : "timeout"}: ${logsResult.reason.slice(0, 160)}`
        );
      }
      await checkpointStore.recordFailure(CURVE_TRADE_CHECKPOINT_SOURCE, `getLogs(CurveBuy|CurveSell) over ${toBlock - fromBlock + 1n} blocks: ${logsResult.reason}`);
      return { status: "UNAVAILABLE", reason: `getLogs: ${logsResult.reason}` };
    }

    const curves = await this.loadCurves([...new Set(logsResult.data.map((l) => l.address.toLowerCase()))]);
    const { trades, foreign } = selectCurveTrades(logsResult.data, curves);
    // Not proof of spoofing: a real curve whose launch predates this database's discovery history is
    // indistinguishable here from a look-alike, and both are dropped. Backfilling discovery is the fix.
    if (foreign > 0) this.logger.info(`dropped ${foreign} curve-trade-shaped log(s) whose emitter is not the curve of any discovered token (blocks ${fromBlock}-${toBlock}).`);

    const toBlockRef = await this.chainClient.getBlockRef(toBlock);
    if (toBlockRef.status === "UNAVAILABLE") {
      await checkpointStore.recordFailure(CURVE_TRADE_CHECKPOINT_SOURCE, `getBlockRef(toBlock): ${toBlockRef.reason}`);
      return { status: "UNAVAILABLE", reason: `getBlockRef(toBlock): ${toBlockRef.reason}` };
    }
    const timestamps = new Map<string, Date>([[toBlock.toString(), new Date(Number(toBlockRef.data.timestamp) * 1000)]]);
    // Phase 7D.4 — a log that carries its block's timestamp needs no block read. All logs of one
    // block must agree on hash and timestamp; any disagreement fails the tick closed.
    const fromLogs = new Map<string, { hash: string; timestamp: bigint }>();
    for (const log of logsResult.data) {
      if (log.blockTimestamp === null || log.blockTimestamp === undefined) continue;
      const h = log.blockNumber.toString();
      const seen = fromLogs.get(h);
      if (seen && (seen.hash.toLowerCase() !== log.blockHash.toLowerCase() || seen.timestamp !== log.blockTimestamp)) {
        await checkpointStore.recordFailure(CURVE_TRADE_CHECKPOINT_SOURCE, `logs disagree about block ${h}`);
        return { status: "UNAVAILABLE", reason: `logs disagree about block ${h}` };
      }
      fromLogs.set(h, { hash: log.blockHash, timestamp: log.blockTimestamp });
    }
    for (const [h, ref] of fromLogs) if (!timestamps.has(h)) timestamps.set(h, new Date(Number(ref.timestamp) * 1000));
    const heights = [...new Set(trades.map((t) => t.provenance.sourceHeight))].filter((h) => !timestamps.has(h) && !this.blockRefs.has(h));
    const refs = await mapWithConcurrency(heights, this.config.tradeQueryConcurrency, (h) => this.chainClient.getBlockRef(BigInt(h)));
    for (let i = 0; i < heights.length; i++) {
      const outcome = refs[i];
      if (outcome.status === "fulfilled" && outcome.value.status === "AVAILABLE") this.rememberBlock(heights[i], { hash: outcome.value.data.hash, timestamp: outcome.value.data.timestamp });
    }
    for (const trade of trades) {
      const h = trade.provenance.sourceHeight;
      if (timestamps.has(h)) continue;
      const ref = this.blockRefs.get(h);
      if (!ref) {
        await checkpointStore.recordFailure(CURVE_TRADE_CHECKPOINT_SOURCE, `getBlockRef(timestamp @ ${h}) unavailable`);
        return { status: "UNAVAILABLE", reason: `getBlockRef(timestamp @ ${h}) unavailable` };
      }
      // Trade rows must carry the block's own hash; a mismatch means the logs and the block came from different forks.
      if (ref.hash.toLowerCase() !== trade.provenance.sourceHash.toLowerCase()) {
        this.blockRefs.delete(h);
        await checkpointStore.recordFailure(CURVE_TRADE_CHECKPOINT_SOURCE, `block hash mismatch at ${h} between log and block reads`);
        return { status: "UNAVAILABLE", reason: `block hash mismatch at ${h}` };
      }
      timestamps.set(h, new Date(Number(ref.timestamp) * 1000));
    }

    await this.db.$transaction(
      async (tx) => {
        for (const trade of trades) {
          const sourceTimestamp = timestamps.get(trade.provenance.sourceHeight) ?? null;
          await tx.chainTrade.upsert({
            where: { chain_sourceTxHash_sourceIndex: { chain: trade.chain, sourceTxHash: trade.provenance.sourceTxHash, sourceIndex: trade.provenance.sourceIndex } },
            create: {
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
              observedAt: new Date(trade.observedAt),
              sourceTimestamp,
            },
            update: { canonicalStatus: "CANONICAL", orphanedAt: null, sourceTimestamp },
          });
        }
        await new CheckpointStore(tx).set(CURVE_TRADE_CHECKPOINT_SOURCE, { lastHeight: toBlock, lastHash: toBlockRef.data.hash }, observedChainHeight, timestamps.get(toBlock.toString()));
        await recordChainBlockCheckpoint(tx, ROBINHOOD_CHAIN, toBlock, toBlockRef.data.hash, this.config.reorgMaxDepthBlocks);
      },
      { timeout: 60_000 }
    );

    for (const h of timestamps.keys()) this.blockRefs.delete(h);
    if (this.ceiling && --this.ceiling.successesLeft <= 0) this.ceiling = null;
    const cap = this.ceiling && this.ceiling.width < this.maxRange ? this.ceiling.width : this.maxRange;
    if (this.range < cap) {
      const grown = this.range * 2n > cap ? cap : this.range * 2n;
      if (grown !== this.range) {
        this.range = grown;
        this.logger.info(`curve-trade log window grew to ${this.range} blocks (cap ${cap}).`);
      }
    }
    this.logger.info(`pons_v2 curve trade tick: processed blocks ${fromBlock}-${toBlock}, ${trades.length} trade(s) recorded, ${foreign} foreign log(s) dropped.`);
    return { status: "PROCESSED", fromBlock, toBlock, tradesRecorded: trades.length, foreignLogsDropped: foreign };
  }

  private async earliestLaunchHeight(): Promise<bigint | null> {
    const row = await this.db.discoveredToken.findFirst({
      where: { chain: ROBINHOOD_CHAIN, venue: VENUE, canonicalStatus: "CANONICAL", curveAddress: { not: null } },
      orderBy: { sourceHeight: "asc" },
      select: { sourceHeight: true },
    });
    return row ? row.sourceHeight : null;
  }

  private async loadCurves(addresses: string[]): Promise<Map<string, CurveInfo>> {
    if (addresses.length === 0) return new Map();
    // Stored addresses are not guaranteed lowercase; compare case-insensitively.
    const rows = await this.db.$queryRaw<Array<{ curveAddress: string; tokenAddress: string; quoteAddress: string }>>`
      SELECT "curveAddress", "tokenAddress", "quoteAddress" FROM "DiscoveredToken"
      WHERE chain = ${ROBINHOOD_CHAIN} AND venue = ${VENUE} AND "canonicalStatus" = 'CANONICAL'
        AND lower("curveAddress") = ANY(${addresses})`;
    return new Map(rows.map((r) => [r.curveAddress.toLowerCase(), { tokenAddress: r.tokenAddress, quoteAddress: r.quoteAddress }]));
  }

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    const tick = async () => {
      if (this.stopping) return;
      let result: CurveTradeTickResult | undefined;
      this.currentTick = (async () => {
        try {
          result = await this.runOnce();
        } catch (err) {
          this.logger.error(`pons_v2 curve trade tick threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
      await this.currentTick;
      if (!this.stopping)
        this.timer = setTimeout(
          tick,
          nextTickDelayMs({ processedWidth: processedWidth(result), maxRangePerPoll: Number(this.range), pollIntervalMs: this.config.pollIntervalMs })
        );
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

  async waitForIdle(): Promise<void> {
    await this.currentTick;
  }
}
