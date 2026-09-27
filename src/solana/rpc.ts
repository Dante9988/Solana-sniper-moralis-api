/**
 * Phase 7E.4.3 §2 — the one place Solana ingestion talks to an RPC node.
 *
 * This is deliberately NOT a provider abstraction (§2: "Do not introduce another RPC provider
 * abstraction"). It is a single-endpoint JSON-RPC caller over the endpoint the operator already
 * configured as `SOLANA_RPC_ENDPOINT`. There is no provider selection, no failover list and no
 * second vendor.
 *
 * Why it is not `SolanaForensicsClient`: that client is built for one-shot forensic analyses —
 * it fixes a total deadline at construction time and debits a `RequestBudget` per call, so a
 * long-running listener constructed once at boot would start returning TIMEOUT/BUDGET_EXHAUSTED
 * forever. The two have genuinely different lifetimes, not different vendors.
 *
 * Verified against the configured Alchemy mainnet endpoint on 2026-09-26:
 *   - `logsSubscribe` works over the same URL with the scheme swapped http(s) -> ws(s);
 *     `{"jsonrpc":"2.0","id":1,"result":946}` followed by live `logsNotification` frames.
 *   - notifications include FAILED transactions (`err: {"InstructionError":[3,{"Custom":6042}]}`),
 *     which is why every consumer must go through `findEvents`, which refuses a failed tx.
 *
 * Two rules this module exists to enforce:
 *
 *  1. The endpoint URL carries an API key. It is never logged, never returned in an error
 *     message, and never persisted. `describeEndpoint()` returns the host only.
 *  2. "Cannot read this transaction version" is its own outcome, never folded into a generic
 *     failure and never into an empty result — see src/solana/transactionVersion.ts.
 */

import { getTransactionConfig, isUnsupportedTransactionVersion } from "./transactionVersion";

export type SolanaCommitment = "processed" | "confirmed" | "finalized";

export interface SolanaRpcEndpoint {
  /** Full HTTP(S) URL including any API key. Never log this. */
  readonly httpUrl: string;
  /** Full WS(S) URL including any API key. Never log this. */
  readonly wsUrl: string;
}

/**
 * Resolves the ingestion endpoint. Only `SOLANA_RPC_ENDPOINT` is consulted for mainnet:
 * `RPC_ENDPOINT` / `HELIUS_HTTPS_URI` are other subsystems' historical variables and are
 * deliberately not read here, so ingestion cannot silently land on a different node than the
 * operator configured.
 *
 * The WebSocket URL is derived from the HTTP one by scheme swap unless `SOLANA_WS_ENDPOINT`
 * overrides it. Verified above; providers that need a different host require the override.
 */
export function resolveSolanaRpcEndpoint(env: NodeJS.ProcessEnv = process.env): SolanaRpcEndpoint | null {
  const httpUrl = env.SOLANA_RPC_ENDPOINT?.trim();
  if (!httpUrl) return null;
  const override = env.SOLANA_WS_ENDPOINT?.trim();
  return { httpUrl, wsUrl: override || httpUrl.replace(/^http/, "ws") };
}

/** Host only — safe to log. */
export function describeEndpoint(endpoint: SolanaRpcEndpoint): string {
  try {
    return new URL(endpoint.httpUrl).host;
  } catch {
    return "invalid-url";
  }
}

export type SolanaRpcOutcome<T> =
  | { readonly status: "OK"; readonly data: T }
  /** The node refused the request because the transaction is a version we cannot parse (§19). */
  | { readonly status: "UNSUPPORTED_TX_VERSION"; readonly reason: string }
  | { readonly status: "FAILED"; readonly reason: string };

interface JsonRpcResponse<T> {
  result?: T;
  error?: { code: number; message: string };
}

export interface SolanaRpcOptions {
  /** Injectable for tests. Defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Per-request timeout. */
  readonly requestTimeoutMs?: number;
}

/** What `getTransaction` gives us, narrowed to the fields ingestion reads. */
export interface FetchedTransaction {
  slot: number;
  blockTime: number | null;
  transactionIndex?: number;
  transaction: { signatures: string[]; message: { instructions: { programId: string; data?: string; accounts?: string[] }[] } };
  meta: { err: unknown; innerInstructions: { index: number; instructions: { programId: string; data: string; stackHeight?: number; accounts?: string[] }[] }[] | null };
}

