/**
 * Phase 7D §6 — Pons V2 discovery + graduation listener.
 *
 * Modeled on discoveryListener.ts's checkpointed/reorg-aware loop, but
 * covers two facts instead of one: V2's factory emits both TokenLaunched
 * (creation) *and* PoolGraduated (real-time migration to Uniswap V4 — no
 * polling needed, unlike V1's graduationPoller.ts) from the same address,
 * so both are scanned in one eth_getLogs call per tick.
 *
 * Reuses CheckpointStore, recordChainBlockCheckpoint, and
 * attemptReorgRecovery as-is — all already chain-scoped (ROBINHOOD_CHAIN),
 * not V1-specific. Uses its own checkpoint source so V1 and V2 discovery
 * progress independently.
 */

import type { PrismaClient } from "@prisma/client";
import { nextTickDelayMs, processedWidth } from "./tickPacing";
import { decodeEventLog, getAbiItem } from "viem";
import { ChainReader, type ChainCaller } from "./chainClient";
import { multicallAt, PinnedReadError } from "./quote/pinnedReads";
import { RobinhoodChainConfig } from "./config";
import { PonsV2Config } from "./config";
import { CheckpointStore, recordChainBlockCheckpoint } from "./checkpointStore";
import { ponsV2Adapter, RichLaunchMetadata } from "./ponsV2Adapter";
import { PONS_V2_FACTORY_ABI, UNISWAP_V4_POOL_MANAGER_ABI } from "./abiV2";
import { ERC20_ABI } from "./abi";
import { findMatchingInternalCallInput } from "./blockscoutTrace";
import { NormalizedTokenDiscovered, NormalizedTokenGraduated } from "../discovery/types";
import { mapWithConcurrency, chunk } from "./concurrency";
import { attemptReorgRecovery } from "./reorgRecovery";
import { ROBINHOOD_CHAIN } from "./discoveryListener";
import type { RawEvmLog } from "./ponsAdapter";

/** Phase 7D §1 — the 3 real launch entrypoints' selectors (see abiV2.ts / ponsV2Adapter.ts's LAUNCH_FUNCTION_SELECTORS for the verification trail). Duplicated here (rather than exported from the adapter) because this is the one place that needs the raw selector strings for the Blockscout fallback's own filtering, independent of decodeLaunchMetadata's internal use of them. */
import { toFunctionSelector } from "viem";
const LAUNCH_SELECTORS = (["launchToken", "launchTokenFor"] as const).flatMap((name) =>
  PONS_V2_FACTORY_ABI.filter((item) => item.type === "function" && item.name === name).map((item) => toFunctionSelector(item as Parameters<typeof toFunctionSelector>[0]))
);

export const DISCOVERY_V2_CHECKPOINT_SOURCE = "robinhood:pons_v2:discovery";
const VENUE = "pons_v2" as const;

const TOKEN_LAUNCHED_EVENT_NAME = "TokenLaunched" as const;
const POOL_GRADUATED_EVENT_NAME = "PoolGraduated" as const;

export type DiscoveryV2TickResult =
  | { status: "UP_TO_DATE"; safeTip: bigint }
  | { status: "PROCESSED"; fromBlock: bigint; toBlock: bigint; tokensDiscovered: number; tokensPendingEnrichment: number; tokensGraduated: number; enrichmentRetried: number; enrichmentRetriedRecovered: number }
  | { status: "UNAVAILABLE"; reason: string }
  | { status: "REORG_RECOVERED"; ancestorHeight: bigint }
  | { status: "REORG_UNRESOLVED"; reason: string };

export interface DiscoveryV2ListenerLogger {
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
}

const noopLogger: DiscoveryV2ListenerLogger = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * Phase 7D.5 — `call` is optional on purpose. `FailoverChainClient` has it, so the running
 * worker batches; a test stub that only implements `ChainReader` keeps the per-token path.
 */
type EnrichmentChainClient = ChainReader & Partial<Pick<ChainCaller, "call">>;

export interface DiscoveryV2ListenerDeps {
  chainClient: EnrichmentChainClient;
  db: PrismaClient;
  config: RobinhoodChainConfig;
  v2Config: PonsV2Config;
  logger?: DiscoveryV2ListenerLogger;
}

