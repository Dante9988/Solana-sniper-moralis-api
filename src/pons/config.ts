/**
 * Phase 7B.4 §4.1 — validated Robinhood Chain / Pons configuration.
 *
 * Same fail-closed discipline as src/forensics/forensicsConfig.ts: invalid
 * or missing config throws, rather than producing a listener that silently
 * misbehaves. Deliberately NOT eagerly resolved at module load (unlike
 * forensicsConfig's RESOLVED_FORENSICS_CLIENT_CONFIG) — this repo's own
 * precedent for a long-running listener (src/forensics/forensicsWorker.ts)
 * requires zero side effects at import time, so this module only exports a
 * loader function; the worker entrypoint calls it explicitly.
 */

export class PonsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PonsConfigError";
  }
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    throw new PonsConfigError(`${name} is required and was not set`);
  }
  return raw.trim();
}

function requireAddress(env: NodeJS.ProcessEnv, name: string): string {
  const raw = requireEnv(env, name);
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    throw new PonsConfigError(`${name} must be a 20-byte hex address, got ${JSON.stringify(raw)}`);
  }
  return raw;
}

function requirePositiveInt(env: NodeJS.ProcessEnv, name: string): number {
  const raw = requireEnv(env, name);
  if (!/^\d+$/.test(raw)) {
    throw new PonsConfigError(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new PonsConfigError(`${name} must be a positive safe integer, got ${raw}`);
  }
  return parsed;
}

function parsePositiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new PonsConfigError(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new PonsConfigError(`${name} must be a positive safe integer, got ${trimmed}`);
  }
  return parsed;
}

export interface RobinhoodChainConfig {
  readonly chainId: number;
  readonly rpcHttpUrl: string;
  /**
   * Kept for completeness/telemetry only — NEVER opened for eth_subscribe.
   * Verified live during Phase 7B.4 Step 0/§8 step 1: this is the raw
   * Arbitrum Nitro sequencer feed relay protocol, not a JSON-RPC pubsub
   * endpoint. It ignored a real eth_subscribe("newHeads") request entirely.
   * Ingestion in this phase polls rpcHttpUrl via eth_getLogs instead.
   */
  readonly rpcWsUrl: string;
  readonly explorerUrl: string;
  readonly factoryAddress: string;
  readonly lockerAddress: string;
  readonly factoryLegacyAddress: string;
  readonly lockerLegacyAddress: string;
  /** WETH_QUOTE — identity/decimals only. Bytecode is a proxy, not canonical WETH9; never call deposit()/withdraw() against it (phase7b4.txt §3). */
  readonly quoteAddress: string;
  readonly pollIntervalMs: number;
  readonly graduationPollIntervalMs: number;
  readonly maxBlockRangePerPoll: number;
  /** Blocks held back from the chain tip before a block is considered safe enough to ingest — a lightweight complement to, not a replacement for, the explicit reorg detection in §4.8. */
  readonly confirmationLagBlocks: number;
  /** How many blocks back of the chain tip a *fresh* (no checkpoint) listener starts from. Historical backfill from genesis/legacy-factory activation is explicitly out of scope for this phase (phase7b4.txt "Explicitly out of scope"). */
  readonly freshStartLookbackBlocks: number;

  // --- Phase 7B.5A additions ---

  /** Bounded concurrency for getLaunchedToken() enrichment fan-out during a launch burst (§4). Never unbounded Promise.all. */
  readonly enrichmentConcurrency: number;
  /** How many PENDING-enrichment rows a single discovery tick retries, bounded so a large backlog can't turn one tick into an unbounded RPC burst. */
  readonly enrichmentRetryBatchSize: number;
  /** Max pool addresses per eth_getLogs call for trade polling (§3) — chunked rather than one ever-growing address array. */
  readonly tradePoolChunkSize: number;
  /** Bounded concurrency across those chunked eth_getLogs calls. */
  readonly tradeQueryConcurrency: number;
  /** How many recent (height,hash) checkpoints reorg recovery is willing to search backward through to find a common canonical ancestor (§2). Exceeding this without a match is a fail-closed REORG_UNRESOLVED. */
  readonly reorgMaxDepthBlocks: number;
  /** Source-health projection (§5): blocks behind the observed chain tip before a source is LAGGING rather than LIVE. */
  readonly healthLaggingBlocks: number;
  /** Source-health projection: how long a loop can go without a successful tick before it's reported UNAVAILABLE rather than merely DEGRADED. */
  readonly healthStaleMs: number;
  /** Source-health projection: how recently a recorded error must have occurred (with no success since) to report DEGRADED. */
  readonly healthErrorWindowMs: number;
}

