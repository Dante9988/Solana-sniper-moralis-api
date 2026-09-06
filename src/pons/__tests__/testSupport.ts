/**
 * Shared test-only fakes for the Pons DB-integration suite (opt-in via
 * PONS_RUN_DB_TESTS=true, real disposable Postgres, fake chain — see
 * discoveryListener.dbIntegration.test.ts's header for the full
 * convention). Centralized here so the Phase 7B.5A coordination/reorg/
 * enrichment/pool-scaling regression tests don't each reinvent a canned
 * chain simulator.
 */
import { encodeAbiParameters, encodeEventTopics, getAbiItem, type AbiEvent } from "viem";
import { ChainClientResult, ChainReader, RawBlockRef } from "../chainClient";
import { RawEvmLog } from "../ponsAdapter";
import { RobinhoodChainConfig } from "../config";
import { PONS_FACTORY_ABI, UNISWAP_V3_POOL_ABI } from "../abi";

export const TEST_CONFIG: RobinhoodChainConfig = Object.freeze({
  chainId: 4663,
  rpcHttpUrl: "http://unused-in-this-test.invalid",
  rpcWsUrl: "wss://unused-in-this-test.invalid",
  explorerUrl: "https://unused-in-this-test.invalid",
  factoryAddress: "0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB",
  lockerAddress: "0x736D76699C26D0d966744cAe304C000d471f7F35",
  factoryLegacyAddress: "0x0c37a24F5D23A486FA692d1500881d698B1F77a4",
  lockerLegacyAddress: "0x31ca5E101941A93A7DD6d0497928700625CF54B5",
  quoteAddress: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  pollIntervalMs: 5_000,
  graduationPollIntervalMs: 60_000,
  maxBlockRangePerPoll: 2_000,
  confirmationLagBlocks: 0,
  freshStartLookbackBlocks: 100,
  enrichmentConcurrency: 5,
  enrichmentRetryBatchSize: 25,
  tradePoolChunkSize: 40,
  tradeQueryConcurrency: 3,
  reorgMaxDepthBlocks: 500,
  healthLaggingBlocks: 50,
  healthStaleMs: 120_000,
  healthErrorWindowMs: 60_000,
});

export type EnrichmentTuple = { supply: bigint; isToken0: boolean; poolFee: number };

function ok<T>(data: T): ChainClientResult<T> {
  return { status: "AVAILABLE", data, source: "fake", fetchedAt: new Date(), attempts: 1 };
}
function fail<T>(reason: string): ChainClientResult<T> {
  return { status: "UNAVAILABLE", source: "fake", fetchedAt: new Date(), code: "RPC_ERROR", reason, attempts: 1 };
}

/**
 * A canned, in-memory chain simulator — deterministic block hashes by
 * height (computed on demand unless overridden), a fixed/mutable set of
 * logs, and per-address enrichment control (for burst/partial-failure
 * enrichment tests) — never touches the network.
 */
export class FakeChainReader implements ChainReader {
  latest: bigint;
  /** height (as string) -> hash override, used to simulate a reorg at a specific height; every other height hashes deterministically on demand. */
  blockHashOverrides = new Map<string, string>();
  logsByRange: RawEvmLog[] = [];
  /** Default enrichment returned for any address not present in enrichmentByAddress. */
  defaultEnrichment: EnrichmentTuple | "FAIL" | null = { supply: 1_000_000_000_000_000_000_000_000_000n, isToken0: true, poolFee: 10_000 };
  enrichmentByAddress = new Map<string, EnrichmentTuple | "FAIL">();
  getLogsUnavailableOnce = 0;
  getBlockRefUnavailableHeights = new Set<string>();

  constructor(latest: bigint) {
    this.latest = latest;
  }

  setBlockHash(height: bigint, hash: string): void {
    this.blockHashOverrides.set(height.toString(), hash);
  }

  async getBlockNumber(): Promise<ChainClientResult<bigint>> {
    return ok(this.latest);
  }

  async getBlockRef(blockNumber: bigint): Promise<ChainClientResult<RawBlockRef>> {
    if (this.getBlockRefUnavailableHeights.has(blockNumber.toString())) {
      return fail(`simulated getBlockRef failure at ${blockNumber.toString()}`);
    }
    const hash = this.blockHashOverrides.get(blockNumber.toString()) ?? `0xhash-${blockNumber.toString()}`;
    return ok({ number: blockNumber, hash });
  }

  async getLogs(params: { address: string | string[]; event: AbiEvent; fromBlock: bigint; toBlock: bigint }): Promise<ChainClientResult<RawEvmLog[]>> {
    if (this.getLogsUnavailableOnce > 0) {
      this.getLogsUnavailableOnce -= 1;
      return fail("simulated getLogs failure");
    }
    const addresses = new Set((Array.isArray(params.address) ? params.address : [params.address]).map((a) => a.toLowerCase()));
    const inRange = this.logsByRange.filter((l) => l.blockNumber >= params.fromBlock && l.blockNumber <= params.toBlock && addresses.has(l.address.toLowerCase()));
    return ok(inRange);
  }

  async readContract<T>(params: { address: string; functionName: string; args: readonly unknown[] }): Promise<ChainClientResult<T>> {
    const key = typeof params.args[0] === "string" ? (params.args[0] as string).toLowerCase() : undefined;
    const override = key ? this.enrichmentByAddress.get(key) : undefined;
    const resolved = override ?? this.defaultEnrichment;
    if (resolved === "FAIL" || resolved === null) {
      return fail(`simulated enrichment failure for ${key ?? "<unknown>"}`);
    }
    return ok(resolved as unknown as T);
  }
}