function peekTokenAddress(log: RawEvmLog, eventName: typeof TOKEN_LAUNCHED_EVENT_NAME | typeof POOL_GRADUATED_EVENT_NAME): string | null {
  try {
    const decoded = decodeEventLog({
      abi: PONS_V2_FACTORY_ABI,
      eventName,
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
  supply: bigint;
  name: string;
  symbol: string;
}
interface EnrichmentFailure {
  status: "FAILED";
  reason: string;
}

type RichMetadataOutcome = { status: "FOUND"; metadata: RichLaunchMetadata; source: "direct_tx" | "raw_trace" } | { status: "UNAVAILABLE" };

export class DiscoveryV2Listener {
  private readonly chainClient: EnrichmentChainClient;
  private readonly db: PrismaClient;
  private readonly config: RobinhoodChainConfig;
  private readonly v2Config: PonsV2Config;
  private readonly logger: DiscoveryV2ListenerLogger;
  private stopping = false;
  private timer: NodeJS.Timeout | null = null;
  private currentTick: Promise<void> = Promise.resolve();

  constructor(deps: DiscoveryV2ListenerDeps) {
    this.chainClient = deps.chainClient;
    this.db = deps.db;
    this.config = deps.config;
    this.v2Config = deps.v2Config;
    this.logger = deps.logger ?? noopLogger;
  }

  /**
   * V2's getLaunchedToken() has no supply field (verified — abiV2.ts) —
   * enrichment is a plain ERC-20 totalSupply()/name()/symbol() read on the
   * launched token itself, not the factory. All three are guaranteed by
   * the ERC-20 standard, same reliability as decimals() elsewhere in this
   * repo — not an off-chain metadata service (Moralis is unavailable and
   * not desired for this project).
   */
  /**
   * Phase 7D.5 — the same three ERC-20 reads for many tokens in one Multicall3
   * `aggregate3` at one pinned block.
   *
   * Why: enrichment was the dominant cost of a V2 discovery tick. A 10,000-block tick finds
   * ~254 launches and spent 3 `eth_call`s each — ~762 round trips — against a single usable
   * wide-range provider, which is what held V2 discovery near 46-123 blocks/s.
   *
   * Semantics preserved:
   * - `allowFailure` is true per call, so one bad token cannot discard the batch. A token
   *   whose read reverted comes back FAILED and stays PENDING/retryable, exactly as before.
   * - Every read in a batch is at one block, so a token's supply/name/symbol cannot be
   *   stitched from different states.
   * - Returns `null` when batching is unavailable (no `call` on the client, or the batch
   *   itself failed) so the caller falls back to the per-token path rather than losing rows.
   */
  /**
   * Enrich many tokens, preferring one Multicall3 round trip and falling back to the
   * per-token reads whenever batching is unavailable or the batch itself could not run.
   * The fallback is what guarantees this can only ever be faster, never less complete.
   */
  private async enrichMany(
    addresses: readonly string[],
    blockNumber: bigint | null
  ): Promise<Map<string, EnrichmentOutcome | EnrichmentFailure>> {
    const batched = blockNumber === null ? null : await this.fetchEnrichmentBatch(addresses, blockNumber);
    if (batched) return batched;
    const settled = await mapWithConcurrency(addresses, this.config.enrichmentConcurrency, async (address) => ({
      address,
      outcome: await this.fetchEnrichment(address),
    }));
    const out = new Map<string, EnrichmentOutcome | EnrichmentFailure>();
    settled.forEach((entry, i) => {
      if (entry.status === "fulfilled") out.set(entry.value.address, entry.value.outcome);
      else out.set(addresses[i], { status: "FAILED", reason: `enrichment threw: ${String(entry.reason).slice(0, 160)}` });
    });
    return out;
  }

  private async fetchEnrichmentBatch(
    addresses: readonly string[],
    blockNumber: bigint
  ): Promise<Map<string, EnrichmentOutcome | EnrichmentFailure> | null> {
    const call = this.chainClient.call?.bind(this.chainClient);
    if (!call || addresses.length === 0) return null;
    const caller = { ...this.chainClient, call } as ChainCaller;

    const out = new Map<string, EnrichmentOutcome | EnrichmentFailure>();
    const batchSize = Math.max(1, this.config.enrichmentMulticallBatchSize);

    for (const group of chunk(addresses, batchSize)) {
      // Halve on a response-size/aggregate failure before giving up on the group.
      let width = group.length;
      let index = 0;
      while (index < group.length) {
        const slice = group.slice(index, index + width);
        const reads = slice.flatMap((address) => [
          { address, abi: ERC20_ABI, functionName: "totalSupply" },
          { address, abi: ERC20_ABI, functionName: "name" },
          { address, abi: ERC20_ABI, functionName: "symbol" },
        ]);
        try {
          const results = await multicallAt(caller, blockNumber, reads);
          slice.forEach((address, i) => {
            const [supply, name, symbol] = [results[i * 3], results[i * 3 + 1], results[i * 3 + 2]];
            if (!supply?.ok || !name?.ok || !symbol?.ok) {
              const which = !supply?.ok ? "totalSupply" : !name?.ok ? "name" : "symbol";
              out.set(address, { status: "FAILED", reason: `${which}(${address}): reverted in multicall at block ${blockNumber}` });
              return;
            }
            out.set(address, {
              status: "COMPLETE",
              supply: supply.value as bigint,
              name: name.value as string,
              symbol: symbol.value as string,
            });
          });
          index += width;
        } catch (err) {
          if (!(err instanceof PinnedReadError)) throw err;
          if (width > 1) {
            // Too wide for this provider (response size, gas, timeout): try a smaller batch.
            width = Math.max(1, Math.floor(width / 2));
            continue;
          }
          // Even one token failed through the batch path — hand the whole thing back so the
          // caller uses the per-token reads it has always used.
          this.logger.warn(`pons_v2 enrichment multicall unavailable at block ${blockNumber} (${err.kind}) — falling back to per-token reads.`);
          return null;
        }
      }
    }
    return out;
  }

  private async fetchEnrichment(tokenAddress: string): Promise<EnrichmentOutcome | EnrichmentFailure> {
    const [supplyResult, nameResult, symbolResult] = await Promise.all([
      this.chainClient.readContract<bigint>({ address: tokenAddress, abi: ERC20_ABI, functionName: "totalSupply", args: [] }),
      this.chainClient.readContract<string>({ address: tokenAddress, abi: ERC20_ABI, functionName: "name", args: [] }),
      this.chainClient.readContract<string>({ address: tokenAddress, abi: ERC20_ABI, functionName: "symbol", args: [] }),
    ]);
    if (supplyResult.status === "UNAVAILABLE") return { status: "FAILED", reason: `totalSupply(${tokenAddress}): ${supplyResult.reason}` };
    if (nameResult.status === "UNAVAILABLE") return { status: "FAILED", reason: `name(${tokenAddress}): ${nameResult.reason}` };
    if (symbolResult.status === "UNAVAILABLE") return { status: "FAILED", reason: `symbol(${tokenAddress}): ${symbolResult.reason}` };
    return { status: "COMPLETE", supply: supplyResult.data, name: nameResult.data, symbol: symbolResult.data };
  }

  /**
   * Phase 7D §1 (metadata) — one-shot: a launch tx that doesn't directly
   * call launchToken/launchTokenFor (nor route through it internally per
   * the Blockscout fallback) will never start matching on retry, so unlike
   * fetchEnrichment this is never re-attempted for a row once it lands on
   * COMPLETE/UNAVAILABLE. Primary path never touches Blockscout at all —
   * only the fallback does, and only best-effort (see blockscoutTrace.ts).
   */
  private async fetchRichMetadata(sourceTxHash: string): Promise<RichMetadataOutcome> {
    const txResult = await this.chainClient.getTransaction(sourceTxHash);
    if (txResult.status === "AVAILABLE" && txResult.data.to?.toLowerCase() === this.v2Config.factoryAddress.toLowerCase()) {
      const direct = ponsV2Adapter.decodeLaunchMetadata(txResult.data.input);
      if (direct) return { status: "FOUND", metadata: direct, source: "direct_tx" };
    }
    const fallbackInput = await findMatchingInternalCallInput({
      explorerBaseUrl: this.config.explorerUrl,
      txHash: sourceTxHash,
      targetAddress: this.v2Config.factoryAddress,
      selectors: LAUNCH_SELECTORS,
    });
    if (fallbackInput) {
      const viaTrace = ponsV2Adapter.decodeLaunchMetadata(fallbackInput);
      if (viaTrace) return { status: "FOUND", metadata: viaTrace, source: "raw_trace" };
    }
    return { status: "UNAVAILABLE" };
  }

  /** Resolved once per process and cached — the factory self-describes its PoolManager (verified live, see abiV2.ts's header) rather than this needing a separate env var. */
  private poolManagerAddressPromise: Promise<string | null> | null = null;
  private async getPoolManagerAddress(): Promise<string | null> {
    if (!this.poolManagerAddressPromise) {
      this.poolManagerAddressPromise = this.chainClient
        .readContract<string>({ address: this.v2Config.factoryAddress, abi: PONS_V2_FACTORY_ABI, functionName: "poolManager", args: [] })
        .then((r) => (r.status === "AVAILABLE" ? r.data : null));
    }
    return this.poolManagerAddressPromise;
  }

  /**
   * Phase 7D §2 (transaction history) — a graduation's PoolId isn't in
   * PoolGraduated itself, but graduation always creates the pool in the
   * same transaction (verified live), so the accompanying Initialize log
   * — scanned in just that one block, well within the 10-block free-tier
   * cap — is the safe way to learn it. Never hand-computes
   * keccak256(PoolKey).
   */
  private async fetchPoolIdentity(tokenAddress: string, blockNumber: bigint): Promise<{ poolId: string; isToken0: boolean } | null> {
    const poolManager = await this.getPoolManagerAddress();
    if (!poolManager) return null;
    const initializeEvent = getAbiItem({ abi: UNISWAP_V4_POOL_MANAGER_ABI, name: "Initialize" });
    const logsResult = await this.chainClient.getLogs({ address: poolManager, event: initializeEvent, fromBlock: blockNumber, toBlock: blockNumber });
    if (logsResult.status === "UNAVAILABLE") return null;
    for (const log of logsResult.data) {
      const identity = ponsV2Adapter.decodePoolInitialized({ log }, tokenAddress);
      if (identity) return identity;
    }
    return null;
  }

  async runOnce(): Promise<DiscoveryV2TickResult> {
    const checkpointStore = new CheckpointStore(this.db);

    const latestResult = await this.chainClient.getBlockNumber();
    if (latestResult.status === "UNAVAILABLE") {
      await checkpointStore.recordFailure(DISCOVERY_V2_CHECKPOINT_SOURCE, `getBlockNumber: ${latestResult.reason}`);
      return { status: "UNAVAILABLE", reason: `getBlockNumber: ${latestResult.reason}` };
    }
    const observedChainHeight = latestResult.data;
    const safeTip = observedChainHeight - BigInt(this.config.confirmationLagBlocks);
    if (safeTip < 0n) {
      await checkpointStore.recordUpToDate(DISCOVERY_V2_CHECKPOINT_SOURCE, observedChainHeight);
      return { status: "UP_TO_DATE", safeTip: 0n };
    }

    const checkpoint = await checkpointStore.get(DISCOVERY_V2_CHECKPOINT_SOURCE);

    if (checkpoint) {
      // Same detect-and-recover discipline as discoveryListener.ts. Reorg
      // recovery is chain-scoped (ROBINHOOD_CHAIN), so it rolls back every
      // ingestion source for this chain together, V1 and V2 alike — safe
      // and idempotent for either to be the one that triggers it.
      const checkpointBlock = await this.chainClient.getBlockRef(checkpoint.lastHeight);
      if (checkpointBlock.status === "UNAVAILABLE") {
        await checkpointStore.recordFailure(DISCOVERY_V2_CHECKPOINT_SOURCE, `reorg check getBlockRef: ${checkpointBlock.reason}`);
        return { status: "UNAVAILABLE", reason: `reorg check getBlockRef: ${checkpointBlock.reason}` };
      }
      if (checkpointBlock.data.hash.toLowerCase() !== checkpoint.lastHash.toLowerCase()) {
        this.logger.error(`reorg detected (pons_v2) at height ${checkpoint.lastHeight}: expected hash ${checkpoint.lastHash}, chain now reports ${checkpointBlock.data.hash}. Attempting bounded recovery.`, {
          height: checkpoint.lastHeight.toString(),
        });
        const recovery = await attemptReorgRecovery({ chainClient: this.chainClient, db: this.db, chain: ROBINHOOD_CHAIN });
        if (recovery.status === "UNAVAILABLE") {
          await checkpointStore.recordFailure(DISCOVERY_V2_CHECKPOINT_SOURCE, `reorg recovery unavailable: ${recovery.reason}`);
          return { status: "UNAVAILABLE", reason: `reorg recovery: ${recovery.reason}` };
        }
        if (recovery.status === "UNRESOLVED") {
          this.logger.error(`reorg recovery UNRESOLVED (pons_v2) — halting.`, { searchedDepth: recovery.searchedDepth });
          await checkpointStore.markReorgUnresolved(DISCOVERY_V2_CHECKPOINT_SOURCE, recovery.reason);
          return { status: "REORG_UNRESOLVED", reason: recovery.reason };
        }
        this.logger.info(`reorg RECOVERED (pons_v2) at ancestor height ${recovery.ancestorHeight}: orphaned ${recovery.orphanedTokens} token(s), ${recovery.orphanedTrades} trade(s).`);
        return { status: "REORG_RECOVERED", ancestorHeight: recovery.ancestorHeight };
      }
    }

    let enrichmentRetried = 0;
    let enrichmentRetriedRecovered = 0;
    const pendingRows = await this.db.discoveredToken.findMany({
      where: { chain: ROBINHOOD_CHAIN, venue: VENUE, canonicalStatus: "CANONICAL", enrichmentStatus: "PENDING" },
      orderBy: { sourceHeight: "asc" },
      take: this.config.enrichmentRetryBatchSize,
      select: { tokenAddress: true },
    });
    if (pendingRows.length > 0) {
      enrichmentRetried = pendingRows.length;
      // Observation block: the last height this source has fully processed, whose hash the
      // reorg check above has just re-verified. Null on a fresh source (no pending rows
      // exist then anyway), which sends enrichMany down the per-token path.
      const retryBlock = checkpoint ? checkpoint.lastHeight : null;
      const retryEnrichment = await this.enrichMany(
        pendingRows.map((row) => row.tokenAddress),
        retryBlock
      );
      for (const { tokenAddress } of pendingRows) {
        const outcome = retryEnrichment.get(tokenAddress) ?? { status: "FAILED" as const, reason: `no enrichment result for ${tokenAddress}` };
        if (outcome.status === "COMPLETE") {
          await this.db.discoveredToken.update({
            where: { chain_tokenAddress: { chain: ROBINHOOD_CHAIN, tokenAddress } },
            data: { supply: outcome.supply.toString(), name: outcome.name, symbol: outcome.symbol, enrichmentStatus: "COMPLETE", lastEnrichmentAttemptAt: new Date(), lastEnrichmentError: null },
          });
          enrichmentRetriedRecovered += 1;
        } else {
          await this.db.discoveredToken.update({
            where: { chain_tokenAddress: { chain: ROBINHOOD_CHAIN, tokenAddress } },
            data: { enrichmentAttempts: { increment: 1 }, lastEnrichmentAttemptAt: new Date(), lastEnrichmentError: outcome.reason },
          });
          this.logger.warn(`pons_v2 enrichment retry failed for ${tokenAddress}: ${outcome.reason}`);
        }
      }
    }

    const fromBlock = checkpoint
      ? checkpoint.lastHeight + 1n
      : (() => {
          const lookback = BigInt(this.config.freshStartLookbackBlocks);
          const start = safeTip - lookback + 1n;
          this.logger.warn(`No pons_v2 discovery checkpoint found — starting fresh at height ${start > 0n ? start : 0n} (${this.config.freshStartLookbackBlocks} blocks behind tip).`);
          return start > 0n ? start : 0n;
        })();

    if (fromBlock > safeTip) {
      await checkpointStore.recordUpToDate(DISCOVERY_V2_CHECKPOINT_SOURCE, observedChainHeight);
      return { status: "UP_TO_DATE", safeTip };
    }

    const toBlock = (() => {
      const maxRange = BigInt(this.config.maxBlockRangePerPoll);
      const candidate = fromBlock + maxRange - 1n;
      return candidate < safeTip ? candidate : safeTip;
    })();

    const tokenLaunchedEvent = getAbiItem({ abi: PONS_V2_FACTORY_ABI, name: TOKEN_LAUNCHED_EVENT_NAME });
    const poolGraduatedEvent = getAbiItem({ abi: PONS_V2_FACTORY_ABI, name: POOL_GRADUATED_EVENT_NAME });

    // Two eth_getLogs calls (one per event) rather than widening the shared
    // ChainReader.getLogs seam to accept an event array — both facts live
    // on the same factory address and block range, and this event pair is
    // nowhere near hot enough (a handful of launches/graduations per block
    // at most) to justify touching an interface other listeners/tests
    // depend on for what would only ever save one RPC round trip per tick.
    const launchLogsResult = await this.chainClient.getLogs({ address: this.v2Config.factoryAddress, event: tokenLaunchedEvent, fromBlock, toBlock });
    if (launchLogsResult.status === "UNAVAILABLE") {
      await checkpointStore.recordFailure(DISCOVERY_V2_CHECKPOINT_SOURCE, `getLogs(TokenLaunched): ${launchLogsResult.reason}`);
      return { status: "UNAVAILABLE", reason: `getLogs(TokenLaunched): ${launchLogsResult.reason}` };
    }
    const graduationLogsResult = await this.chainClient.getLogs({ address: this.v2Config.factoryAddress, event: poolGraduatedEvent, fromBlock, toBlock });
    if (graduationLogsResult.status === "UNAVAILABLE") {
      await checkpointStore.recordFailure(DISCOVERY_V2_CHECKPOINT_SOURCE, `getLogs(PoolGraduated): ${graduationLogsResult.reason}`);
      return { status: "UNAVAILABLE", reason: `getLogs(PoolGraduated): ${graduationLogsResult.reason}` };
    }
    const launchLogs = launchLogsResult.data;
    const graduationLogs = graduationLogsResult.data;

    const candidateAddresses = launchLogs
      .map((log) => ({ log, tokenAddress: peekTokenAddress(log, TOKEN_LAUNCHED_EVENT_NAME) }))
      .filter((c): c is { log: RawEvmLog; tokenAddress: string } => c.tokenAddress !== null);

    // Observation block: this tick's toBlock — the same block whose hash is written to the
    // chain block checkpoint below, so a launch and its metadata share one canonical state.
    const candidateEnrichment = await this.enrichMany(
      candidateAddresses.map((c) => c.tokenAddress),
      toBlock
    );
    const discovered: Array<{ normalized: NormalizedTokenDiscovered & { curveAddress: string }; supply: bigint | null; name: string | null; symbol: string | null; enrichmentError: string | null }> = [];
    for (const { log, tokenAddress } of candidateAddresses) {
      const outcome = candidateEnrichment.get(tokenAddress) ?? { status: "FAILED" as const, reason: `no enrichment result for ${tokenAddress}` };
      const supply = outcome.status === "COMPLETE" ? outcome.supply : null;
      const normalized = ponsV2Adapter.decodeTokenDiscovered({ log, enrichment: { supply: supply ?? 0n } });
      if (!normalized) continue;
      discovered.push({
        normalized,
        supply,
        name: outcome.status === "COMPLETE" ? outcome.name : null,
        symbol: outcome.status === "COMPLETE" ? outcome.symbol : null,
        enrichmentError: outcome.status === "FAILED" ? outcome.reason : null,
      });
    }

    // Phase 7D §1 (metadata) — one fetch per newly-seen token this tick,
    // bounded the same way as enrichment. Never retried once landed (see
    // fetchRichMetadata's doc comment) — a launch tx that isn't a direct
    // launchToken/launchTokenFor call (nor found via the Blockscout
    // fallback) will never start matching later.
    const richMetadataOutcomes = await mapWithConcurrency(discovered, this.config.enrichmentConcurrency, async (d) => ({
      tokenAddress: d.normalized.tokenAddress,
      outcome: await this.fetchRichMetadata(d.normalized.provenance.sourceTxHash),
    }));
    const richMetadataByToken = new Map<string, RichMetadataOutcome>();
    for (const settled of richMetadataOutcomes) {
      if (settled.status === "rejected") continue;
      richMetadataByToken.set(settled.value.tokenAddress.toLowerCase(), settled.value.outcome);
    }

    const graduations: NormalizedTokenGraduated[] = [];
    for (const log of graduationLogs) {
      const normalized = ponsV2Adapter.decodeTokenGraduated({ log });
      if (normalized) graduations.push(normalized);
    }

    // Phase 7D §2 (transaction history) — one Initialize lookup per
    // graduation this tick (graduations are rare relative to launches, so
    // this never needs its own bounded-concurrency budget separate from
    // enrichmentConcurrency).
    const poolIdentityOutcomes = await mapWithConcurrency(graduations, this.config.enrichmentConcurrency, async (g) => ({
      tokenAddress: g.tokenAddress,
      identity: await this.fetchPoolIdentity(g.tokenAddress, BigInt(g.provenance.sourceHeight)),
    }));
    const poolIdentityByToken = new Map<string, { poolId: string; isToken0: boolean }>();
    for (const settled of poolIdentityOutcomes) {
      if (settled.status === "rejected" || !settled.value.identity) continue;
      poolIdentityByToken.set(settled.value.tokenAddress.toLowerCase(), settled.value.identity);
    }

    const toBlockRef = await this.chainClient.getBlockRef(toBlock);
    if (toBlockRef.status === "UNAVAILABLE") {
      await checkpointStore.recordFailure(DISCOVERY_V2_CHECKPOINT_SOURCE, `getBlockRef(toBlock): ${toBlockRef.reason}`);
      return { status: "UNAVAILABLE", reason: `getBlockRef(toBlock): ${toBlockRef.reason}` };
    }

    let tokensPendingEnrichment = 0;
    let tokensGraduated = 0;
    await this.db.$transaction(
      async (tx) => {
        for (const { normalized: token, supply, name, symbol, enrichmentError } of discovered) {
          const tokenAddress = token.tokenAddress.toLowerCase();
          const deployer = token.deployer.toLowerCase();
          const curveAddress = token.curveAddress.toLowerCase();
          const quoteAddress = token.quoteAddress.toLowerCase();
          const isComplete = supply !== null;
          if (!isComplete) tokensPendingEnrichment += 1;

          const richOutcome = richMetadataByToken.get(tokenAddress);
          const richFields =
            richOutcome?.status === "FOUND"
              ? {
                  logoUrl: richOutcome.metadata.logoUrl,
                  description: richOutcome.metadata.description,
                  socialWebsite: richOutcome.metadata.socials.website,
                  socialTwitter: richOutcome.metadata.socials.twitter,
                  socialTelegram: richOutcome.metadata.socials.telegram,
                  socialDiscord: richOutcome.metadata.socials.discord,
                  socialFarcaster: richOutcome.metadata.socials.farcaster,
                  richMetadataStatus: "FOUND" as const,
                  richMetadataSource: richOutcome.source,
                }
              : { richMetadataStatus: "UNAVAILABLE" as const };

          const provenanceAndCore = {
            curveAddress,
            quoteAddress,
            initialBuyAmount: token.initialBuyAmount,
            sourceHeight: BigInt(token.provenance.sourceHeight),
            sourceHash: token.provenance.sourceHash,
            sourceTxHash: token.provenance.sourceTxHash,
            sourceIndex: token.provenance.sourceIndex,
            observedAt: new Date(token.observedAt),
            ...richFields,
          };

          // Phase 7D.4 §2 — a later observation that could not recover launch metadata (e.g. the
          // explorer fallback is unreachable) must not downgrade or clear what an earlier one found.
          const { richMetadataStatus: _unavailable, ...provenanceWithoutRichStatus } = provenanceAndCore as typeof provenanceAndCore & { richMetadataStatus?: string };
          const updateCore = richOutcome?.status === "FOUND" ? provenanceAndCore : provenanceWithoutRichStatus;
          await tx.discoveredToken.upsert({
            where: { chain_tokenAddress: { chain: token.chain, tokenAddress } },
            create: {
              chain: token.chain,
              venue: VENUE,
              tokenAddress,
              deployer,
              ...provenanceAndCore,
              supply: isComplete ? supply.toString() : null,
              name,
              symbol,
              enrichmentStatus: isComplete ? "COMPLETE" : "PENDING",
              enrichmentAttempts: isComplete ? 0 : 1,
              lastEnrichmentAttemptAt: new Date(),
              lastEnrichmentError: enrichmentError,
            },
            update: {
              ...updateCore,
              canonicalStatus: "CANONICAL",
              orphanedAt: null,
              ...(isComplete
                ? { supply: supply.toString(), name, symbol, enrichmentStatus: "COMPLETE" as const, lastEnrichmentError: null }
                : { enrichmentStatus: "PENDING" as const, enrichmentAttempts: { increment: 1 }, lastEnrichmentError: enrichmentError }),
              lastEnrichmentAttemptAt: new Date(),
            },
          });
        }

        for (const grad of graduations) {
          const tokenAddress = grad.tokenAddress.toLowerCase();
          // TokenLaunched always precedes PoolGraduated on-chain for the
          // same token, and this tick already upserted every TokenLaunched
          // row it saw above — but a graduation whose launch fell in an
          // earlier, already-committed block range still needs a row to
          // update against. updateMany + count rather than update() so a
          // not-yet-visible row (block-range straddle at worker startup)
          // is skipped rather than throwing; it'll simply show
          // graduated=false until an operator re-runs discovery from that
          // token's launch height, same fail-closed posture as the rest of
          // this pipeline.
          const identity = poolIdentityByToken.get(tokenAddress);
          if (!identity) {
            this.logger.warn(`pons_v2 PoolGraduated for ${tokenAddress} had no matching Initialize log — poolId stays null (transaction-history tracking cannot start for this token until it's backfilled).`);
          }
          const result = await tx.discoveredToken.updateMany({
            where: { chain: ROBINHOOD_CHAIN, venue: VENUE, tokenAddress },
            data: {
              graduated: true,
              graduationPositionId: grad.positionId,
              graduationTokenAmount: grad.tokenAmount,
              graduationPairTokenAmount: grad.pairTokenAmount,
              graduationSourceHeight: BigInt(grad.provenance.sourceHeight),
              graduationSourceHash: grad.provenance.sourceHash,
              graduationSourceTxHash: grad.provenance.sourceTxHash,
              ...(identity ? { poolId: identity.poolId, isToken0: identity.isToken0 } : {}),
            },
          });
          if (result.count > 0) tokensGraduated += 1;
          else this.logger.warn(`pons_v2 PoolGraduated seen for ${tokenAddress} but no DiscoveredToken row exists yet — its TokenLaunched must be in an earlier, already-processed block range outside this deployment's history.`);
        }

        const checkpointStoreTx = new CheckpointStore(tx);
        await checkpointStoreTx.set(DISCOVERY_V2_CHECKPOINT_SOURCE, { lastHeight: toBlock, lastHash: toBlockRef.data.hash }, observedChainHeight);
        await recordChainBlockCheckpoint(tx, ROBINHOOD_CHAIN, toBlock, toBlockRef.data.hash, this.config.reorgMaxDepthBlocks);
      },
      { timeout: 60_000 }
    );

    this.logger.info(
      `pons_v2 discovery tick: processed blocks ${fromBlock}-${toBlock}, ${discovered.length} token(s) discovered (${tokensPendingEnrichment} pending enrichment), ${tokensGraduated} graduation(s) recorded, ${enrichmentRetried} enrichment retried (${enrichmentRetriedRecovered} recovered).`
    );
    return { status: "PROCESSED", fromBlock, toBlock, tokensDiscovered: discovered.length, tokensPendingEnrichment, tokensGraduated, enrichmentRetried, enrichmentRetriedRecovered };
  }

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    const tick = async () => {
      if (this.stopping) return;
      let result: DiscoveryV2TickResult | undefined;
      this.currentTick = (async () => {
        try {
          result = await this.runOnce();
        } catch (err) {
          this.logger.error(`pons_v2 discovery listener tick threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
      await this.currentTick;
      if (!this.stopping) {
        // A free-tier RPC's small eth_getLogs range cap (PONS_MAX_BLOCK_RANGE_PER_POLL)
        // means one tick often can't reach the chain tip even when there's
        // more backlog immediately behind it — waiting the full poll
        // interval between every such tick regardless made catch-up
        // strictly slower than new-block production on a fast chain
        // (verified live: fell ~13,700 blocks behind). Only wait when this
        // tick actually reached UP_TO_DATE (or hit a real error worth
        // backing off from) — otherwise loop again immediately.
        const delay = nextTickDelayMs({
          processedWidth: processedWidth(result),
          maxRangePerPoll: this.config.maxBlockRangePerPoll,
          pollIntervalMs: this.config.pollIntervalMs,
        });
        this.timer = setTimeout(tick, delay);
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

  async waitForIdle(): Promise<void> {
    await this.currentTick;
  }
}
