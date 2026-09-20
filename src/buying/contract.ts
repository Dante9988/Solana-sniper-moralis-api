/**
 * Phase 7D.5.1 — the shared buying contract.
 *
 * One flow — select asset, enter amount, review, approve, track — over providers that work
 * very differently: a fiat checkout that redirects and settles minutes later, a Solana
 * aggregator that returns an unsigned transaction, an EVM swap that needs an approval first.
 *
 * The parts that are deliberately uniform, because each one is a way to mislead someone:
 *
 * - **Amounts are decimal strings and base units, never JS numbers.** A float cannot hold
 *   8 decimals of BTC or 18 of ETH without silently rounding the number the user approves.
 * - **`minimumReceived` is mandatory on every executable quote.** A quote that only shows
 *   the expected amount hides the worst case, which is the number that actually binds.
 * - **Quotes expire and carry the inputs they were made for.** Anything that changes the
 *   trade — account, network, asset, amount, slippage — invalidates them, and they are
 *   revalidated immediately before signing rather than trusted from the review screen.
 * - **Submitted is not complete.** `SUBMITTED` and `UNCERTAIN` are distinct terminal-looking
 *   states that are not success, so a redirect back from a checkout, or a transaction that
 *   timed out, can never be rendered as a finished purchase.
 * - **`requirements` are surfaced, not performed silently.** A wallet on the wrong network,
 *   an unset approval, or a balance on the wrong chain is disclosed before approval.
 */

import type { AssetIdentity } from "./assetIdentity";

export type ProviderId = "jupiter" | "uniswap_v4" | "uniswap_v3" | "moonpay" | "hyperliquid";

/** What a provider can do for a given pair, and whether it can do it right now. */
export interface ProviderCapability {
  readonly provider: ProviderId;
  readonly supported: boolean;
  /**
   * Why not. Shown to the user, so it says what is wrong rather than "unavailable" — an
   * unsupported pair, a missing route and a provider outage need different actions.
   */
  readonly reason: string | null;
  /** True when the route exists but cannot be executed from this app yet (e.g. no wallet). */
  readonly quoteOnly: boolean;
}

/** Money, always as an exact decimal string plus its base-unit integer. */
export interface Amount {
  /** Base units as a decimal integer string — the value that goes on the wire. */
  readonly raw: string;
  /** Human decimal string, exact. Never a JS number. */
  readonly decimal: string;
  readonly decimals: number;
  readonly symbol: string;
}

export interface Fee {
  readonly label: string;
  readonly amount: Amount;
  /** Whether this is taken from the input, added on top, or paid in gas. */
  readonly kind: "network" | "provider" | "platform";
}

/** Something the user must do before this quote can be executed. */
export interface Requirement {
  readonly kind: "connect_wallet" | "switch_network" | "token_approval" | "fund_account" | "bridge";
  /** Plain language, shown as-is. */
  readonly description: string;
  /** True when the app can drive it (e.g. a network switch); false when the user must act elsewhere. */
  readonly actionable: boolean;
}

export interface BuyQuote {
  readonly quoteId: string;
  readonly provider: ProviderId;
  readonly input: { readonly asset: AssetIdentity; readonly amount: Amount };
  readonly output: {
    readonly asset: AssetIdentity;
    /** What the route currently expects to deliver. */
    readonly expected: Amount;
    /** The floor the transaction enforces. Mandatory: this is the number that binds. */
    readonly minimumReceived: Amount;
  };
  readonly fees: readonly Fee[];
  readonly slippageBps: number;
  /** Unix ms. Past this the quote must be refused, not refreshed silently. */
  readonly expiresAt: number;
  readonly requirements: readonly Requirement[];
  /** Any disclosure the asset itself demands — wrapped, tokenized equity, perp. */
  readonly disclosures: readonly string[];
  /**
   * The exact inputs this quote was produced for. Execution compares against these and
   * refuses on any difference, so a quote can never be replayed against a changed trade.
   */
  readonly boundTo: QuoteBinding;
  /** Provider-specific payload needed to build the transaction. Opaque to callers. */
  readonly providerData: unknown;
}

/**
 * Everything that must be identical between quoting and signing.
 *
 * `account` is in here because a quote built for one wallet must never be signed by
 * another — the output would land somewhere the user did not review.
 */
export interface QuoteBinding {
  readonly account: string;
  readonly network: AssetIdentity["network"];
  readonly inputAsset: string;
  readonly outputAsset: string;
  readonly inputRaw: string;
  readonly slippageBps: number;
}

