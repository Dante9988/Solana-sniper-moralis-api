/**
 * Phase 5B — typed, read-only Solana/Helius forensic client.
 *
 * Read-only RPC only. No transaction submission, signing, or wallet
 * material anywhere in this file. Encodes the observed capability-smoke-test
 * behavior (phase4-5.txt §3, phase5b.txt §4): `getTransactionsForAddress`
 * takes POSITIONAL params `[address, options]`; DAS `getTokenAccounts` takes
 * its documented single OBJECT param.
 */

import { z } from "zod";
import {
  AccountInfoResult,
  AccountInfoResultSchema,
  DasTokenAccountsResult,
  DasTokenAccountsResultSchema,
  GetTransactionResult,
  GetTransactionResultSchema,
  JsonRpcEnvelopeSchema,
  MultipleAccountsResult,
  MultipleAccountsResultSchema,
  parseJsonPreservingIntegerFields,
  SignaturesForAddressResult,
  SignaturesForAddressResultSchema,
  TokenLargestAccountsResult,
  TokenLargestAccountsResultSchema,
  TokenSupplyResult,
  TokenSupplyResultSchema,
  TransactionsForAddressResult,
  TransactionsForAddressResultSchema,
} from "./rpcSchemas";
import { RequestBudget } from "./requestBudget";
import { ForensicsClientRuntimeConfig, RESOLVED_FORENSICS_CLIENT_CONFIG, resolveHeliusRpcUrl } from "./forensicsConfig";
import { CoverageStatus } from "./types";

export type ForensicsClientFailureCode =
  | "NOT_CONFIGURED"
  | "INVALID_REQUEST"
  | "AUTHENTICATION_FAILED"
  | "ACCESS_DENIED"
  | "RATE_LIMITED"
  | "BUDGET_EXHAUSTED"
  | "TIMEOUT"
  | "ABORTED"
  | "RESPONSE_TOO_LARGE"
  | "INVALID_RESPONSE"
  | "RPC_ERROR"
  | "NETWORK_ERROR";

export type ForensicsClientResult<T> =
  | { status: "AVAILABLE"; data: T; source: string; fetchedAt: Date; contextSlot?: number; estimatedCredits: number }
  | {
      status: "PARTIAL";
      data: T;
      source: string;
      fetchedAt: Date;
      reason: string;
      estimatedCredits: number;
    }
  | {
      status: "UNAVAILABLE";
      source: string;
      fetchedAt: Date;
      code: ForensicsClientFailureCode;
      reason: string;
      estimatedCredits: number;
    };

const SOURCE = "HELIUS_RPC";
const SOURCE_DAS = "HELIUS_DAS";

/** Never let a caught error's own message/stack (which can echo request config) leak the RPC URL or headers. */
function sanitizeReason(message: string): string {
  return message
    .replace(/https?:\/\/[^\s"']+/gi, "[redacted-url]")
    .replace(/api[-_]?key["'=:\s]+[^\s"'&]+/gi, "api-key=[redacted]")
    .slice(0, 500);
}

function unavailable<T>(
  source: string,
  code: ForensicsClientFailureCode,
  reason: string,
  estimatedCredits: number
): ForensicsClientResult<T> {
  return { status: "UNAVAILABLE", source, fetchedAt: new Date(), code, reason: sanitizeReason(reason), estimatedCredits };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true }
    );
  });
}

function parseRetryAfter(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(headerValue);
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? delta : 0;
  }
  return undefined;
}

function backoffDelay(attempt: number, base: number, cap: number): number {
  const exp = Math.min(cap, base * 2 ** attempt);
  return Math.floor(exp / 2 + Math.random() * (exp / 2));
}

interface RpcCallOptions<T> {
  method: string;
  params: unknown;
  schema: z.ZodType<T>;
  estimatedCredits: number;
  bigIntFields?: string[];
  source?: string;
  signal?: AbortSignal;
  extractContextSlot?: (data: T) => number | undefined;
}

export interface SolanaForensicsClientOptions {
  /** Defaults to `resolveHeliusRpcUrl()`. Never logged, persisted, or returned by any method. */
  rpcUrl?: string;
  budget: RequestBudget;
  runtimeConfig?: ForensicsClientRuntimeConfig;
  /** Overrides `RESOLVED_FORENSICS_CLIENT_CONFIG.totalDeadlineMs` for this instance. */
  totalDeadlineMs?: number;
  /** Injectable for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests. */
  now?: () => Date;
  /** External caller-provided abort signal, combined with internal timeout/deadline controllers on every request. */
  signal?: AbortSignal;
}

