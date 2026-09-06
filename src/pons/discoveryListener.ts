/**
 * Phase 7B.4 §4.3/§4.5/§4.8 — Pons discovery listener.
 *
 * Polls eth_getLogs for TokenLaunched on the ACTIVE factory only (legacy
 * factory backfill is explicitly out of scope for this phase). No side
 * effects at import time (src/forensics/forensicsWorker.ts precedent) —
 * only a class; a caller must construct it and call .start().
 *
 * runOnce() is the whole unit of work for one tick and is exported/testable
 * independent of the timer loop, mirroring forensicsWorker's separation of
 * "one unit of work" from "the loop that repeats it."
 */

import type { PrismaClient } from "@prisma/client";
import { decodeEventLog, getAbiItem } from "viem";
import { ChainReader } from "./chainClient";
import { RobinhoodChainConfig } from "./config";
import { CheckpointStore } from "./checkpointStore";
import { ponsAdapter, RawEvmLog, PonsLaunchEnrichment } from "./ponsAdapter";
import { PONS_FACTORY_ABI } from "./abi";
import { NormalizedTokenDiscovered } from "../discovery/types";

export const DISCOVERY_CHECKPOINT_SOURCE = "robinhood:pons:discovery";

const TOKEN_LAUNCHED_EVENT_NAME = "TokenLaunched" as const;

export type DiscoveryTickResult =
  | { status: "UP_TO_DATE"; safeTip: bigint }
  | { status: "PROCESSED"; fromBlock: bigint; toBlock: bigint; tokensDiscovered: number }
  | { status: "UNAVAILABLE"; reason: string }
  | { status: "REORG_DETECTED"; atHeight: bigint; expectedHash: string; actualHash: string };

export interface DiscoveryListenerLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

const noopLogger: DiscoveryListenerLogger = { info: () => {}, warn: () => {}, error: () => {} };

export interface DiscoveryListenerDeps {
  chainClient: ChainReader;
  db: PrismaClient;
  config: RobinhoodChainConfig;
  logger?: DiscoveryListenerLogger;
}

function peekTokenAddress(log: RawEvmLog): string | null {
  try {
    const decoded = decodeEventLog({
      abi: PONS_FACTORY_ABI,
      eventName: TOKEN_LAUNCHED_EVENT_NAME,
      topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      data: log.data,
    });
    return (decoded.args as { token: string }).token;
  } catch {
    return null;
  }
}

export class DiscoveryListener {
  private readonly chainClient: ChainReader;
  private readonly db: PrismaClient;
  private readonly config: RobinhoodChainConfig;
  private readonly logger: DiscoveryListenerLogger;
  private stopping = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(deps: DiscoveryListenerDeps) {
    this.chainClient = deps.chainClient;
    this.db = deps.db;
    this.config = deps.config;
    this.logger = deps.logger ?? noopLogger;
  }

