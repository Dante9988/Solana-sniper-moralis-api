/**
 * Non-custodial trade execution via Solana Pay "Transaction Request" links
 * (https://docs.solanapay.com/spec#transaction-request). This is the
 * replacement for the removed Sniperoo/plaintext-key-signing paths (see
 * ARCHITECTURE.md §8): the bot never generates, imports, stores, or signs
 * with a private key anywhere in this file or its callers.
 *
 * Flow:
 *   1. A user runs /buy or /sell in Telegram (or Discord). We create a
 *      short-lived intent here and hand back a `solana:<https-url>` link
 *      plus a QR code of it.
 *   2. The user opens that link in their own wallet app (Phantom, Solflare,
 *      etc). The wallet GETs the URL for display metadata, then POSTs
 *      `{ account: "<the wallet's own public key>" }`.
 *   3. `buildTransactionForAccount` below builds an UNSIGNED transaction for
 *      that specific account (via jupiterService) and returns it as base64.
 *      The wallet shows it to the user and, only on their approval, signs
 *      and submits it. We never see a private key at any point.
 *
 * Intents live in memory only (no DB, nothing sensitive to persist) and
 * expire after INTENT_TTL_MS.
 */

import { PublicKey } from '@solana/web3.js';
import { jupiterService } from './jupiterService';

const INTENT_TTL_MS = 10 * 60_000; // 10 minutes
/**
 * Defense-in-depth cap on live intents (phase7.txt §3 "bounded storage").
 * Creation already requires an authenticated /api/transaction/{buy,sell}
 * caller, so this is a backstop against a bug or a compromised token, not
 * the primary control.
 */
const MAX_LIVE_INTENTS = 500;

export type PayIntentKind = 'BUY' | 'SELL';

export interface PayIntent {
  id: string;
  kind: PayIntentKind;
  tokenAddress: string;
  /** SOL amount for BUY, percentage (1-100) of the account's token balance for SELL. */
  amount: number;
  createdAt: number;
  expiresAt: number;
}

export class SolanaPayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SolanaPayConfigError';
  }
}

const intents = new Map<string, PayIntent>();

function pruneExpired(): void {
  const now = Date.now();
  for (const [id, intent] of intents) {
    if (intent.expiresAt <= now) intents.delete(id);
  }
}

function randomId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The externally-reachable HTTPS base URL wallets will fetch to build a
 * transaction (e.g. `https://your-domain.example`). Required — there is no
 * usable default, since "localhost" is not reachable from a phone's wallet
 * app. Fails closed rather than silently building a broken link.
 */
function requirePublicBaseUrl(): string {
  const base = process.env.SOLANA_PAY_BASE_URL?.trim();
  if (!base) {
    throw new SolanaPayConfigError(
      'SOLANA_PAY_BASE_URL is not set — cannot build a Solana Pay link that a wallet app could actually reach.'
    );
  }
  return base.replace(/\/+$/, '');
}

function solanaPayUrl(path: string): string {
  const httpsUrl = `${requirePublicBaseUrl()}${path}`;
  return `solana:${encodeURIComponent(httpsUrl)}`;
}

export interface CreateIntentResult {
  intentId: string;
  /** `solana:<url-encoded https url>` — open directly, or encode as a QR code. */
  url: string;
}

function assertCapacity(): void {
  if (intents.size >= MAX_LIVE_INTENTS) {
    throw new Error('Too many pending payment requests right now. Please try again shortly.');
  }
}

export function createBuyIntent(tokenAddress: string, solAmount: number): CreateIntentResult {
  new PublicKey(tokenAddress); // throws if invalid — fail before creating an intent
  if (!(solAmount > 0)) throw new Error('Buy amount must be greater than 0 SOL.');

  pruneExpired();
  assertCapacity();
  const id = randomId();
  const now = Date.now();
  intents.set(id, { id, kind: 'BUY', tokenAddress, amount: solAmount, createdAt: now, expiresAt: now + INTENT_TTL_MS });
  return { intentId: id, url: solanaPayUrl(`/pay/buy/${id}`) };
}

export function createSellIntent(tokenAddress: string, percentage: number): CreateIntentResult {
  new PublicKey(tokenAddress);
  if (!(percentage > 0) || percentage > 100) throw new Error('Sell percentage must be between 1 and 100.');

  pruneExpired();
  assertCapacity();
  const id = randomId();
  const now = Date.now();
  intents.set(id, { id, kind: 'SELL', tokenAddress, amount: percentage, createdAt: now, expiresAt: now + INTENT_TTL_MS });
  return { intentId: id, url: solanaPayUrl(`/pay/sell/${id}`) };
}

export function getIntent(intentId: string): PayIntent | undefined {
  pruneExpired();
  return intents.get(intentId);
}

export interface TransactionRequestLabel {
  label: string;
  icon?: string;
}

export function labelForIntent(intent: PayIntent): TransactionRequestLabel {
  const short = `${intent.tokenAddress.slice(0, 4)}…${intent.tokenAddress.slice(-4)}`;
  return {
    label: intent.kind === 'BUY' ? `Buy ${intent.amount} SOL of ${short}` : `Sell ${intent.amount}% of ${short}`,
  };
}

export interface BuiltTransactionResponse {
  transaction: string;
  message: string;
}

/**
 * Builds the unsigned transaction for whichever account the connecting
 * wallet declares as its own (per the Solana Pay Transaction Request spec).
 * Never signs, never sends, never touches a private key.
 *
 * One-time-use (phase7.txt §3/§5): the intent's own kind/tokenAddress/amount
 * are fixed at creation and never take input from this call — `accountBase58`
 * is the only caller-supplied value, and it only selects whose balance/quote
 * to build for. On a successful build the intent is deleted so it cannot be
 * reused to mint another transaction (e.g. after the quote has gone stale);
 * a failed build (bad account, no balance, upstream error) leaves the intent
 * live so the same short-lived link can be retried.
 */
export async function buildTransactionForAccount(intentId: string, accountBase58: string): Promise<BuiltTransactionResponse> {
  const intent = getIntent(intentId);
  if (!intent) throw new Error('This request has expired or does not exist. Ask for a new /buy or /sell link.');

  const account = new PublicKey(accountBase58); // throws on malformed input
  const message =
    intent.kind === 'BUY' ? `Buy ${intent.amount} SOL of ${intent.tokenAddress}` : `Sell ${intent.amount}% of ${intent.tokenAddress}`;
  const built =
    intent.kind === 'BUY'
      ? await jupiterService.buildBuySwapTransaction(account.toBase58(), intent.tokenAddress, intent.amount)
      : await jupiterService.buildSellSwapTransaction(account.toBase58(), intent.tokenAddress, intent.amount);

  intents.delete(intentId);
  return { transaction: built.transactionBase64, message };
}