export interface QuoteRequest {
  readonly input: AssetIdentity;
  readonly output: AssetIdentity;
  /** Base units of the input asset. */
  readonly amountRaw: string;
  readonly slippageBps: number;
  /** The wallet that will sign and receive. */
  readonly account: string;
}

/**
 * An unsigned transaction for the user's wallet to approve.
 *
 * There is no variant carrying a private key, and no server-side signer: signing happens in
 * the wallet, and this shape is what makes that structural rather than a convention.
 */
export type UnsignedExecution =
  | { readonly kind: "solana_transaction"; readonly base64: string; readonly lastValidBlockHeight?: number }
  | { readonly kind: "evm_transaction"; readonly to: string; readonly data: string; readonly value: string; readonly chainId: number }
  /** A hosted checkout the user is sent to. Returning from it proves nothing. */
  | { readonly kind: "redirect"; readonly url: string };

export type OrderStatus =
  | "PENDING"
  /** Sent, not confirmed. Never rendered as a completed purchase. */
  | "SUBMITTED"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  /**
   * We genuinely do not know — a timeout, a dropped receipt, a provider that stopped
   * answering. Distinct from FAILED on purpose: telling someone a purchase failed when it
   * may have succeeded invites them to buy twice.
   */
  | "UNCERTAIN";

export interface OrderState {
  readonly orderId: string;
  readonly provider: ProviderId;
  readonly status: OrderStatus;
  /** Chain transaction hash or provider order id, once there is one. */
  readonly reference: string | null;
  readonly reason: string | null;
  readonly updatedAt: string;
}

/**
 * What every provider implements.
 *
 * `prepare` is separate from `quote` so the revalidation-before-signing rule has somewhere
 * to live: it re-checks the binding and may refuse, rather than handing back a transaction
 * built from a stale review screen.
 */
export interface BuyProvider {
  readonly id: ProviderId;
  capability(input: AssetIdentity, output: AssetIdentity): Promise<ProviderCapability>;
  quote(request: QuoteRequest): Promise<BuyQuote>;
  prepare(quote: BuyQuote, request: QuoteRequest): Promise<UnsignedExecution>;
  /** Reconcile against the provider or the chain. Never infers success from submission. */
  status(reference: string): Promise<OrderState>;
}

export class QuoteExpiredError extends Error {}
export class QuoteMismatchError extends Error {}

/** True when this quote can still be executed at `now`. */
export function isQuoteFresh(quote: BuyQuote, now = Date.now()): boolean {
  return quote.expiresAt > now;
}

/**
 * The check that runs immediately before signing.
 *
 * Throws rather than returning false: a caller that forgets to branch on a boolean still
 * fails closed, which is the behaviour worth defaulting to when money is involved.
 */
export function assertExecutable(quote: BuyQuote, request: QuoteRequest, now = Date.now()): void {
  if (!isQuoteFresh(quote, now)) {
    throw new QuoteExpiredError(`quote ${quote.quoteId} expired at ${new Date(quote.expiresAt).toISOString()}`);
  }
  const b = quote.boundTo;
  const changed: string[] = [];
  if (b.account !== request.account) changed.push("account");
  if (b.inputAsset !== assetRef(request.input)) changed.push("input asset");
  if (b.outputAsset !== assetRef(request.output)) changed.push("output asset");
  if (b.inputRaw !== request.amountRaw) changed.push("amount");
  if (b.slippageBps !== request.slippageBps) changed.push("slippage");
  if (changed.length > 0) {
    throw new QuoteMismatchError(`quote ${quote.quoteId} was not made for this trade — ${changed.join(", ")} changed`);
  }
}

export function assetRef(asset: AssetIdentity): string {
  return `${asset.network}:${asset.address ?? "native"}`;
}

/**
 * Exact base units -> decimal string, without going through a float.
 *
 * `Number(raw) / 10 ** decimals` loses precision above 2^53, which 18-decimal amounts reach
 * routinely, so the conversion is done on the digits.
 */
export function toDecimalString(raw: string, decimals: number): string {
  if (!/^\d+$/.test(raw)) throw new Error(`amount must be a base-unit integer string, got ${JSON.stringify(raw)}`);
  if (decimals === 0) return raw;
  const padded = raw.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

export function makeAmount(raw: string, asset: Pick<AssetIdentity, "decimals" | "symbol">): Amount {
  return { raw, decimal: toDecimalString(raw, asset.decimals), decimals: asset.decimals, symbol: asset.symbol };
}
