/**
 * Phase 7B.4 §4.2 — the venue-agnostic normalized contract.
 *
 * Pons (Robinhood Chain), Pump.fun/PumpSwap (Solana), and any future venue
 * are three sources of the same small set of facts: a token was discovered,
 * its liquidity was established, and trades happened against it. This file
 * defines that contract once, deliberately avoiding EVM- or Solana-specific
 * vocabulary ("log"/"topic0", "instruction"/"slot"). A thin per-venue
 * adapter (see ChainAdapter below) is the only code that knows which chain
 * produced an event; every consumer (persistence, checkpointing, routes,
 * later scoring/ranking) depends on this file only.
 *
 * This is intentionally isomorphic to NormalizedPumpTrade
 * (src/pump/normalizeTrade.ts, matching CANDLESTICK_CHART.md in the
 * only-pump-me repo) so mapping between them is mechanical once the Solana
 * adapter drops in behind this same seam — but it is a fresh contract, not
 * a re-export, because NormalizedPumpTrade's field names (mint, signature,
 * slot, instructionIndex) are Solana-specific by design for that other
 * contract's own purpose.
 */

/** Extend as new chains land. Do not overload this with venue names. */
export type ChainId = "robinhood" | "solana";

/**
 * A decimal-safe integer or fixed-point value, serialized as a string.
 * Never a JavaScript number — on-chain amounts routinely exceed
 * Number.MAX_SAFE_INTEGER and floats corrupt exact accounting.
 */
export type DecimalString = string;

/**
 * Where a normalized fact came from, in terms every chain can express:
 * "height" is a block number (EVM) or slot (Solana); "hash" is the
 * containing block's hash where the chain has one; "index" is the log
 * index (EVM) or instruction index (Solana) that produced the fact.
 */
export interface ChainProvenance {
  readonly sourceHeight: DecimalString;
  readonly sourceHash: string;
  readonly sourceTxHash: string;
  readonly sourceIndex: number;
}

export interface NormalizedTokenDiscovered {
  readonly kind: "tokenDiscovered";
  readonly chain: ChainId;
  /** e.g. "pons" | "pumpfun" — the specific launchpad/program, not the chain. */
  readonly venue: string;
  readonly tokenAddress: string;
  readonly deployer: string;
  /** Null where the venue has no discrete pool at discovery time (e.g. a bonding curve before graduation). */
  readonly poolAddress: string | null;
  readonly quoteAddress: string;
  readonly supply: DecimalString;
  readonly initialBuyAmount: DecimalString;
  readonly provenance: ChainProvenance;
  /** When OnlyPump processed this fact — never the chain's own block/event timestamp. */
  readonly observedAt: string;
}

export interface NormalizedTradeExecuted {
  readonly kind: "tradeExecuted";
  readonly chain: ChainId;
  readonly venue: string;
  readonly tokenAddress: string;
  readonly poolAddress: string | null;
  readonly side: "buy" | "sell";
  readonly tokenAmount: DecimalString;
  readonly quoteAmount: DecimalString;
  readonly quoteAddress: string;
  readonly priceQuote: DecimalString;
  /** Computed at aggregation time, not by the adapter — never populated here. */
  readonly priceUsd: DecimalString | null;
  readonly trader: string;
  readonly provenance: ChainProvenance;
  readonly observedAt: string;
}

/**
 * Phase 7D §4 — a token's migration from a bonding curve onto a real AMM
 * pool, when the venue reports it as a discrete on-chain event rather than
 * a polled read. Kept separate from NormalizedGraduationStatus below
 * (which documents the opposite case — no event, poll only) and out of
 * ChainAdapter's two-method shape for now: this is the first venue with an
 * event-sourced graduation, and widening that shared seam is a larger,
 * separate decision than adding this one additive type.
 */
export interface NormalizedTokenGraduated {
  readonly kind: "tokenGraduated";
  readonly chain: ChainId;
  readonly venue: string;
  readonly tokenAddress: string;
  /** The AMM position/lock identifier minted at graduation (e.g. a Uniswap V4 position NFT's tokenId). */
  readonly positionId: DecimalString;
  readonly tokenAmount: DecimalString;
  readonly pairTokenAmount: DecimalString;
  readonly provenance: ChainProvenance;
  readonly observedAt: string;
}

export type NormalizedChainEvent = NormalizedTokenDiscovered | NormalizedTradeExecuted;

/**
 * A poll result, not a discrete event — graduation has no on-chain event on
 * Pons (phase7b4.txt §2); it is read on a schedule (§4.6). Kept out of
 * NormalizedChainEvent so listeners and the poller are never confused for
 * one another.
 */
export interface NormalizedGraduationStatus {
  readonly chain: ChainId;
  readonly venue: string;
  readonly tokenAddress: string;
  readonly pairedPrincipal: DecimalString;
  readonly threshold: DecimalString;
  readonly graduated: boolean;
  readonly observedAt: string;
}

/**
 * THE SEAM (phase7b4.txt §4.2: "name the seam explicitly in code").
 *
 * Every venue's decoder implements this. It is pure and synchronous where
 * possible: given a venue-specific raw event already fetched off-chain
 * (a decoded log, a decoded instruction), produce a NormalizedChainEvent or
 * null if the raw input isn't a fact this contract represents. No I/O, no
 * subscription, no persistence — those are the listener's job (§4.3-§4.5),
 * which depends on this interface and never on viem or @solana/web3.js
 * directly. PonsAdapter (src/pons/ponsAdapter.ts) is the first
 * implementation; the Solana adapter is the second, dropped in later
 * without this interface or any consumer of it changing.
 */
export interface ChainAdapter<TRawDiscovery, TRawTrade> {
  readonly chain: ChainId;
  readonly venue: string;

  decodeTokenDiscovered(raw: TRawDiscovery): NormalizedTokenDiscovered | null;
  decodeTrade(raw: TRawTrade): NormalizedTradeExecuted | null;
}