let addressCounter = 1;
/** Deterministic, distinct 20-byte hex addresses for burst/scaling tests that need many of them. */
export function nextTestAddress(): `0x${string}` {
  const hex = addressCounter.toString(16).padStart(40, "0");
  addressCounter += 1;
  return `0x${hex}`;
}

const FACTORY_ADDRESS = TEST_CONFIG.factoryAddress as `0x${string}`;

/**
 * Builds a real, decodable TokenLaunched log (via viem's own ABI
 * encoding, not a hand-typed hex blob) for an arbitrary token/pool address
 * pair — used by the batch-enrichment and burst-discovery tests, which
 * need many distinct tokens in one tick rather than the single real
 * captured fixture.
 */
export function makeTokenLaunchedLog(params: {
  token: `0x${string}`;
  deployer?: `0x${string}`;
  pool: `0x${string}`;
  pairToken?: `0x${string}`;
  blockNumber: bigint;
  txHash?: `0x${string}`;
  logIndex?: number;
}): RawEvmLog {
  const deployer = params.deployer ?? (`0x${"d0".repeat(20)}` as `0x${string}`);
  const pairToken = params.pairToken ?? (TEST_CONFIG.quoteAddress as `0x${string}`);
  const eventAbi = getAbiItem({ abi: PONS_FACTORY_ABI, name: "TokenLaunched" });
  const topics = encodeEventTopics({
    abi: PONS_FACTORY_ABI,
    eventName: "TokenLaunched",
    args: { token: params.token, deployer, dexFactory: FACTORY_ADDRESS },
  });
  const nonIndexed = eventAbi.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(nonIndexed, [params.pool, pairToken, 1n, 1n, 1n, 0n, 0n]);
  return {
    address: FACTORY_ADDRESS,
    topics: topics as readonly `0x${string}`[],
    data,
    blockNumber: params.blockNumber,
    blockHash: `0xhash-${params.blockNumber.toString()}`,
    transactionHash: params.txHash ?? `0xtx-launch-${params.token}`,
    logIndex: params.logIndex ?? 0,
  };
}

/** Same idea as makeTokenLaunchedLog, for a Uniswap V3 Swap on an arbitrary pool. */
export function makeSwapLog(params: {
  pool: `0x${string}`;
  sender?: `0x${string}`;
  recipient?: `0x${string}`;
  amount0: bigint;
  amount1: bigint;
  blockNumber: bigint;
  txHash?: `0x${string}`;
  logIndex?: number;
}): RawEvmLog {
  const sender = params.sender ?? (`0x${"5e".repeat(20)}` as `0x${string}`);
  const recipient = params.recipient ?? (`0x${"7e".repeat(20)}` as `0x${string}`);
  const eventAbi = getAbiItem({ abi: UNISWAP_V3_POOL_ABI, name: "Swap" });
  const topics = encodeEventTopics({ abi: UNISWAP_V3_POOL_ABI, eventName: "Swap", args: { sender, recipient } });
  const nonIndexed = eventAbi.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(nonIndexed, [params.amount0, params.amount1, 0n, 0n, 0]);
  return {
    address: params.pool,
    topics: topics as readonly `0x${string}`[],
    data,
    blockNumber: params.blockNumber,
    blockHash: `0xhash-${params.blockNumber.toString()}`,
    transactionHash: params.txHash ?? `0xtx-swap-${params.pool}-${params.blockNumber.toString()}`,
    logIndex: params.logIndex ?? 0,
  };
}

/** Wraps a ChainReader, counting concurrent in-flight readContract calls so bounded-concurrency tests can assert the observed peak never exceeded the configured limit. */
export function withReadContractConcurrencyTracking(reader: ChainReader, onPeak: (peak: number) => void): ChainReader {
  let current = 0;
  let peak = 0;
  return {
    getBlockNumber: () => reader.getBlockNumber(),
    getBlockRef: (blockNumber) => reader.getBlockRef(blockNumber),
    getLogs: (params) => reader.getLogs(params),
    async readContract<T>(params: { address: string; abi: import("viem").Abi; functionName: string; args: readonly unknown[] }): Promise<ChainClientResult<T>> {
      current += 1;
      peak = Math.max(peak, current);
      onPeak(peak);
      try {
        return await reader.readContract<T>(params);
      } finally {
        current -= 1;
      }
    },
  };
}

/** Same idea, for chunked eth_getLogs concurrency in the trade listener. */
export function withGetLogsConcurrencyTracking(reader: ChainReader, onPeak: (peak: number) => void): ChainReader {
  let current = 0;
  let peak = 0;
  return {
    getBlockNumber: () => reader.getBlockNumber(),
    getBlockRef: (blockNumber) => reader.getBlockRef(blockNumber),
    async readContract<T>(params: { address: string; abi: import("viem").Abi; functionName: string; args: readonly unknown[] }): Promise<ChainClientResult<T>> {
      return reader.readContract<T>(params);
    },
    async getLogs(params: { address: string | string[]; event: AbiEvent; fromBlock: bigint; toBlock: bigint }): Promise<ChainClientResult<RawEvmLog[]>> {
      current += 1;
      peak = Math.max(peak, current);
      onPeak(peak);
      try {
        return await reader.getLogs(params);
      } finally {
        current -= 1;
      }
    },
  };
}
