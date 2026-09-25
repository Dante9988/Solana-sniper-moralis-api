/**
 * Phase 7D.5.1 — Jupiter, as a non-custodial buy provider.
 *
 * Deliberately **not** an extension of `src/services/jupiterService.ts`, for one verified
 * reason: that service calls `quote-api.jup.ag/v6`, probed 2026-09-20 and unreachable
 * (HTTP 000).
 *
 * A correction to an earlier claim in this phase: that service is **not** custodial. It
 * holds no key material (`buildBuySwapTransaction` returns `transactionBase64` and its own
 * comment says "Does not sign or send anything"; `connectWallet` stores only a public
 * address). The custody concern was mine and was wrong — see
 * `docs/phase-7d5-1/gap-assessment.md`. What remains true is the dead endpoint, and that it
 * predates and does not implement this phase's shared buying contract.
 *
 * Verified live, 2026-09-20 (`docs/phase-7d5-1/source-matrix.md`):
 *   lite-api.jup.ag/swap/v1/quote  -> 200, no API key
 *   api.jup.ag/swap/v1/quote       -> 200, keyed tier
 * Quote response carries `outAmount`, `otherAmountThreshold` (the minimum for ExactIn),
 * `slippageBps`, `priceImpactPct`, `contextSlot`, `routePlan`, `platformFee`.
 *
 * This adapter returns an **unsigned** transaction for the user's wallet. No key material
 * enters this file.
 */

import { randomUUID } from "node:crypto";

import type { AssetIdentity } from "../assetIdentity";
import {
  assetRef,
  makeAmount,
  type BuyProvider,
  type BuyQuote,
  type Fee,
  type OrderState,
  type ProviderCapability,
  type QuoteRequest,
  type Requirement,
  type UnsignedExecution,
} from "../contract";

/** Free tier needs no key; the keyed host is used when one is configured. */
const FREE_HOST = "https://lite-api.jup.ag";
const KEYED_HOST = "https://api.jup.ag";

/**
 * Jupiter quotes move with the market and `contextSlot` pins them to a slot. Short on
 * purpose: a stale route is a worse outcome than asking the user to refresh.
 */
const QUOTE_TTL_MS = 20_000;

export interface JupiterQuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  /** For ExactIn this is the minimum out after slippage — the number that binds. */
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  contextSlot?: number;
  platformFee?: { amount: string; feeBps: number } | null;
  routePlan: unknown[];
}

export interface JupiterProviderOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Injected so tests never reach the network. */
  baseUrl?: string;
}

export class JupiterProvider implements BuyProvider {
  readonly id = "jupiter" as const;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly baseUrl: string;
  private readonly apiKey?: string;

  constructor(options: JupiterProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? (options.apiKey ? KEYED_HOST : FREE_HOST);
  }

  async capability(input: AssetIdentity, output: AssetIdentity): Promise<ProviderCapability> {
    if (input.network !== "solana" || output.network !== "solana") {
      return {
        provider: this.id,
        supported: false,
        // Named rather than "unsupported": the user's next action differs entirely.
        reason: "Jupiter routes Solana tokens only. This pair is not on Solana.",
        quoteOnly: false,
      };
    }
    if (input.address === null || output.address === null) {
      // SOL itself is represented by its wrapped mint on Jupiter, so a caller passing a
      // native identity has not resolved it yet — say so instead of guessing a mint.
      return {
        provider: this.id,
        supported: false,
        reason: "Native SOL must be given as its wrapped mint (So111...112) before quoting.",
        quoteOnly: false,
      };
    }
    return { provider: this.id, supported: true, reason: null, quoteOnly: false };
  }

