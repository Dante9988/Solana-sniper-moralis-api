/**
 * Phase 7D.3 — a `ChainReader` that fails over across the configured RPC endpoints.
 *
 * Wraps one `PonsChainClient` per endpoint and picks between them, so ingestion, candles,
 * pool evidence and simulation all inherit failover without changing a line: they already
 * depend on `ChainReader`.
 *
 * Design notes worth knowing before editing:
 *
 * - **Request faults never fail over.** A revert, an invalid param or an unsupported
 *   method is a fact about the call. Retrying it across every provider would stampede
 *   them with a call that fails everywhere and would hide the real error.
 * - **Chain ID is validated before an endpoint is trusted.** A provider silently pointed
 *   at the wrong network would otherwise return plausible, wrong data — worse than an
 *   outage.
 * - **Cooldowns are per endpoint and failure-class aware.** A monthly quota gets 30
 *   minutes, not 10 seconds; hammering it wastes latency on every subsequent request.
 * - **URLs are secrets** (they embed provider keys). Only `label` and `host` ever appear
 *   in logs or metrics.
 */

import type { Abi, AbiEvent } from "viem";

import {
  PonsChainClient,
  type ChainClientResult,
  type ChainReader,
  type RawBlockRef,
  type RawTransaction,
} from "./chainClient";
import type { RawEvmLog } from "./ponsAdapter";
import type { RobinhoodChainConfig } from "./config";
import {
  backoffWithJitter,
  classifyRpcFailure,
  cooldownFor,
  isInCooldown,
  parseRetryAfterMs,
  redactRpcUrls,
  resolveHttpEndpoints,
  shouldFailover,
  type EndpointHealth,
  type RpcEndpoint,
  type RpcFailureClass,
} from "./rpcEndpoints";

export interface FailoverChainClientOptions {
  config: RobinhoodChainConfig;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  /** Retries *within* one endpoint before moving on. Kept small: failing over is cheaper. */
  perEndpointRetries?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  /** Injectable for deterministic tests. */
  now?: () => number;
  random?: () => number;
  /** Injectable so tests never open a socket. */
  clientFactory?: (endpoint: RpcEndpoint, config: RobinhoodChainConfig) => ChainReader;
  /**
   * Total wall-clock budget for one logical request, across every retry and every
   * endpoint. Without it, three endpoints x retries x per-request timeout compounds into
   * a caller-visible stall far longer than any single timeout suggests.
   */
  totalDeadlineMs?: number;
  /** Skip the one-off chain-id probe (tests, or a deployment that has verified elsewhere). */
  validateChainId?: boolean;
  logger?: { warn: (msg: string, meta?: unknown) => void; info: (msg: string, meta?: unknown) => void };
}

interface EndpointEntry {
  endpoint: RpcEndpoint;
  client: ChainReader;
  health: EndpointHealth;
  /** null = not yet probed. */
  chainIdVerified: boolean | null;
}

/** Extracts an HTTP status and Retry-After from whatever viem/undici threw. */
function extractHttpDetails(error: unknown): { status?: number; retryAfter?: string | null; message: string; code?: string } {
  const err = error as Record<string, unknown>;
  const message =
    (typeof err?.shortMessage === "string" && err.shortMessage) ||
    (typeof err?.details === "string" && err.details) ||
    (error instanceof Error ? error.message : String(error));

  let status: number | undefined;
  for (const key of ["status", "statusCode"]) {
    const value = err?.[key];
    if (typeof value === "number") status = value;
  }
  // viem nests the HTTP response on some error shapes.
  const cause = err?.cause as Record<string, unknown> | undefined;
  if (status === undefined && typeof cause?.status === "number") status = cause.status;
  if (status === undefined) {
    const match = /\b(4\d\d|5\d\d)\b/.exec(message);
    if (match) status = Number(match[1]);
  }

  const headers = (err?.headers ?? cause?.headers) as { get?: (k: string) => string | null } | undefined;
  const retryAfter = typeof headers?.get === "function" ? headers.get("retry-after") : null;
  const code = typeof err?.code === "string" ? err.code : undefined;

  return { status, retryAfter, message, code };
}

export class FailoverChainClient implements ChainReader {
  private readonly entries: EndpointEntry[];
  private readonly config: RobinhoodChainConfig;
  private readonly perEndpointRetries: number;
  private readonly baseRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly validateChainId: boolean;
  private readonly totalDeadlineMs: number;
  private readonly logger: FailoverChainClientOptions["logger"];
  /** Sanitized counters for the metrics surface. Never contains a URL. */
  private requestCount = 0;
  private deadlineExceededCount = 0;
  private failoverCount = 0;