export function loadRobinhoodChainConfig(env: NodeJS.ProcessEnv = process.env): RobinhoodChainConfig {
  return Object.freeze({
    chainId: requirePositiveInt(env, "ROBINHOOD_CHAIN_ID"),
    rpcHttpUrl: requireEnv(env, "ROBINHOOD_RPC_HTTPS"),
    rpcWsUrl: requireEnv(env, "ROBINHOOD_RPC_WSS"),
    explorerUrl: requireEnv(env, "ROBINHOOD_EXPLORER"),
    factoryAddress: requireAddress(env, "PONS_FACTORY"),
    lockerAddress: requireAddress(env, "PONS_LOCKER"),
    factoryLegacyAddress: requireAddress(env, "PONS_FACTORY_LEGACY"),
    lockerLegacyAddress: requireAddress(env, "PONS_LOCKER_LEGACY"),
    quoteAddress: requireAddress(env, "WETH_QUOTE"),
    pollIntervalMs: parsePositiveInt(env, "PONS_POLL_INTERVAL_MS", 5_000),
    graduationPollIntervalMs: parsePositiveInt(env, "PONS_GRADUATION_POLL_INTERVAL_MS", 60_000),
    maxBlockRangePerPoll: parsePositiveInt(env, "PONS_MAX_BLOCK_RANGE_PER_POLL", 2_000),
    confirmationLagBlocks: parsePositiveInt(env, "PONS_CONFIRMATION_LAG_BLOCKS", 5),
    freshStartLookbackBlocks: parsePositiveInt(env, "PONS_FRESH_START_LOOKBACK_BLOCKS", 1_000),
    enrichmentConcurrency: parsePositiveInt(env, "PONS_ENRICHMENT_CONCURRENCY", 5),
    enrichmentRetryBatchSize: parsePositiveInt(env, "PONS_ENRICHMENT_RETRY_BATCH_SIZE", 25),
    tradePoolChunkSize: parsePositiveInt(env, "PONS_TRADE_POOL_CHUNK_SIZE", 40),
    tradeQueryConcurrency: parsePositiveInt(env, "PONS_TRADE_QUERY_CONCURRENCY", 3),
    reorgMaxDepthBlocks: parsePositiveInt(env, "PONS_REORG_MAX_DEPTH_BLOCKS", 500),
    healthLaggingBlocks: parsePositiveInt(env, "PONS_HEALTH_LAGGING_BLOCKS", 50),
    healthStaleMs: parsePositiveInt(env, "PONS_HEALTH_STALE_MS", 120_000),
    healthErrorWindowMs: parsePositiveInt(env, "PONS_HEALTH_ERROR_WINDOW_MS", 60_000),
  });
}

export type PonsHealthThresholds = Pick<RobinhoodChainConfig, "healthLaggingBlocks" | "healthStaleMs" | "healthErrorWindowMs">;

/**
 * Phase 7D §2 — Pons V2 (Uniswap V4 graduation) is a separate, additive
 * protocol generation from V1 (see abiV2.ts). Deliberately its own narrow
 * loader, mirroring loadPonsHealthThresholds below, rather than folded into
 * loadRobinhoodChainConfig: that loader throws if anything required is
 * missing, so a deployment that hasn't set PONS_V2_FACTORY yet must still
 * be able to run the V1 discovery/trade/graduation loops untouched. The
 * locker/graduationExecutor/memeHook/buybackVault/poolManager/
 * positionManager addresses are deliberately NOT config here — the V2
 * factory exposes each as a view function (verified live, see abiV2.ts's
 * header), so DiscoveryV2Listener resolves and caches them at startup
 * instead of risking stale hardcoded addresses.
 */
export interface PonsV2Config {
  readonly factoryAddress: string;
}

export function loadPonsV2Config(env: NodeJS.ProcessEnv = process.env): PonsV2Config {
  return Object.freeze({
    factoryAddress: requireAddress(env, "PONS_V2_FACTORY"),
  });
}

/**
 * The `/api/v1/tokens/robinhood/status` route (§5) needs only these three
 * tunables, never the RPC/contract settings `loadRobinhoodChainConfig`
 * requires — the read-only API process must be able to boot and serve a
 * health projection even in a deployment where it doesn't itself run the
 * ingestion worker (and therefore has no ROBINHOOD_RPC_HTTPS/PONS_FACTORY/
 * etc. configured).
 */
export function loadPonsHealthThresholds(env: NodeJS.ProcessEnv = process.env): PonsHealthThresholds {
  return Object.freeze({
    healthLaggingBlocks: parsePositiveInt(env, "PONS_HEALTH_LAGGING_BLOCKS", 50),
    healthStaleMs: parsePositiveInt(env, "PONS_HEALTH_STALE_MS", 120_000),
    healthErrorWindowMs: parsePositiveInt(env, "PONS_HEALTH_ERROR_WINDOW_MS", 60_000),
  });
}
