/**
 * Phase 7E.4.3 §5/§10 — Solana token decimals, read rather than assumed.
 *
 * This is the Solana counterpart to src/candles/decimalsResolver.ts's `NATIVE_QUOTE_ADDRESS`
 * case, and it exists for the same reason that file does: the native currency has no mint account
 * to read, so its decimals come from the protocol's own definition, while EVERY other mint is
 * read from chain. There is no "Solana tokens are 6 decimals" default anywhere in this module —
 * pump.fun mints happen to be 6, and that is a convention its program could change.
 *
 * Verified on mainnet 2026-09-26 through the configured endpoint:
 *
 *   So11111111111111111111111111111111111111112  -> 9   (wrapped SOL, read from the mint)
 *   EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v -> 6   (USDC, read from the mint)
 *   11111111111111111111111111111111             -> no mint account exists
 *
 * That last line is the case this module exists for. A fresh pump.fun bonding curve reports the
 * System Program id as its `quote_mint` to mean "native SOL" (see SOL_QUOTE_MINTS in
 * src/pump/normalizeTrade.ts, which documents the same observation from the other direction).
 * `getAccountInfo` on it returns no parsed mint, so a naive reader leaves quoteDecimals null and
 * every Solana candle then fails closed forever — observed in the first live capture run.
 */

import type { SolanaRpc } from "./rpc";

/**
 * pump.fun's sentinel for "this curve is quoted in native SOL": the System Program id, which is
 * also the all-zero pubkey. Not a token mint.
 */
export const NATIVE_SOL_QUOTE_SENTINEL = "11111111111111111111111111111111";

/**
 * Native SOL's decimals, by protocol definition: 1 SOL = 1,000,000,000 lamports.
 * Cross-checked against `LAMPORTS_PER_SOL` in the installed official @solana/web3.js 1.98.0
 * (= 1000000000), not recalled.
 */
export const NATIVE_SOL_DECIMALS = 9;

/** Wrapped SOL's mint. Its decimals are still READ, not assumed — this is only an identity. */
export const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Reads decimals for a set of mints, caching across calls.
 *
 * A mint whose decimals cannot be read maps to `null`, which callers must treat as
 * "unavailable" and fail closed on — never as a default. Failures are NOT cached, so a transient
 * RPC error does not permanently poison a token.
 */
export class SolanaDecimalsCache {
  private readonly cache = new Map<string, number>();

  constructor(private readonly rpc: SolanaRpc) {}

  async get(mint: string): Promise<number | null> {
    if (mint === NATIVE_SOL_QUOTE_SENTINEL) return NATIVE_SOL_DECIMALS;
    const cached = this.cache.get(mint);
    if (cached !== undefined) return cached;
    const result = await this.rpc.getMintDecimals(mint);
    if (result.status !== "OK" || result.data === null) return null;
    this.cache.set(mint, result.data);
    return result.data;
  }

  /** Resolves many mints into the map shape `decodePumpfunTransaction` expects. */
  async resolveAll(mints: readonly string[]): Promise<Map<string, number | null>> {
    const resolved = new Map<string, number | null>();
    for (const mint of mints) {
      if (resolved.has(mint)) continue;
      resolved.set(mint, await this.get(mint));
    }
    return resolved;
  }

  get size(): number {
    return this.cache.size;
  }
}