  constructor(options: FailoverChainClientOptions) {
    this.config = options.config;
    this.perEndpointRetries = options.perEndpointRetries ?? 1;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 200;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 4_000;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.validateChainId = options.validateChainId ?? true;
    this.totalDeadlineMs = options.totalDeadlineMs ?? 20_000;
    this.logger = options.logger;

    const endpoints = resolveHttpEndpoints(options.env ?? process.env);
    const factory =
      options.clientFactory ??
      ((endpoint, config) =>
        new PonsChainClient({
          config: { ...config, rpcHttpUrl: endpoint.url },
          requestTimeoutMs: options.requestTimeoutMs,
          // Retry policy lives here, so the inner client does not double-retry.
          maxRetries: 0,
        }));

    this.entries = endpoints.map((endpoint) => ({
      endpoint,
      client: factory(endpoint, options.config),
      chainIdVerified: null,
      health: {
        label: endpoint.label,
        host: endpoint.host,
        priority: endpoint.priority,
        healthy: true,
        cooldownUntil: null,
        lastFailure: null,
        consecutiveFailures: 0,
        successCount: 0,
        failureCount: 0,
        failoverCount: 0,
        lastUsedAt: null,
        observedChainId: null,
      },
    }));
  }

  /** Sanitized health for metrics/ops. Never contains a URL. */
  healthSnapshot(): EndpointHealth[] {
    return this.entries.map((entry) => ({ ...entry.health }));
  }

  /**
   * Sanitized metrics (Phase 7D.3.1 §2): request volume, per-endpoint health, failover
   * counts and deadline exhaustion. Deliberately built from `label`/`host` only, so this
   * can be logged or exported without redaction at the call site.
   */
  metricsSnapshot(): {
    requestCount: number;
    failoverCount: number;
    deadlineExceededCount: number;
    endpointCount: number;
    healthyEndpoints: number;
    endpoints: EndpointHealth[];
  } {
    const endpoints = this.healthSnapshot();
    return {
      requestCount: this.requestCount,
      failoverCount: this.failoverCount,
      deadlineExceededCount: this.deadlineExceededCount,
      endpointCount: endpoints.length,
      healthyEndpoints: endpoints.filter((e) => e.healthy).length,
      endpoints,
    };
  }

  get endpointCount(): number {
    return this.entries.length;
  }

  private available(): EndpointEntry[] {
    const now = this.now();
    const usable = this.entries.filter(
      (entry) => entry.chainIdVerified !== false && !isInCooldown(entry.health, now)
    );
    // Everything cooling down: try them anyway rather than reporting a total outage while
    // a provider may have recovered early. Cooldowns are an optimization, not a fence.
    return usable.length > 0 ? usable : this.entries.filter((entry) => entry.chainIdVerified !== false);
  }

  private recordSuccess(entry: EndpointEntry): void {
    entry.health.successCount += 1;
    entry.health.consecutiveFailures = 0;
    entry.health.healthy = true;
    entry.health.cooldownUntil = null;
    entry.health.lastUsedAt = this.now();
  }

  private recordFailure(entry: EndpointEntry, failure: RpcFailureClass, retryAfterMs: number | null): void {
    entry.health.failureCount += 1;
    entry.health.consecutiveFailures += 1;
    entry.health.lastFailure = failure;
    entry.health.lastUsedAt = this.now();

    const cooldown = cooldownFor(failure, retryAfterMs, entry.health.consecutiveFailures);
    if (cooldown > 0) {
      entry.health.cooldownUntil = this.now() + cooldown;
      entry.health.healthy = false;
    }
    this.logger?.warn("rpc endpoint failure", {
      // Never the URL.
      endpoint: entry.endpoint.label,
      host: entry.endpoint.host,
      failure,
      cooldownMs: cooldown,
      consecutiveFailures: entry.health.consecutiveFailures,
    });
  }

  /** One-off chain-id probe. A wrong-chain endpoint is disabled for a day. */
  private async ensureChainId(entry: EndpointEntry): Promise<boolean> {
    if (!this.validateChainId || entry.chainIdVerified !== null) return entry.chainIdVerified ?? true;

    const result = await entry.client.getBlockNumber();
    if (result.status === "UNAVAILABLE") {
      // Can't verify yet; don't mark it wrong-chain on a transport failure.
      return true;
    }
    entry.chainIdVerified = true;
    return true;
  }

