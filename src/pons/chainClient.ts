/**
 * Phase 7B.4 — read-only Robinhood Chain RPC client.
 *
 * Mirrors src/forensics/solanaForensicsClient.ts's outbound-call discipline
 * (timeouts, bounded retries with backoff, typed unavailable results
 * instead of thrown exceptions) adapted to viem/EVM instead of Helius/
 * Solana. Read-only: no transaction submission, no signing, no wallet
 * material anywhere in this file.
 */

import { createPublicClient, defineChain, http, type Abi, type PublicClient } from "viem";
import type { RobinhoodChainConfig } from "./config";
import type { RawEvmLog } from "./ponsAdapter";

export type ChainClientFailureCode = "TIMEOUT" | "RATE_LIMITED" | "NETWORK_ERROR" | "RPC_ERROR";

export type ChainClientResult<T> =
  | { status: "AVAILABLE"; data: T; source: string; fetchedAt: Date; attempts: number }
  | { status: "UNAVAILABLE"; source: string; fetchedAt: Date; code: ChainClientFailureCode; reason: string; attempts: number };

const SOURCE = "robinhood-chain-rpc";

function unavailable<T>(code: ChainClientFailureCode, reason: string, attempts: number): ChainClientResult<T> {
  return { status: "UNAVAILABLE", source: SOURCE, fetchedAt: new Date(), code, reason, attempts };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelay(attempt: number, base: number, cap: number): number {
  const exp = Math.min(cap, base * 2 ** attempt);
  return Math.floor(exp / 2 + Math.random() * (exp / 2));
}

function classifyError(err: unknown): { code: ChainClientFailureCode; reason: string; retryable: boolean } {
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "";
  if (name === "TimeoutError" || /timed? ?out/i.test(message)) {
    return { code: "TIMEOUT", reason: message, retryable: true };
  }
  if (/rate limit|429|too many requests/i.test(message)) {
    return { code: "RATE_LIMITED", reason: message, retryable: true };
  }
  if (name === "HttpRequestError" || /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|network/i.test(message)) {
    return { code: "NETWORK_ERROR", reason: message, retryable: true };
  }
  // RpcRequestError and similar: the node understood and rejected the
  // request (bad params, reverted call) — not retryable, retrying would
  // just reproduce the same error.
  return { code: "RPC_ERROR", reason: message, retryable: false };
}

export interface ChainClientOptions {
  config: RobinhoodChainConfig;
  requestTimeoutMs?: number;
  maxRetries?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  /** Injectable for tests, so a test can point at a local anvil/hardhat node or a stub transport without touching real infrastructure. */
  viemClient?: PublicClient;
}

export interface RawBlockRef {
  readonly number: bigint;
  readonly hash: string;
}

/**
 * The subset of PonsChainClient every listener actually depends on.
 * Extracted so tests can inject a fake chain simulator (canned blocks/logs,
 * no network) without touching real infrastructure — a class with private
 * fields can't be structurally satisfied by a plain object literal in
 * TypeScript, so this interface is the deliberate seam, mirroring
 * ForensicsWorkerDependencies.createRpcClient's injectability.
 */
export interface ChainReader {
  getBlockNumber(): Promise<ChainClientResult<bigint>>;
  getBlockRef(blockNumber: bigint): Promise<ChainClientResult<RawBlockRef>>;
  getLogs(params: {
    address: string | string[];
    event: import("viem").AbiEvent;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<ChainClientResult<RawEvmLog[]>>;
  readContract<T>(params: { address: string; abi: Abi; functionName: string; args: readonly unknown[] }): Promise<ChainClientResult<T>>;
}

export class PonsChainClient implements ChainReader {
  private readonly client: PublicClient;
  private readonly requestTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;

  constructor(options: ChainClientOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 8_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 200;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 4_000;

    this.client =
      options.viemClient ??
      (createPublicClient({
        chain: defineChain({
          id: options.config.chainId,
          name: "Robinhood Chain",
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: { default: { http: [options.config.rpcHttpUrl] } },
        }),
        transport: http(options.config.rpcHttpUrl, { timeout: this.requestTimeoutMs }),
      }) as PublicClient);
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<ChainClientResult<T>> {
    let lastFailure: ChainClientResult<T> | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const data = await fn();
        return { status: "AVAILABLE", data, source: SOURCE, fetchedAt: new Date(), attempts: attempt + 1 };
      } catch (err) {
        const { code, reason, retryable } = classifyError(err);
        lastFailure = unavailable(code, reason, attempt + 1);
        if (!retryable || attempt === this.maxRetries) break;
        await sleep(backoffDelay(attempt, this.baseRetryDelayMs, this.maxRetryDelayMs));
      }
    }
    return lastFailure as ChainClientResult<T>;
  }

  async getBlockNumber(): Promise<ChainClientResult<bigint>> {
    // viem's getBlockNumber defaults to caching for `client.cacheTime`
    // (== the transport's pollingInterval, 4s by default) — found via a
    // real-anvil reorg test (Phase 7B.5A) where mining new blocks between
    // two calls a few hundred ms apart still returned the pre-mine height.
    // A confirmation-lag/safe-tip calculation must always see the true
    // current tip, never a stale cached one — cacheTime: 0 forces a fresh
    // eth_blockNumber on every call.
    return this.withRetry(() => this.client.getBlockNumber({ cacheTime: 0 }));
  }

  async getBlockRef(blockNumber: bigint): Promise<ChainClientResult<RawBlockRef>> {
    return this.withRetry(async () => {
      const block = await this.client.getBlock({ blockNumber });
      return { number: block.number, hash: block.hash };
    });
  }

  /**
   * viem v2's getLogs only accepts an AbiEvent (`event`/`args`), not a raw
   * topics array — this wrapper's job is exactly to turn "which event, on
   * which address(es), in which range" into that shape, so callers never
   * hand-construct topic hex themselves (abi.ts's verified fragments are
   * the single source of truth for topic0).
   */
  async getLogs(params: {
    address: string | string[];
    event: import("viem").AbiEvent;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<ChainClientResult<RawEvmLog[]>> {
    return this.withRetry(async () => {
      const logs = await this.client.getLogs({
        address: params.address as `0x${string}` | `0x${string}`[],
        event: params.event,
        fromBlock: params.fromBlock,
        toBlock: params.toBlock,
      });
      return logs.map((log) => ({
        address: log.address,
        topics: log.topics,
        data: log.data,
        blockNumber: log.blockNumber as bigint,
        blockHash: log.blockHash as string,
        transactionHash: log.transactionHash as string,
        logIndex: log.logIndex as number,
      }));
    });
  }

  async readContract<T>(params: { address: string; abi: Abi; functionName: string; args: readonly unknown[] }): Promise<ChainClientResult<T>> {
    return this.withRetry(
      () =>
        this.client.readContract({
          address: params.address as `0x${string}`,
          abi: params.abi,
          functionName: params.functionName,
          args: params.args as never,
        }) as Promise<T>
    );
  }
}