let requestCounter = 0;

export class SolanaForensicsClient {
  private readonly rpcUrl: string | undefined;
  private readonly budget: RequestBudget;
  private readonly config: ForensicsClientRuntimeConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly externalSignal?: AbortSignal;
  private readonly deadlineAt: number;

  constructor(options: SolanaForensicsClientOptions) {
    this.rpcUrl = options.rpcUrl ?? resolveHeliusRpcUrl();
    this.budget = options.budget;
    this.config = options.runtimeConfig ?? RESOLVED_FORENSICS_CLIENT_CONFIG;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.externalSignal = options.signal;
    this.deadlineAt = this.now().getTime() + (options.totalDeadlineMs ?? this.config.totalDeadlineMs);
  }

  private async rpcCall<T>(opts: RpcCallOptions<T>): Promise<ForensicsClientResult<T>> {
    const source = opts.source ?? SOURCE;

    if (!this.rpcUrl) {
      return unavailable(source, "NOT_CONFIGURED", "Helius RPC URL is not configured", 0);
    }
    if (this.now().getTime() >= this.deadlineAt) {
      return unavailable(source, "TIMEOUT", "total analysis deadline exceeded before issuing request", 0);
    }
    if (this.externalSignal?.aborted) {
      return unavailable(source, "ABORTED", "caller aborted before issuing request", 0);
    }

    let lastFailure: ForensicsClientResult<T> | undefined;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      if (this.now().getTime() >= this.deadlineAt) {
        return unavailable(source, "TIMEOUT", "total analysis deadline exceeded before retry", 0);
      }
      if (!this.budget.reserve(opts.method, opts.estimatedCredits)) {
        return unavailable(source, "BUDGET_EXHAUSTED", `credit budget exhausted for ${opts.method}`, opts.estimatedCredits);
      }

      const timeoutController = new AbortController();
      const remainingMs = Math.max(0, this.deadlineAt - this.now().getTime());
      const perRequestTimeout = Math.min(this.config.requestTimeoutMs, remainingMs);
      const timer = setTimeout(() => timeoutController.abort(), perRequestTimeout);

      const signals: AbortSignal[] = [timeoutController.signal];
      if (this.externalSignal) signals.push(this.externalSignal);
      const combinedSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

      const requestId = `forensics-${++requestCounter}`;
      let result: ForensicsClientResult<T>;
      try {
        result = await this.attemptOnce(opts, requestId, combinedSignal);
      } finally {
        clearTimeout(timer);
      }

      if (result.status !== "UNAVAILABLE") {
        this.budget.recordCompletion(opts.estimatedCredits);
        return result;
      }

      // Reclassify a generically-timed-out attempt as ABORTED if it was the
      // caller's own signal that fired, not our internal timeout.
      if (result.code === "TIMEOUT" && this.externalSignal?.aborted) {
        result = { ...result, code: "ABORTED", reason: "caller aborted the request" };
      }

      this.budget.recordCompletion(opts.estimatedCredits);
      lastFailure = result;

      const retryable =
        result.code === "RATE_LIMITED" || (result.code === "RPC_ERROR" && result.reason.includes("retryable"));
      if (!retryable || attempt === this.config.maxRetries) break;

      const retryAfterHeader = (result as { retryAfterMs?: number }).retryAfterMs;
      const delay = retryAfterHeader ?? backoffDelay(attempt, this.config.baseRetryDelayMs, this.config.maxRetryDelayMs);
      const sleepBudget = this.deadlineAt - this.now().getTime();
      if (sleepBudget <= 0) break;
      try {
        await sleep(Math.min(delay, sleepBudget), this.externalSignal);
      } catch {
        return unavailable(source, "ABORTED", "caller aborted while waiting to retry", 0);
      }
    }