export interface SignatureRef {
  readonly signature: string;
  readonly slot: number;
  readonly err: unknown;
  readonly blockTime: number | null;
}

/** The block-level identity Solana offers: its own blockhash, its parent's, and its time. */
export interface BlockIdentity {
  readonly blockhash: string;
  readonly previousBlockhash: string;
  readonly parentSlot: number;
  readonly blockTime: number | null;
}

let requestId = 0;

export class SolanaRpc {
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly endpoint: SolanaRpcEndpoint,
    options: SolanaRpcOptions = {}
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
  }

  get wsUrl(): string {
    return this.endpoint.wsUrl;
  }

  get host(): string {
    return describeEndpoint(this.endpoint);
  }

  async call<T>(method: string, params: unknown[]): Promise<SolanaRpcOutcome<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(this.endpoint.httpUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
        signal: controller.signal,
      });
      if (!response.ok) {
        // Status and method only — never the URL, which carries the key.
        return { status: "FAILED", reason: `${method} -> HTTP ${response.status}` };
      }
      const body = (await response.json()) as JsonRpcResponse<T>;
      if (body.error) {
        if (isUnsupportedTransactionVersion(body.error)) {
          return { status: "UNSUPPORTED_TX_VERSION", reason: `${method}: ${body.error.message}` };
        }
        return { status: "FAILED", reason: `${method}: [${body.error.code}] ${body.error.message}` };
      }
      if (body.result === undefined) return { status: "FAILED", reason: `${method}: response carried neither result nor error` };
      return { status: "OK", data: body.result };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { status: "FAILED", reason: `${method}: ${reason}` };
    } finally {
      clearTimeout(timer);
    }
  }

  async getSlot(commitment: SolanaCommitment): Promise<SolanaRpcOutcome<number>> {
    return this.call<number>("getSlot", [{ commitment }]);
  }

  /**
   * A transaction, or OK/null when the node has no record of it at this commitment. Null is a
   * real answer (not yet visible, or dropped), distinct from FAILED and from
   * UNSUPPORTED_TX_VERSION.
   */
  async getTransaction(signature: string, commitment: SolanaCommitment): Promise<SolanaRpcOutcome<FetchedTransaction | null>> {
    return this.call<FetchedTransaction | null>("getTransaction", [signature, getTransactionConfig({ encoding: "jsonParsed", commitment })]);
  }

  async getSignaturesForAddress(
    address: string,
    options: { limit?: number; before?: string; until?: string; commitment?: SolanaCommitment } = {}
  ): Promise<SolanaRpcOutcome<SignatureRef[]>> {
    return this.call<SignatureRef[]>("getSignaturesForAddress", [address, { ...options }]);
  }

  /**
   * The block's own identity, fetched with `transactionDetails: "none"` so the node returns
   * the header rather than every transaction in the slot. This is what gives a Solana fact a
   * real `sourceHash` — the containing block's blockhash — instead of a fabricated one.
   */
  async getBlockIdentity(slot: number, commitment: SolanaCommitment = "confirmed"): Promise<SolanaRpcOutcome<BlockIdentity | null>> {
    return this.call<BlockIdentity | null>("getBlock", [
      slot,
      { ...getTransactionConfig({ commitment }), transactionDetails: "none", rewards: false },
    ]);
  }

  /**
   * A mint's decimals, read from the mint account itself. Never assumed — pump.fun's own mints
   * and any quote mint are both read, because "6" and "9" are conventions, not guarantees.
   */
  async getMintDecimals(mint: string): Promise<SolanaRpcOutcome<number | null>> {
    const result = await this.call<{ value: { data?: { parsed?: { info?: { decimals?: unknown } } } } | null }>("getAccountInfo", [
      mint,
      { encoding: "jsonParsed", commitment: "confirmed" },
    ]);
    if (result.status !== "OK") return result;
    const decimals = result.data?.value?.data?.parsed?.info?.decimals;
    if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
      return { status: "OK", data: null };
    }
    return { status: "OK", data: decimals };
  }
}