  /** One full unit of work. Never throws — every failure mode is a typed result. */
  async runOnce(): Promise<DiscoveryTickResult> {
    const latestResult = await this.chainClient.getBlockNumber();
    if (latestResult.status === "UNAVAILABLE") {
      return { status: "UNAVAILABLE", reason: `getBlockNumber: ${latestResult.reason}` };
    }
    const safeTip = latestResult.data - BigInt(this.config.confirmationLagBlocks);
    if (safeTip < 0n) {
      return { status: "UP_TO_DATE", safeTip: 0n };
    }

    const checkpointStore = new CheckpointStore(this.db);
    const checkpoint = await checkpointStore.get(DISCOVERY_CHECKPOINT_SOURCE);

    if (checkpoint) {
      // §4.8 reorg awareness: re-fetch the block we last committed at and
      // compare its hash. A mismatch means the chain reorganized at or
      // before our checkpoint. Full automatic reconciliation (rolling back
      // affected rows and reprocessing) is explicitly DEFERRED for this
      // slice — we only detect and halt, loudly, rather than silently
      // ingesting on top of a state that may no longer be canonical.
      const checkpointBlock = await this.chainClient.getBlockRef(checkpoint.lastHeight);
      if (checkpointBlock.status === "UNAVAILABLE") {
        return { status: "UNAVAILABLE", reason: `reorg check getBlockRef: ${checkpointBlock.reason}` };
      }
      if (checkpointBlock.data.hash.toLowerCase() !== checkpoint.lastHash.toLowerCase()) {
        this.logger.error(
          `REORG DETECTED at height ${checkpoint.lastHeight}: expected hash ${checkpoint.lastHash}, chain now reports ${checkpointBlock.data.hash}. Halting discovery ingestion — automatic reconciliation is deferred (phase7b4.txt §4.8).`
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
          this.logger.warn(
            `No discovery checkpoint found — starting fresh at height ${start > 0n ? start : 0n} (${this.config.freshStartLookbackBlocks} blocks behind tip). Historical backfill from factory activation is explicitly out of scope for this phase.`
          );
          return start > 0n ? start : 0n;
        })();

    if (fromBlock > safeTip) {
      return { status: "UP_TO_DATE", safeTip };
    }

    const toBlock = (() => {
      const maxRange = BigInt(this.config.maxBlockRangePerPoll);
      const candidate = fromBlock + maxRange - 1n;
      return candidate < safeTip ? candidate : safeTip;
    })();

    // Resolved from the ABI at call time (not a hand-copied hex literal) —
    // still filters server-side to just TokenLaunched, skipping
    // TokenDeployed and any other factory event.
    const tokenLaunchedEvent = getAbiItem({ abi: PONS_FACTORY_ABI, name: TOKEN_LAUNCHED_EVENT_NAME });

    const logsResult = await this.chainClient.getLogs({
      address: this.config.factoryAddress,
      event: tokenLaunchedEvent,
      fromBlock,
      toBlock,
    });
    if (logsResult.status === "UNAVAILABLE") {
      return { status: "UNAVAILABLE", reason: `getLogs: ${logsResult.reason}` };
    }

    const discovered: Array<{ normalized: NormalizedTokenDiscovered; enrichment: PonsLaunchEnrichment }> = [];
    for (const log of logsResult.data) {
      const tokenAddress = peekTokenAddress(log);
      if (!tokenAddress) continue; // not a TokenLaunched log (e.g. TokenDeployed, same factory) — skip, not an error

      const enrichmentResult = await this.chainClient.readContract<{
        supply: bigint;
        isToken0: boolean;
        poolFee: number;
      }>({
        address: this.config.factoryAddress,
        abi: PONS_FACTORY_ABI,
        functionName: "getLaunchedToken",
        args: [tokenAddress],
      });
      if (enrichmentResult.status === "UNAVAILABLE") {
        // Abort the whole tick rather than partially persist: the checkpoint
        // stays put, so the next tick retries this exact range from
        // scratch. Idempotent upserts make that safe.
        return { status: "UNAVAILABLE", reason: `getLaunchedToken(${tokenAddress}): ${enrichmentResult.reason}` };
      }

      const enrichment: PonsLaunchEnrichment = {
        supply: enrichmentResult.data.supply,
        isToken0: enrichmentResult.data.isToken0,
        poolFee: enrichmentResult.data.poolFee,
      };
      const normalized = ponsAdapter.decodeTokenDiscovered({ log, enrichment });
      if (normalized) discovered.push({ normalized, enrichment });
    }

    const toBlockRef = await this.chainClient.getBlockRef(toBlock);
    if (toBlockRef.status === "UNAVAILABLE") {
      return { status: "UNAVAILABLE", reason: `getBlockRef(toBlock): ${toBlockRef.reason}` };
    }

    await this.db.$transaction(async (tx) => {
      for (const { normalized: token, enrichment } of discovered) {
        // Normalize EVM addresses to lowercase before they ever reach
        // Postgres — Postgres TEXT equality is case-sensitive, but viem's
        // decoder returns EIP-55 checksummed (mixed-case) addresses, and
        // route lookups normalize via assetResolver's .toLowerCase(). A
        // mismatch here would make @@unique([chain, tokenAddress]) silently
        // stop deduplicating the same token decoded with different casing.
        const tokenAddress = token.tokenAddress.toLowerCase();
        const deployer = token.deployer.toLowerCase();
        const poolAddress = token.poolAddress?.toLowerCase() ?? null;
        const quoteAddress = token.quoteAddress.toLowerCase();
        await tx.discoveredToken.upsert({
          where: { chain_tokenAddress: { chain: token.chain, tokenAddress } },
          create: {
            chain: token.chain,
            venue: token.venue,
            tokenAddress,
            deployer,
            poolAddress,
            quoteAddress,
            supply: token.supply,
            initialBuyAmount: token.initialBuyAmount,
            isToken0: enrichment.isToken0,
            poolFee: enrichment.poolFee,
            sourceHeight: BigInt(token.provenance.sourceHeight),
            sourceHash: token.provenance.sourceHash,
            sourceTxHash: token.provenance.sourceTxHash,
            sourceIndex: token.provenance.sourceIndex,
            observedAt: new Date(token.observedAt),
          },
          update: {}, // idempotent no-op on replay — discovery facts never change after the fact
        });
      }
      const checkpointStoreTx = new CheckpointStore(tx);
      await checkpointStoreTx.set(DISCOVERY_CHECKPOINT_SOURCE, { lastHeight: toBlock, lastHash: toBlockRef.data.hash });
    });

    this.logger.info(`Discovery tick: processed blocks ${fromBlock}-${toBlock}, ${discovered.length} token(s) discovered.`);
    return { status: "PROCESSED", fromBlock, toBlock, tokensDiscovered: discovered.length };
  }

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    const tick = async () => {
      if (this.stopping) return;
      try {
        await this.runOnce();
      } catch (err) {
        this.logger.error(`Discovery listener tick threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
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
