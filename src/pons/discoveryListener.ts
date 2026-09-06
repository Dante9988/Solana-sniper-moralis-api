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
 *
 * Phase 7B.5A hardens this with:
 *  - bounded-concurrency batch enrichment instead of one-bad-token-aborts-
 *    the-tick sequential RPC calls (§4);
 *  - PENDING enrichment rows that are retried on later ticks rather than
 *    ever fabricating a fake supply/isToken0/poolFee default (§4/§6);
 *  - real bounded reorg rollback/replay instead of detect-and-halt (§2);
 *  - persisted poll/error/reorg metadata for the source-health projection
 *    (§5).
 */

import type { PrismaClient } from "@prisma/client";
import { decodeEventLog, getAbiItem } from "viem";
import { ChainReader } from "./chainClient";
import { RobinhoodChainConfig } from "./config";
import { CheckpointStore, recordChainBlockCheckpoint } from "./checkpointStore";
import { ponsAdapter, RawEvmLog, PonsLaunchEnrichment } from "./ponsAdapter";
import { PONS_FACTORY_ABI } from "./abi";
import { NormalizedTokenDiscovered } from "../discovery/types";
import { mapWithConcurrency } from "./concurrency";
import { attemptReorgRecovery } from "./reorgRecovery";

export const DISCOVERY_CHECKPOINT_SOURCE = "robinhood:pons:discovery";
export const ROBINHOOD_CHAIN = "robinhood";

const TOKEN_LAUNCHED_EVENT_NAME = "TokenLaunched" as const;

export type DiscoveryTickResult =
  | { status: "UP_TO_DATE"; safeTip: bigint }
  | { status: "PROCESSED"; fromBlock: bigint; toBlock: bigint; tokensDiscovered: number; tokensPendingEnrichment: number; enrichmentRetried: number; enrichmentRetriedRecovered: number }
  | { status: "UNAVAILABLE"; reason: string }
  | { status: "REORG_RECOVERED"; ancestorHeight: bigint }
  | { status: "REORG_UNRESOLVED"; reason: string };

export interface DiscoveryListenerLogger {
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
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

interface EnrichmentOutcome {
  status: "COMPLETE";
  enrichment: PonsLaunchEnrichment;
}
interface EnrichmentFailure {
  status: "FAILED";
  reason: string;
}

export class DiscoveryListener {
  private readonly chainClient: ChainReader;
  private readonly db: PrismaClient;
  private readonly config: RobinhoodChainConfig;
  private readonly logger: DiscoveryListenerLogger;
  private stopping = false;
  private timer: NodeJS.Timeout | null = null;
  /** Phase 7B.5A §7 — tracked so a graceful shutdown can await the in-flight tick (waitForIdle()) rather than disconnecting Prisma mid-transaction. */
  private currentTick: Promise<void> = Promise.resolve();

  constructor(deps: DiscoveryListenerDeps) {
    this.chainClient = deps.chainClient;
    this.db = deps.db;
    this.config = deps.config;
    this.logger = deps.logger ?? noopLogger;
  }

  private async fetchEnrichment(tokenAddress: string): Promise<EnrichmentOutcome | EnrichmentFailure> {
    const result = await this.chainClient.readContract<{ supply: bigint; isToken0: boolean; poolFee: number }>({
      address: this.config.factoryAddress,
      abi: PONS_FACTORY_ABI,
      functionName: "getLaunchedToken",
      args: [tokenAddress],
    });
    if (result.status === "UNAVAILABLE") {
      return { status: "FAILED", reason: `getLaunchedToken(${tokenAddress}): ${result.reason}` };
    }
    return { status: "COMPLETE", enrichment: { supply: result.data.supply, isToken0: result.data.isToken0, poolFee: result.data.poolFee } };
  }

