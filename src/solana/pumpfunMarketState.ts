/**
 * Phase 7E.4.4 — a Pump.fun token's live market state, derived from the events it already emits.
 *
 * Why here and not a chain read: every bonding-curve `TradeEvent` carries the curve's reserves AFTER
 * that trade, and every PumpSwap trade transaction carries the pool vault balances after it. Reading
 * the account again would cost an RPC call per trade and could only return the same numbers later.
 *
 * Everything is integer arithmetic on base units. Nothing here knows a USD rate — there is no
 * trusted SOL/USD source configured, and an untrusted one is worse than none (§12).
 *
 * Sources (accessed 2026-09-27):
 *   - Official IDL: github.com/pump-fun/pump-public-docs @ 81091419e4457566469d4e2a27f64ed84d42419c,
 *     idl/pump.json — `TradeEvent` reserve fields and `Global.initial_real_token_reserves`.
 *   - On-chain: Global PDA 4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf (owner 6EF8…F6P,
 *     discriminator [167,232,232,177,200,108,114,127]) at finalized slot 450936952:
 *     initial_virtual_token_reserves 1,073,000,000,000,000 · initial_virtual_sol_reserves
 *     30,000,000,000 · initial_real_token_reserves 793,100,000,000,000.
 *   - Mainnet fixtures in src/pump/__tests__/fixtures/mainnet (see pumpfunMarketState.test.ts).
 *
 * INFERRED (labelled as such, pinned by fixtures): the curve's initial parameters are NOT the same
 * for every token. The router-sell fixture's token has virtualSol − realSol = 13.79 SOL where the
 * current Global says 30. So a progress formula that divides by the Global's 793.1M would report a
 * negative progress for it. Instead every constant is recovered from the token's own event:
 *
 *   initialVirtualQuote = virtualQuote − realQuote              (the curve never holds virtual quote)
 *   unsellableTokens    = virtualToken − realToken              (virtual tokens that are never sold)
 *   k                   = virtualQuote × virtualToken           (constant product, fees paid outside)
 *   initialVirtualToken = k / initialVirtualQuote
 *   initialRealToken    = initialVirtualToken − unsellableTokens
 *   progress            = (initialRealToken − realToken) / initialRealToken
 *
 * For a token created under the current Global this recovers 793,100,000,001,810 against the
 * Global's 793,100,000,000,000 (the completion fixture) — 1,810 base units, i.e. 0.0018 of 793.1M
 * tokens, from Pump's per-trade rounding drifting k. That is the cross-check; it is well inside one
 * bps. Anything contradictory fails closed to null.
 */

import { decodePumpSwapBuyEvent, decodePumpSwapSellEvent, decodePumpTradeEvent } from "../pump/eventDecoder";
import type { DecodedEventEnvelope } from "../pump/eventWalker";
import { PUMPSWAP_PROGRAM_ID, PUMP_PROGRAM_ID } from "../pump/discriminators";

/** Where the state was read from. Stored as `TokenMarketSnapshot.venue`. */
export type PumpfunMarketVenue = "PUMPFUN_BONDING_CURVE" | "PUMPSWAP_POOL";

/** The latest reserves one event (or one transaction's balances) proves for a mint. */
export interface PumpfunMarketObservation {
  readonly mint: string;
  readonly venue: PumpfunMarketVenue;
  /** Raw quote base units per raw token base unit is quoteReserve / tokenReserve. */
  readonly tokenReserve: bigint;
  readonly quoteReserve: bigint;
  /** Real quote held by the curve or pool — what a seller could actually be paid from. */
  readonly realQuote: bigint;
  /** Bonding curve only; null for a pool. Null also when the reserves were contradictory. */
  readonly progressBps: number | null;
  /** True when the curve has sold its whole real allocation. */
  readonly curveComplete: boolean;
  /** Pool address for a PumpSwap observation. */
  readonly pool: string | null;
}

const BPS = 10_000n;

/**
 * Bonding progress in bps from one TradeEvent's post-trade reserves, or null when the reserves
 * cannot be a valid constant-product curve.
 */
