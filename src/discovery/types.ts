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

/**
 * Phase 7E.4.3 §5 — facts a venue can prove at discovery time that not every venue can.
 *
 * Optional and additive on purpose. Pump.fun's CreateEvent carries name/symbol/uri in the event
 * payload itself, so those cost no extra I/O; Pons has to fetch them later and leaves this
 * absent. Every field is independently nullable because §5 is explicit that missing metadata
 * must read as unknown and must never block discovery — and must never be fabricated.
 */
export interface NormalizedTokenMetadata {
  readonly name: string | null;
  readonly symbol: string | null;
  /** Off-chain metadata document (e.g. an IPFS URI). Not fetched here — recorded as given. */
  readonly metadataUri: string | null;
  /** Read from the mint/token contract, never assumed from the chain (no "Solana means 6"). */
  readonly tokenDecimals: number | null;
  readonly quoteDecimals: number | null;
  /** The bonding-curve account/contract this token trades on before graduation. */
  readonly curveAddress: string | null;
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
  /** Phase 7E.4.3 §5 — absent when the venue proves nothing extra at discovery time. */
  readonly metadata?: NormalizedTokenMetadata;
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

/**
 * Phase 7E.4.3 §12/§13 — a token's lifecycle position, and the transition that moved it there.
 *
 * Three things are kept deliberately distinct, because collapsing any two of them would tell a
 * user something the chain did not say:
 *
 *   `bonding_complete`  the curve finished. Pump.fun's CompleteEvent proves exactly this and
 *                       NOTHING about a destination pool. §12: "Do not call CompleteEvent alone
 *                       'PumpSwap migrated'."
 *   `migrating`         a migration is under way but its destination is not yet proven.
 *   `pumpswap`          the destination pool is established and named by the chain — the only
 *                       state that means GRADUATED.
 *
 * NEAR_MIGRATION is deliberately NOT in this list. It is a threshold judgement over curve
 * reserves, and this repository has no verified completion threshold to compare against — so it
 * stays a derived, read-time presentation concern (§2: the listener computes no card state),
 * never a persisted claim.
 */
export type TokenLifecyclePhase = "bonding_curve" | "bonding_complete" | "migrating" | "pumpswap" | "unsupported";

/**
 * The lifecycle event every source must emit (§15: LaunchLab must produce the same contracts),
 * carrying enough for a later social/autopost consumer to work entirely from stored facts.
 *
 * §13 is explicit that ingestion must never call X. This type is the seam that makes that
 * possible: it records who migrated where and when, and a downstream outbox — not this event's
 * producer — decides whether to post.
 */
export interface NormalizedLifecycleTransition {
  readonly kind: "lifecycleTransition";
  readonly chain: ChainId;
  readonly venue: string;
  readonly tokenAddress: string;
  readonly phase: TokenLifecyclePhase;
  /** The source's own event name, lower-snake: "created" | "completed" | "migrated" | ... */
  readonly eventType: string;
  /** Where the token traded before this transition, e.g. "pump". */
  readonly sourceVenue: string;
  /** Where it trades after, when the chain names it. Null when the transition does not move it. */
  readonly destinationVenue: string | null;
  /** The destination pool/market address, when the chain proves one exists. Null otherwise. */
  readonly destinationPool: string | null;
  readonly curveAddress: string | null;
  /** The event's OWN asserted timestamp, when it carries one. Never substituted for block time. */
  readonly eventTimestamp: string | null;
  /**
   * Whether this observation is safe to treat as irreversible. A pre-finalized observation is
   * "provisional" and must not trigger anything that cannot be taken back (§8).
   */
  readonly confidence: "provisional" | "final";
  readonly provenance: ChainProvenance;
  readonly observedAt: string;
  /** Every numeric field already a decimal string — never a JS number for an on-chain amount. */
  readonly payload: Readonly<Record<string, string | boolean | null>>;
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
