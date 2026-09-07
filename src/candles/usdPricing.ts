/**
 * Phase 7B.5B §3 — the quote->USD rate abstraction for candles, kept
 * strictly separate from quote-denominated pricing (src/discovery/
 * normalizedPrice.ts / candle open/high/low/close, which are always
 * available whenever decimals are known). USD availability is its own,
 * independently-nullable axis: quote price AVAILABLE + USD price
 * UNAVAILABLE is a normal, valid, fully-usable candle — never blocked on
 * USD (phase7b5b.txt §3: "A missing USD rate must not prevent valid ETH/
 * WETH-quoted candles from being produced").
 *
 * Production source decision (inspected during this phase, documented here
 * and in ARCHITECTURE.md §21 rather than guessed):
 *
 *   This repository already HAS a `SolUsdRate` table (prisma/schema.prisma,
 *   shaped for a Pyth-style feed: feedId/provider/publishTime/rawPrice/
 *   exponent) — but inspection during this phase (grep for any TS code
 *   reading or writing it) found it is schema-only: no ingestion code
 *   populates it anywhere in this repository (consistent with
 *   ARCHITECTURE.md's own framing of the Pump candle/rate tables as "schema
 *   foundations, not running aggregation services"). It is also
 *   SOL-denominated for the Solana/Pump.fun side of the product regardless.
 *   Nothing in this repository fetches or persists a historical ETH/
 *   WETH->USD series at all (no Chainlink/Pyth/CoinGecko ETH feed, no
 *   historical-rate table for any EVM quote asset). Robinhood Chain's
 *   `WETH_QUOTE` is a proxy contract (ARCHITECTURE.md §19.1) with unverified
 *   deposit()/withdraw() semantics — its own on-chain price is not
 *   established here either.
 *
 *   Per phase7b5b.txt §3's explicit instruction for exactly this situation:
 *   this phase implements the interface and returns UNAVAILABLE from the
 *   default provider, rather than inventing a source merely to fill the
 *   field. A real implementation (e.g. a time-aligned Chainlink round query
 *   against Robinhood Chain / Ethereum mainnet, or a paid historical-price
 *   API with provenance/attestation the rest of this codebase's "verify,
 *   don't assume" protocol rule would require) is future work, wired in
 *   behind this same interface with zero changes to the aggregator.
 */

export interface QuoteUsdRatePoint {
  /** USD per one whole unit of the quote asset, as a decimal-safe string. */
  readonly rateUsdPerQuote: string;
  readonly observedAt: Date;
  readonly source: string;
}

export type QuoteUsdRateResult = { readonly status: "AVAILABLE"; readonly rate: QuoteUsdRatePoint } | { readonly status: "UNAVAILABLE"; readonly reason: string };

export interface QuoteUsdRateProvider {
  /** A short, stable identifier surfaced in API/health responses (never a raw provider URL or credential). */
  readonly name: string;
  getHistoricalRate(params: { chain: string; quoteAddress: string; at: Date }): Promise<QuoteUsdRateResult>;
}

/**
 * The honest default: no trustworthy historical ETH/WETH->USD source exists
 * in this codebase yet (see this file's header). Always UNAVAILABLE — never
 * silently substitutes a live/current rate for a historical one
 * (phase7b5b.txt §3: "Never use today's ETH/USD price for historical trades
 * or candles").
 */
export class NullQuoteUsdRateProvider implements QuoteUsdRateProvider {
  readonly name = "null (no historical quote->USD source configured — see ARCHITECTURE.md §21.5)";

  async getHistoricalRate(_params: { chain: string; quoteAddress: string; at: Date }): Promise<QuoteUsdRateResult> {
    return { status: "UNAVAILABLE", reason: "no historical quote->USD rate provider is configured for this chain in this environment" };
  }
}
