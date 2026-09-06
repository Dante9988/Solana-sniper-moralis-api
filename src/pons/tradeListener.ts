/**
 * Phase 7B.4 §4.4/§4.5/§4.8 — Pons trade listener.
 *
 * Polls eth_getLogs for Swap across every pool address the discovery
 * listener has recorded. Candle/OHLCV aggregation is explicitly out of
 * scope for this phase — this only persists raw, deduplicated trades.
 */

import type { PrismaClient } from "@prisma/client";
import { getAbiItem } from "viem";
import { ChainReader } from "./chainClient";
import { RobinhoodChainConfig } from "./config";
import { CheckpointStore } from "./checkpointStore";
import { ponsAdapter } from "./ponsAdapter";
import { UNISWAP_V3_POOL_ABI } from "./abi";
import { NormalizedTradeExecuted } from "../discovery/types";

export const TRADE_CHECKPOINT_SOURCE = "robinhood:pons:trades";

const SWAP_EVENT_NAME = "Swap" as const;

export type TradeTickResult =
  | { status: "UP_TO_DATE"; safeTip: bigint }
  | { status: "NO_POOLS_TRACKED" }
  | { status: "PROCESSED"; fromBlock: bigint; toBlock: bigint; tradesRecorded: number }
  | { status: "UNAVAILABLE"; reason: string }
  | { status: "REORG_DETECTED"; atHeight: bigint; expectedHash: string; actualHash: string };

export interface TradeListenerLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
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

  constructor(deps: TradeListenerDeps) {
    this.chainClient = deps.chainClient;
    this.db = deps.db;
    this.config = deps.config;
    this.logger = deps.logger ?? noopLogger;
  }

  async runOnce(): Promise<TradeTickResult> {
    const trackedTokens = await this.db.discoveredToken.findMany({
      where: { chain: "robinhood", poolAddress: { not: null } },
      select: { tokenAddress: true, poolAddress: true, quoteAddress: true, isToken0: true },
    });
    if (trackedTokens.length === 0) {
      return { status: "NO_POOLS_TRACKED" };
    }
    const byPool = new Map(trackedTokens.map((t) => [t.poolAddress!.toLowerCase(), t]));
    const poolAddresses = [...byPool.keys()];

    const latestResult = await this.chainClient.getBlockNumber();
    if (latestResult.status === "UNAVAILABLE") {
      return { status: "UNAVAILABLE", reason: `getBlockNumber: ${latestResult.reason}` };
    }
    const safeTip = latestResult.data - BigInt(this.config.confirmationLagBlocks);
    if (safeTip < 0n) return { status: "UP_TO_DATE", safeTip: 0n };

    const checkpointStore = new CheckpointStore(this.db);
    const checkpoint = await checkpointStore.get(TRADE_CHECKPOINT_SOURCE);

    if (checkpoint) {
      // §4.8 — same detect-and-halt discipline as the discovery listener;
      // see discoveryListener.ts for the full rationale.
      const checkpointBlock = await this.chainClient.getBlockRef(checkpoint.lastHeight);
      if (checkpointBlock.status === "UNAVAILABLE") {
        return { status: "UNAVAILABLE", reason: `reorg check getBlockRef: ${checkpointBlock.reason}` };
      }
      if (checkpointBlock.data.hash.toLowerCase() !== checkpoint.lastHash.toLowerCase()) {
        this.logger.error(
          `REORG DETECTED (trades) at height ${checkpoint.lastHeight}: expected ${checkpoint.lastHash}, chain now reports ${checkpointBlock.data.hash}. Halting — automatic reconciliation is deferred (phase7b4.txt §4.8).`
        );
        return {
          status: "REORG_DETECTED",
          atHeight: checkpoint.lastHeight,
          expectedHash: checkpoint.lastHash,
          actualHash: checkpointBlock.data.hash,
        };
      }
    }

    const fromBlock = checkpoint
      ? checkpoint.lastHeight + 1n
      : (() => {
          const lookback = BigInt(this.config.freshStartLookbackBlocks);
          const start = safeTip - lookback + 1n;
          this.logger.warn(`No trade checkpoint found — starting fresh at height ${start > 0n ? start : 0n}.`);
          return start > 0n ? start : 0n;
        })();

    if (fromBlock > safeTip) return { status: "UP_TO_DATE", safeTip };

    const toBlock = (() => {
      const maxRange = BigInt(this.config.maxBlockRangePerPoll);
      const candidate = fromBlock + maxRange - 1n;
      return candidate < safeTip ? candidate : safeTip;
    })();

    const swapEvent = getAbiItem({ abi: UNISWAP_V3_POOL_ABI, name: SWAP_EVENT_NAME });
    const logsResult = await this.chainClient.getLogs({
      address: poolAddresses,
      event: swapEvent,
      fromBlock,
      toBlock,
    });
    if (logsResult.status === "UNAVAILABLE") {
      return { status: "UNAVAILABLE", reason: `getLogs: ${logsResult.reason}` };
    }

    const trades: NormalizedTradeExecuted[] = [];
    for (const log of logsResult.data) {
      const tracked = byPool.get(log.address.toLowerCase());
      if (!tracked) continue; // shouldn't happen (we filtered by these exact addresses), but fail closed rather than guess
      const normalized = ponsAdapter.decodeTrade({
        log,
        tokenAddress: tracked.tokenAddress,
        quoteAddress: tracked.quoteAddress,
        isToken0: tracked.isToken0,
      });
      if (normalized) trades.push(normalized);
    }

    const toBlockRef = await this.chainClient.getBlockRef(toBlock);
    if (toBlockRef.status === "UNAVAILABLE") {
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
          update: {}, // idempotent no-op on replay
        });
      }
      const checkpointStoreTx = new CheckpointStore(tx);
      await checkpointStoreTx.set(TRADE_CHECKPOINT_SOURCE, { lastHeight: toBlock, lastHash: toBlockRef.data.hash });
    });

    this.logger.info(`Trade tick: processed blocks ${fromBlock}-${toBlock} across ${poolAddresses.length} pool(s), ${trades.length} trade(s) recorded.`);
    return { status: "PROCESSED", fromBlock, toBlock, tradesRecorded: trades.length };
  }

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    const tick = async () => {
      if (this.stopping) return;
      try {
        await this.runOnce();
      } catch (err) {
        this.logger.error(`Trade listener tick threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
      }
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
}