  /** One full unit of work. Never throws — every failure mode is a typed result. */
  async runOnce(): Promise<DiscoveryTickResult> {
    const checkpointStore = new CheckpointStore(this.db);

    const latestResult = await this.chainClient.getBlockNumber();
    if (latestResult.status === "UNAVAILABLE") {
      await checkpointStore.recordFailure(DISCOVERY_CHECKPOINT_SOURCE, `getBlockNumber: ${latestResult.reason}`);
      return { status: "UNAVAILABLE", reason: `getBlockNumber: ${latestResult.reason}` };
    }
    const observedChainHeight = latestResult.data;
    const safeTip = observedChainHeight - BigInt(this.config.confirmationLagBlocks);
    if (safeTip < 0n) {
      await checkpointStore.recordUpToDate(DISCOVERY_CHECKPOINT_SOURCE, observedChainHeight);
      return { status: "UP_TO_DATE", safeTip: 0n };
    }

    const checkpoint = await checkpointStore.get(DISCOVERY_CHECKPOINT_SOURCE);

    if (checkpoint) {
      // §2/§4.8 reorg awareness: re-fetch the block we last committed at
      // and compare its hash. A mismatch means the chain reorganized at or
      // before our checkpoint. Phase 7B.4 only detected and halted here;
      // Phase 7B.5A adds bounded automatic rollback/replay
      // (reorgRecovery.ts) — see that module for the full algorithm.
      const checkpointBlock = await this.chainClient.getBlockRef(checkpoint.lastHeight);
      if (checkpointBlock.status === "UNAVAILABLE") {
        await checkpointStore.recordFailure(DISCOVERY_CHECKPOINT_SOURCE, `reorg check getBlockRef: ${checkpointBlock.reason}`);
        return { status: "UNAVAILABLE", reason: `reorg check getBlockRef: ${checkpointBlock.reason}` };
      }
      if (checkpointBlock.data.hash.toLowerCase() !== checkpoint.lastHash.toLowerCase()) {
        this.logger.error(`reorg detected at height ${checkpoint.lastHeight}: expected hash ${checkpoint.lastHash}, chain now reports ${checkpointBlock.data.hash}. Attempting bounded recovery.`, {
          height: checkpoint.lastHeight.toString(),
        });
        const recovery = await attemptReorgRecovery({ chainClient: this.chainClient, db: this.db, chain: ROBINHOOD_CHAIN });
        if (recovery.status === "UNAVAILABLE") {
          await checkpointStore.recordFailure(DISCOVERY_CHECKPOINT_SOURCE, `reorg recovery unavailable: ${recovery.reason}`);
          return { status: "UNAVAILABLE", reason: `reorg recovery: ${recovery.reason}` };
        }
        if (recovery.status === "UNRESOLVED") {
          this.logger.error(`reorg recovery UNRESOLVED — no common ancestor found within the configured recovery window. Halting discovery ingestion.`, {
            searchedDepth: recovery.searchedDepth,
          });
          await checkpointStore.markReorgUnresolved(DISCOVERY_CHECKPOINT_SOURCE, recovery.reason);
          return { status: "REORG_UNRESOLVED", reason: recovery.reason };
        }
        this.logger.info(`reorg RECOVERED at ancestor height ${recovery.ancestorHeight}: orphaned ${recovery.orphanedTokens} token(s), ${recovery.orphanedTrades} trade(s). Rolled back sources: ${recovery.rolledBackSources.join(", ")}.`);
        return { status: "REORG_RECOVERED", ancestorHeight: recovery.ancestorHeight };
      }
    }

    // §4/§9 — retry any previously-PENDING enrichment before scanning new
    // logs, bounded so a large backlog can't turn one tick into an
    // unbounded RPC burst. This keeps the trade-listener barrier
    // (tradeListener.ts) as tight as possible: every tick that can clear a
    // PENDING row moves the barrier forward.
    let enrichmentRetried = 0;
    let enrichmentRetriedRecovered = 0;
    const pendingRows = await this.db.discoveredToken.findMany({
      where: { chain: ROBINHOOD_CHAIN, canonicalStatus: "CANONICAL", enrichmentStatus: "PENDING" },
      orderBy: { sourceHeight: "asc" },
      take: this.config.enrichmentRetryBatchSize,
      select: { tokenAddress: true },
    });
    if (pendingRows.length > 0) {
      enrichmentRetried = pendingRows.length;
      const outcomes = await mapWithConcurrency(pendingRows, this.config.enrichmentConcurrency, async (row) => ({
        tokenAddress: row.tokenAddress,
        outcome: await this.fetchEnrichment(row.tokenAddress),
      }));
      for (const settled of outcomes) {
        if (settled.status === "rejected") continue; // fetchEnrichment never throws; defensive only
        const { tokenAddress, outcome } = settled.value;
        if (outcome.status === "COMPLETE") {
          await this.db.discoveredToken.update({
            where: { chain_tokenAddress: { chain: ROBINHOOD_CHAIN, tokenAddress } },
            data: {
              supply: outcome.enrichment.supply.toString(),
              isToken0: outcome.enrichment.isToken0,
              poolFee: outcome.enrichment.poolFee,
              enrichmentStatus: "COMPLETE",
              lastEnrichmentAttemptAt: new Date(),
              lastEnrichmentError: null,
            },
          });
          enrichmentRetriedRecovered += 1;
        } else {
          await this.db.discoveredToken.update({
            where: { chain_tokenAddress: { chain: ROBINHOOD_CHAIN, tokenAddress } },
            data: { enrichmentAttempts: { increment: 1 }, lastEnrichmentAttemptAt: new Date(), lastEnrichmentError: outcome.reason },
          });
          this.logger.warn(`enrichment retry failed for ${tokenAddress}: ${outcome.reason}`);
        }
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
      await checkpointStore.recordUpToDate(DISCOVERY_CHECKPOINT_SOURCE, observedChainHeight);
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
      await checkpointStore.recordFailure(DISCOVERY_CHECKPOINT_SOURCE, `getLogs: ${logsResult.reason}`);
      return { status: "UNAVAILABLE", reason: `getLogs: ${logsResult.reason}` };
    }

    const candidateAddresses = logsResult.data.map((log) => ({ log, tokenAddress: peekTokenAddress(log) })).filter((c): c is { log: RawEvmLog; tokenAddress: string } => c.tokenAddress !== null);

    // §4 — bounded-concurrency batch enrichment: a launch burst fans out at
    // most `enrichmentConcurrency` concurrent getLaunchedToken() calls, and
    // one token's RPC failure never discards another token's already-
    // fetched enrichment (mapWithConcurrency captures each outcome
    // independently rather than short-circuiting on the first rejection).
    const enrichmentOutcomes = await mapWithConcurrency(candidateAddresses, this.config.enrichmentConcurrency, async (c) => ({
      ...c,
      outcome: await this.fetchEnrichment(c.tokenAddress),
    }));

    const discovered: Array<{ normalized: NormalizedTokenDiscovered; enrichment: PonsLaunchEnrichment | null; enrichmentError: string | null }> = [];
    for (const settled of enrichmentOutcomes) {
      if (settled.status === "rejected") continue; // fetchEnrichment/peekTokenAddress never throw; defensive only
      const { log, outcome } = settled.value;
      const enrichment = outcome.status === "COMPLETE" ? outcome.enrichment : null;
      const normalized = ponsAdapter.decodeTokenDiscovered({ log, enrichment: enrichment ?? { supply: 0n, isToken0: false, poolFee: 0 } });
      if (!normalized) continue;
      discovered.push({ normalized, enrichment, enrichmentError: outcome.status === "FAILED" ? outcome.reason : null });
    }

    const toBlockRef = await this.chainClient.getBlockRef(toBlock);
    if (toBlockRef.status === "UNAVAILABLE") {
      await checkpointStore.recordFailure(DISCOVERY_CHECKPOINT_SOURCE, `getBlockRef(toBlock): ${toBlockRef.reason}`);
      return { status: "UNAVAILABLE", reason: `getBlockRef(toBlock): ${toBlockRef.reason}` };
    }

    let tokensPendingEnrichment = 0;
    await this.db.$transaction(async (tx) => {
      for (const { normalized: token, enrichment, enrichmentError } of discovered) {
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
        const isComplete = enrichment !== null;
        if (!isComplete) tokensPendingEnrichment += 1;

        const provenanceAndCore = {
          poolAddress,
          quoteAddress,
          initialBuyAmount: token.initialBuyAmount,
          sourceHeight: BigInt(token.provenance.sourceHeight),
          sourceHash: token.provenance.sourceHash,
          sourceTxHash: token.provenance.sourceTxHash,
          sourceIndex: token.provenance.sourceIndex,
          observedAt: new Date(token.observedAt),
        };

        await tx.discoveredToken.upsert({
          where: { chain_tokenAddress: { chain: token.chain, tokenAddress } },
          create: {
            chain: token.chain,
            venue: token.venue,
            tokenAddress,
            deployer,
            ...provenanceAndCore,
            supply: isComplete ? enrichment.supply.toString() : null,
            isToken0: isComplete ? enrichment.isToken0 : null,
            poolFee: isComplete ? enrichment.poolFee : null,
            enrichmentStatus: isComplete ? "COMPLETE" : "PENDING",
            enrichmentAttempts: isComplete ? 0 : 1,
            lastEnrichmentAttemptAt: new Date(),
            lastEnrichmentError: enrichmentError,
          },
          // §2/§9 — this token address may already exist as an ORPHANED row
          // from a prior reorg (reorgRecovery.ts never deletes). Replaying
          // canonical blocks after recovery must "revive" it back to
          // CANONICAL with the freshly observed provenance rather than
          // leaving it silently orphaned forever, and must refresh
          // enrichment status too (a token whose enrichment was PENDING
          // before an orphaning replays as PENDING again if still
          // unresolved, or COMPLETE if this tick's read succeeded).
          update: {
            ...provenanceAndCore,
            canonicalStatus: "CANONICAL",
            orphanedAt: null,
            ...(isComplete
              ? { supply: enrichment.supply.toString(), isToken0: enrichment.isToken0, poolFee: enrichment.poolFee, enrichmentStatus: "COMPLETE" as const, lastEnrichmentError: null }
              : { enrichmentStatus: "PENDING" as const, enrichmentAttempts: { increment: 1 }, lastEnrichmentError: enrichmentError }),
            lastEnrichmentAttemptAt: new Date(),
          },
        });
      }
      const checkpointStoreTx = new CheckpointStore(tx);
      await checkpointStoreTx.set(DISCOVERY_CHECKPOINT_SOURCE, { lastHeight: toBlock, lastHash: toBlockRef.data.hash }, observedChainHeight);
      await recordChainBlockCheckpoint(tx, ROBINHOOD_CHAIN, toBlock, toBlockRef.data.hash, this.config.reorgMaxDepthBlocks);
      // Prisma's default interactive-transaction timeout is 5s. This loop's
      // duration scales with how many tokens this tick discovered (one
      // upsert per token, sequential within the transaction) — a large
      // PONS_MAX_BLOCK_RANGE_PER_POLL catching up after a long gap (or a
      // genuine launch burst) can discover far more than fits in 5s even
      // though each individual upsert is fast. Found by running this
      // listener against real mainnet with an aggressive catch-up range
      // (Phase 7B.5A). 60s comfortably covers realistic burst sizes without
      // masking a truly stuck transaction.
    }, { timeout: 60_000 });

    this.logger.info(`discovery tick: processed blocks ${fromBlock}-${toBlock}, ${discovered.length} token(s) discovered (${tokensPendingEnrichment} pending enrichment), ${enrichmentRetried} retried (${enrichmentRetriedRecovered} recovered).`);
    return { status: "PROCESSED", fromBlock, toBlock, tokensDiscovered: discovered.length, tokensPendingEnrichment, enrichmentRetried, enrichmentRetriedRecovered };
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
          this.logger.error(`Discovery listener tick threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
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