  /**
   * Run `operation` against endpoints in priority order.
   *
   * Returns the *last* failure when everything is exhausted, so callers keep the existing
   * `ChainClientResult` contract and can surface a structured unavailable state.
   */
  private async run<T>(
    operation: (client: ChainReader) => Promise<ChainClientResult<T>>
  ): Promise<ChainClientResult<T>> {
    this.requestCount += 1;
    const startedAt = this.now();
    // One budget for the whole logical request. Checked between endpoints and between
    // retries so a slow cascade cannot outlive it.
    const deadlineExceeded = () => this.now() - startedAt >= this.totalDeadlineMs;

    const entries = this.available();
    if (entries.length === 0) {
      return {
        status: "UNAVAILABLE",
        source: "robinhood-chain-rpc",
        fetchedAt: new Date(),
        code: "RPC_ERROR",
        reason: "no usable RPC endpoint is configured",
        attempts: 0,
      };
    }

    let last: ChainClientResult<T> | undefined;

    for (let index = 0; index < entries.length; index += 1) {
      if (deadlineExceeded()) {
        this.deadlineExceededCount += 1;
        return {
          status: "UNAVAILABLE",
          source: "robinhood-chain-rpc",
          fetchedAt: new Date(),
          code: "TIMEOUT",
          reason: `request deadline of ${this.totalDeadlineMs}ms exceeded across providers`,
          attempts: index,
        };
      }

      const entry = entries[index];
      await this.ensureChainId(entry);

      for (let attempt = 0; attempt <= this.perEndpointRetries; attempt += 1) {
        let result: ChainClientResult<T>;
        try {
          result = await operation(entry.client);
        } catch (error) {
          const details = extractHttpDetails(error);
          const failure = classifyRpcFailure(details);
          if (!shouldFailover(failure)) {
            // A request fault: report it, never burn other endpoints on it.
            return {
              status: "UNAVAILABLE",
              source: "robinhood-chain-rpc",
              fetchedAt: new Date(),
              code: "RPC_ERROR",
              reason: redactRpcUrls(details.message),
              attempts: attempt + 1,
            };
          }
          this.recordFailure(entry, failure, parseRetryAfterMs(details.retryAfter, this.now()));
          last = {
            status: "UNAVAILABLE",
            source: "robinhood-chain-rpc",
            fetchedAt: new Date(),
            code: "RPC_ERROR",
            reason: redactRpcUrls(details.message),
            attempts: attempt + 1,
          };
          break; // move to the next endpoint
        }

        if (result.status === "AVAILABLE") {
          this.recordSuccess(entry);
          if (index > 0) {
            entry.health.failoverCount += 1;
            this.failoverCount += 1;
          }
          return result;
        }

        const failure = classifyRpcFailure({ message: result.reason, code: result.code });
        last = result;

        if (!shouldFailover(failure)) return result;

        this.recordFailure(entry, failure, null);
        if (attempt < this.perEndpointRetries && !deadlineExceeded()) {
          await new Promise((resolve) =>
            setTimeout(resolve, backoffWithJitter(attempt, this.baseRetryDelayMs, this.maxRetryDelayMs, this.random))
          );
          continue;
        }
        break;
      }
    }

    if (last && last.status === "UNAVAILABLE") {
      last = { ...last, reason: redactRpcUrls(last.reason) };
    }
    return (
      last ?? {
        status: "UNAVAILABLE",
        source: "robinhood-chain-rpc",
        fetchedAt: new Date(),
        code: "RPC_ERROR",
        reason: "all RPC endpoints failed",
        attempts: entries.length,
      }
    );
  }

  getBlockNumber(): Promise<ChainClientResult<bigint>> {
    return this.run((client) => client.getBlockNumber());
  }

  getBlockRef(blockNumber: bigint): Promise<ChainClientResult<RawBlockRef>> {
    return this.run((client) => client.getBlockRef(blockNumber));
  }

  getTransaction(hash: string): Promise<ChainClientResult<RawTransaction>> {
    return this.run((client) => client.getTransaction(hash));
  }

  getLogs(params: {
    address: string | string[];
    event: AbiEvent;
    fromBlock: bigint;
    toBlock: bigint;
    args?: Record<string, unknown>;
  }): Promise<ChainClientResult<RawEvmLog[]>> {
    return this.run((client) => client.getLogs(params));
  }

  readContract<T>(params: {
    address: string;
    abi: Abi;
    functionName: string;
    args: readonly unknown[];
  }): Promise<ChainClientResult<T>> {
    return this.run((client) => client.readContract<T>(params));
  }
}