export function curveProgressBps(reserves: {
  virtualQuote: bigint;
  virtualToken: bigint;
  realQuote: bigint;
  realToken: bigint;
}): number | null {
  const { virtualQuote, virtualToken, realQuote, realToken } = reserves;
  if (virtualQuote <= 0n || virtualToken <= 0n || realQuote < 0n || realToken < 0n) return null;
  if (realQuote > virtualQuote || realToken > virtualToken) return null;

  const initialVirtualQuote = virtualQuote - realQuote;
  if (initialVirtualQuote <= 0n) return null;
  const unsellable = virtualToken - realToken;
  const initialVirtualToken = (virtualQuote * virtualToken) / initialVirtualQuote;
  const initialRealToken = initialVirtualToken - unsellable;
  if (initialRealToken <= 0n) return null;
  // Integer division can leave initialRealToken a few units under realToken for a curve that has
  // been sold all the way back down; that is 0 %, not a contradiction.
  const sold = initialRealToken > realToken ? initialRealToken - realToken : 0n;
  const bps = (sold * BPS) / initialRealToken;
  return Number(bps > BPS ? BPS : bps);
}

/** A bonding-curve TradeEvent's post-trade market state. */
export function observeCurveTrade(envelope: DecodedEventEnvelope): PumpfunMarketObservation | null {
  if (envelope.emittingProgram !== PUMP_PROGRAM_ID || envelope.eventName !== "TradeEvent") return null;
  const event = decodePumpTradeEvent(envelope.payload);
  const virtualQuote = BigInt(event.virtualSolReserves);
  const virtualToken = BigInt(event.virtualTokenReserves);
  const realQuote = BigInt(event.realSolReserves);
  const realToken = BigInt(event.realTokenReserves);
  if (virtualToken === 0n) return null;
  return {
    mint: event.mint,
    venue: "PUMPFUN_BONDING_CURVE",
    tokenReserve: virtualToken,
    quoteReserve: virtualQuote,
    realQuote,
    progressBps: curveProgressBps({ virtualQuote, virtualToken, realQuote, realToken }),
    curveComplete: realToken === 0n,
    pool: null,
  };
}

interface TokenBalanceLike {
  readonly owner?: string;
  readonly mint: string;
  readonly uiTokenAmount: { readonly amount: string };
}

/**
 * A PumpSwap trade's post-trade pool state, from the transaction's own post token balances.
 *
 * The event's `pool_base_token_reserves`/`pool_quote_token_reserves` are the reserves BEFORE the
 * trade — verified on four mainnet events, where they equal the pool vaults' preTokenBalances
 * exactly. The post balances are the state the next trader faces, so they are what is stored.
 */
export function observePoolTrade(
  envelope: DecodedEventEnvelope,
  mint: string,
  quoteMint: string,
  postTokenBalances: readonly TokenBalanceLike[] | null | undefined
): PumpfunMarketObservation | null {
  if (envelope.emittingProgram !== PUMPSWAP_PROGRAM_ID) return null;
  const pool =
    envelope.eventName === "BuyEvent"
      ? decodePumpSwapBuyEvent(envelope.payload).pool
      : envelope.eventName === "SellEvent"
        ? decodePumpSwapSellEvent(envelope.payload).pool
        : null;
  if (!pool || !postTokenBalances) return null;
  const vault = (m: string) => postTokenBalances.filter((b) => b.owner === pool && b.mint === m);
  const base = vault(mint);
  const quote = vault(quoteMint);
  // Exactly one vault per side, or the pool is not what we think it is.
  if (base.length !== 1 || quote.length !== 1) return null;
  const tokenReserve = BigInt(base[0].uiTokenAmount.amount);
  const quoteReserve = BigInt(quote[0].uiTokenAmount.amount);
  if (tokenReserve <= 0n || quoteReserve <= 0n) return null;
  return { mint, venue: "PUMPSWAP_POOL", tokenReserve, quoteReserve, realQuote: quoteReserve, progressBps: null, curveComplete: true, pool };
}

/** Spot price scaled by 1e36, in quote base units per token base unit — `priceQuoteX36`'s format. */
export function priceQuoteX36(observation: Pick<PumpfunMarketObservation, "tokenReserve" | "quoteReserve">): bigint {
  return (observation.quoteReserve * 10n ** 36n) / observation.tokenReserve;
}

/** Total supply × spot price, in quote base units. */
export function marketCapQuote(observation: Pick<PumpfunMarketObservation, "tokenReserve" | "quoteReserve">, totalSupply: bigint): bigint {
  return (observation.quoteReserve * totalSupply) / observation.tokenReserve;
}
