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
  });
}