  async quote(request: QuoteRequest): Promise<BuyQuote> {
    const capability = await this.capability(request.input, request.output);
    if (!capability.supported) throw new Error(capability.reason ?? "unsupported pair");

    const url = new URL("/swap/v1/quote", this.baseUrl);
    url.searchParams.set("inputMint", request.input.address!);
    url.searchParams.set("outputMint", request.output.address!);
    url.searchParams.set("amount", request.amountRaw);
    url.searchParams.set("slippageBps", String(request.slippageBps));

    const response = await this.fetchImpl(url.toString(), { headers: this.headers() });
    if (!response.ok) {
      throw new Error(`Jupiter quote failed: HTTP ${response.status}`);
    }
    const data = (await response.json()) as JupiterQuoteResponse;

    if (!data.routePlan || data.routePlan.length === 0) {
      // A route-less pair is a real product state, not an error to swallow.
      throw new Error(`No Jupiter route between ${request.input.symbol} and ${request.output.symbol} right now.`);
    }
    if (data.swapMode !== "ExactIn") {
      // otherAmountThreshold means the opposite bound under ExactOut; refuse rather than
      // report a maximum as if it were a minimum.
      throw new Error(`Unexpected Jupiter swapMode ${data.swapMode}; this flow quotes ExactIn only.`);
    }

    const fees: Fee[] = [];
    if (data.platformFee && data.platformFee.amount !== "0") {
      fees.push({ label: "Jupiter platform fee", kind: "provider", amount: makeAmount(data.platformFee.amount, request.output) });
    }

    const requirements: Requirement[] = [
      { kind: "connect_wallet", description: "Approve this swap in your Solana wallet.", actionable: true },
    ];

    return {
      quoteId: randomUUID(),
      provider: this.id,
      input: { asset: request.input, amount: makeAmount(data.inAmount, request.input) },
      output: {
        asset: request.output,
        expected: makeAmount(data.outAmount, request.output),
        // ExactIn: this is the floor the transaction enforces.
        minimumReceived: makeAmount(data.otherAmountThreshold, request.output),
      },
      fees,
      slippageBps: data.slippageBps,
      expiresAt: this.now() + QUOTE_TTL_MS,
      requirements,
      disclosures: [],
      boundTo: {
        account: request.account,
        network: "solana",
        inputAsset: assetRef(request.input),
        outputAsset: assetRef(request.output),
        inputRaw: request.amountRaw,
        slippageBps: request.slippageBps,
      },
      providerData: data,
    };
  }

  /**
   * Build the unsigned transaction.
   *
   * `assertExecutable` is the caller's job and runs first — this method exists so that the
   * transaction is built from the *provider data of the quote the user reviewed*, not from
   * a fresh quote that might differ from what they approved.
   */
  async prepare(quote: BuyQuote, request: QuoteRequest): Promise<UnsignedExecution> {
    const response = await this.fetchImpl(new URL("/swap/v1/swap", this.baseUrl).toString(), {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote.providerData,
        userPublicKey: request.account,
        // The wallet pays its own fees; there is no fee payer on our side because there is
        // no key on our side.
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
      }),
    });
    if (!response.ok) throw new Error(`Jupiter swap build failed: HTTP ${response.status}`);
    const built = (await response.json()) as { swapTransaction?: string; lastValidBlockHeight?: number };
    if (!built.swapTransaction) throw new Error("Jupiter returned no transaction to sign");
    return { kind: "solana_transaction", base64: built.swapTransaction, lastValidBlockHeight: built.lastValidBlockHeight };
  }

  /**
   * Jupiter does not track orders — the chain does. Reconciliation belongs to the Solana
   * confirmation path, so this reports UNCERTAIN rather than inventing a result.
   */
  async status(reference: string): Promise<OrderState> {
    return {
      orderId: reference,
      provider: this.id,
      status: "UNCERTAIN",
      reference,
      reason: "Jupiter has no order state; confirm this signature against Solana.",
      updatedAt: new Date(this.now()).toISOString(),
    };
  }

  private headers(): Record<string, string> {
    return this.apiKey ? { "x-api-key": this.apiKey } : {};
  }
}