    return lastFailure ?? unavailable(source, "NETWORK_ERROR", "request failed with no further detail", 0);
  }

  private async attemptOnce<T>(
    opts: RpcCallOptions<T>,
    requestId: string,
    signal: AbortSignal
  ): Promise<ForensicsClientResult<T>> {
    const source = opts.source ?? SOURCE;
    let res: Response;
    try {
      res = await this.fetchImpl(this.rpcUrl as string, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method: opts.method, params: opts.params }),
        signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return unavailable(source, "TIMEOUT", "request timed out", opts.estimatedCredits);
      }
      return unavailable(
        source,
        "NETWORK_ERROR",
        err instanceof Error ? err.message : "network request failed",
        opts.estimatedCredits
      );
    }

    const contentLength = res.headers.get("content-length");
    if (contentLength && Number(contentLength) > this.config.maxResponseBytes) {
      return unavailable(source, "RESPONSE_TOO_LARGE", "response exceeded the configured size limit", opts.estimatedCredits);
    }

    if (!res.ok) {
      const retryAfterMs = res.status === 429 ? parseRetryAfter(res.headers.get("retry-after")) : undefined;
      const mapped = mapHttpStatus(res.status);
      return { ...unavailable(source, mapped.code, mapped.reason, opts.estimatedCredits), ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) } as ForensicsClientResult<T>;
    }

    let text: string;
    try {
      text = await res.text();
    } catch {
      return unavailable(source, "NETWORK_ERROR", "failed to read response body", opts.estimatedCredits);
    }
    if (text.length > this.config.maxResponseBytes) {
      return unavailable(source, "RESPONSE_TOO_LARGE", "response exceeded the configured size limit", opts.estimatedCredits);
    }

    let json: unknown;
    try {
      json = opts.bigIntFields?.length
        ? parseJsonPreservingIntegerFields(text, opts.bigIntFields)
        : JSON.parse(text);
    } catch {
      return unavailable(source, "INVALID_RESPONSE", "response was not valid JSON", opts.estimatedCredits);
    }

    const envelope = JsonRpcEnvelopeSchema.safeParse(json);
    if (!envelope.success) {
      return unavailable(source, "INVALID_RESPONSE", "response failed JSON-RPC envelope validation", opts.estimatedCredits);
    }
    if (envelope.data.id !== requestId) {
      return unavailable(source, "INVALID_RESPONSE", "mismatched JSON-RPC id", opts.estimatedCredits);
    }
    if (envelope.data.error) {
      const retryable = isRetryableRpcError(envelope.data.error.code);
      return unavailable(
        source,
        "RPC_ERROR",
        `${envelope.data.error.message}${retryable ? " (retryable)" : ""}`,
        opts.estimatedCredits
      );
    }

    const parsed = opts.schema.safeParse(envelope.data.result);
    if (!parsed.success) {
      return unavailable(source, "INVALID_RESPONSE", "result failed schema validation", opts.estimatedCredits);
    }

    return {
      status: "AVAILABLE",
      data: parsed.data,
      source,
      fetchedAt: this.now(),
      contextSlot: opts.extractContextSlot?.(parsed.data),
      estimatedCredits: opts.estimatedCredits,
    };
  }

  // ---- Typed read-only methods ----

  async getTokenAccountsByMint(
    mint: string,
    params: { limit?: number; cursor?: string; page?: number; showZeroBalance?: boolean } = {}
  ): Promise<ForensicsClientResult<DasTokenAccountsResult>> {
    return this.rpcCall({
      method: "getTokenAccounts",
      params: {
        mint,
        limit: params.limit ?? 1000,
        ...(params.cursor ? { cursor: params.cursor } : {}),
        ...(params.page !== undefined ? { page: params.page } : {}),
        ...(params.showZeroBalance !== undefined ? { options: { showZeroBalance: params.showZeroBalance } } : {}),
      },
      schema: DasTokenAccountsResultSchema,
      estimatedCredits: 10,
      bigIntFields: ["amount", "delegated_amount"],
      source: SOURCE_DAS,
      extractContextSlot: (data) => data.last_indexed_slot,
    });
  }

  /** Bounded pagination loop. Never aggregates by owner — that is Phase 5C's job. */
  async getTokenAccountsPaginated(
    mint: string,
    opts: { maxPages: number; limit?: number; showZeroBalance?: boolean }
  ): Promise<{
    status: CoverageStatus;
    pagesFetched: number;
    pages: DasTokenAccountsResult[];
    contextSlot?: number;
    warnings: string[];
  }> {
    const pages: DasTokenAccountsResult[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let pagesFetched = 0;
    const warnings: string[] = [];
    let status: CoverageStatus = "UNAVAILABLE";
    let contextSlot: number | undefined;

    while (pagesFetched < opts.maxPages) {
      const result = await this.getTokenAccountsByMint(mint, {
        limit: opts.limit ?? 1000,
        cursor,
        showZeroBalance: opts.showZeroBalance,
      });
      if (result.status === "UNAVAILABLE") {
        warnings.push(`page ${pagesFetched + 1}: ${result.code} ${result.reason}`);
        status = pagesFetched > 0 ? "PARTIAL" : "UNAVAILABLE";
        break;
      }
      pagesFetched += 1;
      pages.push(result.data);
      if (result.status === "AVAILABLE") contextSlot = result.contextSlot ?? contextSlot;

      const nextCursor = result.data.cursor ?? undefined;
      if (!nextCursor) {
        status = "COMPLETE";
        break;
      }
      if (seenCursors.has(nextCursor)) {
        warnings.push("pagination-loop detected: repeated cursor");
        status = "PARTIAL";
        break;
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
      if (pagesFetched >= opts.maxPages) {
        status = "PARTIAL";
        warnings.push("maximum holder pages reached");
      }
    }

    return { status, pagesFetched, pages, contextSlot, warnings };
  }

  /** Positional params `[address, options]` — verified by the Phase 5 capability smoke test. */
  async getTransactionsForAddress(
    address: string,
    options: {
      transactionDetails?: "signatures" | "full";
      limit?: number;
      paginationToken?: string;
      sortOrder?: "asc" | "desc";
      commitment?: "confirmed" | "finalized";
      startSlot?: number;
      endSlot?: number;
    } = {}
  ): Promise<ForensicsClientResult<TransactionsForAddressResult>> {
    const merged = { transactionDetails: "signatures", limit: 25, ...options } as const;
    return this.rpcCall({
      method: "getTransactionsForAddress",
      // "full" mode is requested with jsonParsed encoding, matching getTransaction,
      // so item.transaction/meta validate against the same parsed schemas.
      params: [address, merged.transactionDetails === "full" ? { ...merged, encoding: "jsonParsed" } : merged],
      schema: TransactionsForAddressResultSchema,
      estimatedCredits: 10,
    });
  }

  async getTransactionsForAddressPaginated(
    address: string,
    opts: {
      maxPages: number;
      limit?: number;
      transactionDetails?: "signatures" | "full";
      sortOrder?: "asc" | "desc";
    }
  ): Promise<{
    status: CoverageStatus;
    pagesFetched: number;
    items: TransactionsForAddressResult["data"];
    warnings: string[];
  }> {
    const items: TransactionsForAddressResult["data"] = [];
    const seenTokens = new Set<string>();
    let paginationToken: string | undefined;
    let pagesFetched = 0;
    const warnings: string[] = [];
    let status: CoverageStatus = "UNAVAILABLE";

    while (pagesFetched < opts.maxPages) {
      const result = await this.getTransactionsForAddress(address, {
        transactionDetails: opts.transactionDetails ?? "signatures",
        limit: opts.limit ?? 100,
        sortOrder: opts.sortOrder,
        paginationToken,
      });
      if (result.status === "UNAVAILABLE") {
        warnings.push(`page ${pagesFetched + 1}: ${result.code} ${result.reason}`);
        status = pagesFetched > 0 ? "PARTIAL" : "UNAVAILABLE";
        break;
      }
      pagesFetched += 1;
      items.push(...result.data.data);

      const nextToken = result.data.paginationToken ?? undefined;
      if (!nextToken) {
        status = "COMPLETE";
        break;
      }
      if (seenTokens.has(nextToken)) {
        warnings.push("pagination-loop detected: repeated paginationToken");
        status = "PARTIAL";
        break;
      }
      seenTokens.add(nextToken);
      paginationToken = nextToken;
      if (pagesFetched >= opts.maxPages) {
        status = "PARTIAL";
        warnings.push("maximum transaction pages reached");
      }
    }

    return { status, pagesFetched, items, warnings };
  }

  /**
   * `encoding: "jsonParsed"` so the RPC node decodes well-known-program
   * instructions (System/SPL-Token/Token-2022) and resolves address-lookup-
   * table accounts inline, instead of Phase 5C hand-decoding base58
   * instruction data or manually merging ALT-loaded addresses.
   */
  async getTransaction(
    signature: string,
    options: { commitment?: "confirmed" | "finalized"; maxSupportedTransactionVersion?: number } = {}
  ): Promise<ForensicsClientResult<GetTransactionResult>> {
    return this.rpcCall({
      method: "getTransaction",
      params: [signature, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed", ...options }],
      schema: GetTransactionResultSchema,
      estimatedCredits: 1,
    });
  }

  /** Fallback per phase5.txt hierarchy — prefer `getTransactionsForAddress` where available. */
  async getSignaturesForAddress(
    address: string,
    options: { limit?: number; before?: string; until?: string } = {}
  ): Promise<ForensicsClientResult<SignaturesForAddressResult>> {
    return this.rpcCall({
      method: "getSignaturesForAddress",
      params: [address, { limit: 25, ...options }],
      schema: SignaturesForAddressResultSchema,
      estimatedCredits: 1,
    });
  }

  async getTokenSupply(mint: string): Promise<ForensicsClientResult<TokenSupplyResult>> {
    return this.rpcCall({
      method: "getTokenSupply",
      params: [mint],
      schema: TokenSupplyResultSchema,
      estimatedCredits: 1,
      bigIntFields: ["amount"],
      extractContextSlot: (data) => data.context.slot,
    });
  }

  /** Top-20-limited fallback only — can never represent complete holder coverage. */
  async getTokenLargestAccounts(mint: string): Promise<ForensicsClientResult<TokenLargestAccountsResult>> {
    const result = await this.rpcCall({
      method: "getTokenLargestAccounts",
      params: [mint],
      schema: TokenLargestAccountsResultSchema,
      estimatedCredits: 1,
      bigIntFields: ["amount"],
      extractContextSlot: (data) => data.context.slot,
    });
    if (result.status === "AVAILABLE") {
      return {
        status: "PARTIAL",
        data: result.data,
        source: result.source,
        fetchedAt: result.fetchedAt,
        reason: "getTokenLargestAccounts is a top-20-limited fallback and can never prove complete holder coverage",
        estimatedCredits: result.estimatedCredits,
      };
    }
    return result;
  }

  async getAccountInfo(
    address: string,
    options: { commitment?: "confirmed" | "finalized" } = {}
  ): Promise<ForensicsClientResult<AccountInfoResult>> {
    return this.rpcCall({
      method: "getAccountInfo",
      params: [address, { encoding: "base64", ...options }],
      schema: AccountInfoResultSchema,
      estimatedCredits: 1,
      extractContextSlot: (data) => data.context.slot,
    });
  }

  async getMultipleAccounts(
    addresses: string[],
    options: { commitment?: "confirmed" | "finalized" } = {}
  ): Promise<ForensicsClientResult<MultipleAccountsResult>> {
    return this.rpcCall({
      method: "getMultipleAccounts",
      params: [addresses, { encoding: "base64", ...options }],
      schema: MultipleAccountsResultSchema,
      estimatedCredits: 1,
      extractContextSlot: (data) => data.context.slot,
    });
  }
}

/**
 * The subset of `SolanaForensicsClient` that Phase 5C analyzers depend on.
 * `SolanaForensicsClient` satisfies this structurally — analyzers take this
 * interface (not the concrete class) so tests can inject a fake without
 * mocking `fetch`, and so analyzers can never reach any client method this
 * interface doesn't list.
 */
export interface ForensicsRpcClient {
  getTokenAccountsByMint: SolanaForensicsClient["getTokenAccountsByMint"];
  getTokenAccountsPaginated: SolanaForensicsClient["getTokenAccountsPaginated"];
  getTransactionsForAddress: SolanaForensicsClient["getTransactionsForAddress"];
  getTransactionsForAddressPaginated: SolanaForensicsClient["getTransactionsForAddressPaginated"];
  getTransaction: SolanaForensicsClient["getTransaction"];
  getSignaturesForAddress: SolanaForensicsClient["getSignaturesForAddress"];
  getTokenSupply: SolanaForensicsClient["getTokenSupply"];
  getTokenLargestAccounts: SolanaForensicsClient["getTokenLargestAccounts"];
  getAccountInfo: SolanaForensicsClient["getAccountInfo"];
  getMultipleAccounts: SolanaForensicsClient["getMultipleAccounts"];
}

function mapHttpStatus(status: number): { code: ForensicsClientFailureCode; reason: string } {
  if (status === 400) return { code: "INVALID_REQUEST", reason: `HTTP 400: invalid request` };
  if (status === 401) return { code: "AUTHENTICATION_FAILED", reason: "HTTP 401: authentication failed" };
  if (status === 403) return { code: "ACCESS_DENIED", reason: "HTTP 403: access denied" };
  if (status === 404) return { code: "INVALID_REQUEST", reason: "HTTP 404: not found" };
  if (status === 429) return { code: "RATE_LIMITED", reason: "HTTP 429: rate limited" };
  if (status === 502 || status === 503 || status === 504) {
    return { code: "RPC_ERROR", reason: `HTTP ${status}: retryable server error` };
  }
  if (status >= 500) return { code: "RPC_ERROR", reason: `HTTP ${status}: server error` };
  return { code: "RPC_ERROR", reason: `HTTP ${status}: unexpected response` };
}

function isRetryableRpcError(code: number): boolean {
  // Solana/Helius JSON-RPC server-error range; treated as non-retryable by
  // default since a 200-with-error body rarely resolves on repeat, except the
  // narrow long/short-term-unavailable codes below.
  return code === -32005 /* node unhealthy / rate-limited */;
}
