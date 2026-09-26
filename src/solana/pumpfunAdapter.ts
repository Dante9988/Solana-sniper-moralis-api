/**
 * Phase 7E.4.3 §1/§3/§4/§5/§9 — Pump.fun behind the existing venue-agnostic seam
 * (`ChainAdapter`, src/discovery/types.ts). Pure and synchronous: no RPC, no database, no
 * subscription. The listener does the I/O and hands raw material in.
 *
 * This file adds NO protocol knowledge. Every discriminator, byte layout and account position it
 * relies on already exists in src/pump/** and is pinned there against real mainnet fixtures
 * (src/pump/__tests__/fixtures/mainnet/, see SOURCE.md). §1 is explicit: "Do NOT build another
 * Pump.fun parser." What is new here is only the *mapping* from those decoded events onto
 * OnlyPump's canonical contracts.
 *
 * Reused, not reimplemented:
 *   src/pump/eventWalker.ts       — findEvents (self-CPI stack reconstruction, refuses failed txs)
 *   src/pump/eventDecoder.ts      — decodePumpCreateEvent / CompleteEvent / CompletePumpAmmMigrationEvent
 *   src/pump/normalizeTrade.ts    — normalizeTradeEvent, the source of truth for trade units (§9)
 *   src/pump/eventIdentity.ts     — canonical event identity (§6)
 *   src/pump/discriminators.ts    — program ids and event discriminators
 */

import {
  decodeCompletePumpAmmMigrationEvent,
  decodePumpCompleteEvent,
  decodePumpCreateEvent,
} from "../pump/eventDecoder";
import { PUMP_PROGRAM_ID } from "../pump/discriminators";
import type { DecodedEventEnvelope, RawTransactionLike } from "../pump/eventWalker";
import { normalizeTradeEvent } from "../pump/normalizeTrade";
import { decodePumpTradeEvent } from "../pump/eventDecoder";
import type {
  ChainAdapter,
  ChainProvenance,
  NormalizedLifecycleTransition,
  NormalizedTokenDiscovered,
  NormalizedTradeExecuted,
} from "../discovery/types";

export const SOLANA_CHAIN = "solana" as const;

/**
 * The launchpad, used as `DiscoveredToken.venue`. One value for the whole Pump.fun family
 * (§4: "A token that migrates is still the same token. Only venue/lifecycle changes.") — the
 * bonding curve and the PumpSwap pool are lifecycle phases of one `pumpfun` token, not two
 * venues' tokens.
 */
export const PUMPFUN_VENUE = "pumpfun";

/** The trading venue a single trade happened on, which DOES differ across the lifecycle. */
export type PumpfunTradeVenue = "pump" | "pumpswap";

/** Solana's default/all-zero pubkey, which is also the System Program id. */
const DEFAULT_PUBKEY = "11111111111111111111111111111111";

/**
 * How (outerInstructionIndex, innerPosition) is packed into the single `Int` that
 * `ChainTrade.@@unique([chain, sourceTxHash, sourceIndex])` provides.
 *
 * The canonical Solana event identity is four-part (signature, outer index, inner position,
 * emitting program) and `ChainTrade` offers one integer, so the pair is packed rather than
 * truncated — truncating would let two events in one transaction collide and silently overwrite
 * each other, which is exactly the duplicate-volume bug §11 asks to rule out.
 *
 * `innerPosition` is offset by one because -1 is its "not a self-CPI event" sentinel
 * (eventIdentity.ts: never null, because Postgres treats NULLs as distinct in a UNIQUE index).
 */
export const SOLANA_INNER_POSITION_SPAN = 4096;
const MAX_INT32 = 2_147_483_647;

export function encodeSolanaSourceIndex(outerInstructionIndex: number, innerPosition: number): number {
  if (!Number.isInteger(outerInstructionIndex) || outerInstructionIndex < 0) {
    throw new Error(`outerInstructionIndex must be a non-negative integer, got ${outerInstructionIndex}`);
  }
  if (!Number.isInteger(innerPosition) || innerPosition < -1 || innerPosition >= SOLANA_INNER_POSITION_SPAN - 1) {
    throw new Error(`innerPosition must be an integer in [-1, ${SOLANA_INNER_POSITION_SPAN - 2}], got ${innerPosition}`);
  }
  const encoded = outerInstructionIndex * SOLANA_INNER_POSITION_SPAN + (innerPosition + 1);
  if (encoded > MAX_INT32) {
    // Fail closed rather than wrap into another event's slot.
    throw new Error(`source index ${outerInstructionIndex}/${innerPosition} does not fit in a 32-bit column`);
  }
  return encoded;
}

export function decodeSolanaSourceIndex(sourceIndex: number): { outerInstructionIndex: number; innerPosition: number } {
  return {
    outerInstructionIndex: Math.floor(sourceIndex / SOLANA_INNER_POSITION_SPAN),
    innerPosition: (sourceIndex % SOLANA_INNER_POSITION_SPAN) - 1,
  };
}

/** The containing block's identity, which is what makes a Solana `sourceHash` a real fact. */
export interface SolanaBlockRef {
  readonly slot: number;
  /** The block's own blockhash, from getBlock. Never the transaction's recentBlockhash. */
  readonly blockhash: string;
  readonly blockTime: number | null;
}

/**
 * Everything the adapter needs about one decoded event, all of it already fetched.
 *
 * `tx` is carried alongside `envelope` because PumpSwap trade mapping resolves its mint from the
 * enclosing call's account list (instructionAccounts.ts), and because a CreateEvent's dev buy is
 * a sibling event in the same transaction.
 */
export interface RawPumpfunEvent {
  readonly envelope: DecodedEventEnvelope;
  readonly tx: RawTransactionLike;
  /** Every event decoded from this same transaction, in order. Used to find a create's dev buy. */
  readonly siblings: readonly DecodedEventEnvelope[];
  readonly block: SolanaBlockRef;
  readonly observedAt: string;
  /** Resolved by the listener from the mint account. Null when it could not be read. */
  readonly tokenDecimals: number | null;
  readonly quoteDecimals: number | null;
  /** §8 — whether the containing slot is finalized yet. */
  readonly confidence: "provisional" | "final";
}

function provenanceOf(raw: RawPumpfunEvent): ChainProvenance {
  return {
    sourceHeight: String(raw.block.slot),
    sourceHash: raw.block.blockhash,
    sourceTxHash: raw.envelope.signature,
    sourceIndex: encodeSolanaSourceIndex(raw.envelope.outerInstructionIndex, raw.envelope.innerPosition),
  };
}

/** An i64 seconds field from an event payload, as an ISO string. Null for the 0/unset case. */
function eventTimestampIso(seconds: string): string | null {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return null;
  return new Date(value * 1000).toISOString();
}

/**
 * The dev buy that pump.fun performs in the same transaction as a create, when there is one.
 *
 * `initialBuyAmount` on `DiscoveredToken` is NOT NULL, and "0" is the honest value for a create
 * with no accompanying buy — not a placeholder for one we failed to find. Ordered by the same
 * (outer, inner) position the identity uses, so "first" is deterministic.
 */
function initialBuyAmountFor(raw: RawPumpfunEvent, mint: string): string {
  const buys = raw.siblings
    .filter((env) => env.eventName === "TradeEvent" && env.emittingProgram === PUMP_PROGRAM_ID)
    .map((env) => ({ env, decoded: decodePumpTradeEvent(env.payload) }))
    .filter((candidate) => candidate.decoded.mint === mint && candidate.decoded.isBuy)
    .sort((a, b) =>
      a.env.outerInstructionIndex - b.env.outerInstructionIndex || a.env.innerPosition - b.env.innerPosition
    );
  return buys.length > 0 ? buys[0].decoded.tokenAmount : "0";
}

/**
 * Pump.fun behind the canonical seam.
 *
 * Both type parameters are `RawPumpfunEvent`: on Solana a discovery and a trade arrive as the
 * same kind of raw material (a decoded event in a fetched transaction), unlike EVM where they
 * are two different logs from two different contracts.
 */
export class PumpfunAdapter implements ChainAdapter<RawPumpfunEvent, RawPumpfunEvent> {
  readonly chain = SOLANA_CHAIN;
  readonly venue = PUMPFUN_VENUE;

  /**
   * CreateEvent -> canonical discovered token (§3, §5).
   *
   * `deployer` is the event's `creator`, not its `user`: the two differ when a launch is routed
   * through a bundler, and `creator` is the account pump.fun's own creator-fee logic pays, so it
   * is the one that means "whose token this is". Falls back to `user` only when `creator` is the
   * all-zero pubkey, which would otherwise persist a meaningless deployer.
   */
  decodeTokenDiscovered(raw: RawPumpfunEvent): NormalizedTokenDiscovered | null {
    const { envelope } = raw;
    if (envelope.eventName !== "CreateEvent" || envelope.emittingProgram !== PUMP_PROGRAM_ID) return null;
    const event = decodePumpCreateEvent(envelope.payload);

    return {
      kind: "tokenDiscovered",
      chain: SOLANA_CHAIN,
      venue: PUMPFUN_VENUE,
      tokenAddress: event.mint,
      deployer: event.creator !== DEFAULT_PUBKEY ? event.creator : event.user,
      // A bonding curve is not a pool. The pool address stays null until graduation names one.
      poolAddress: null,
      quoteAddress: event.quoteMint,
      supply: event.tokenTotalSupply,
      initialBuyAmount: initialBuyAmountFor(raw, event.mint),
      provenance: provenanceOf(raw),
      observedAt: raw.observedAt,
      metadata: {
        // Straight off the event payload — no metadata fetch, no enrichment round trip.
        name: event.name || null,
        symbol: event.symbol || null,
        metadataUri: event.uri || null,
        tokenDecimals: raw.tokenDecimals,
        quoteDecimals: raw.quoteDecimals,
        curveAddress: event.bondingCurve,
      },
    };
  }

  /**
   * TradeEvent -> canonical trade (§9).
   *
   * Units come from `normalizeTradeEvent` unchanged. This method only renames fields onto the
   * chain-neutral contract; it never divides, scales or reinterprets an amount, because §9 makes
   * normalizeTrade.ts the source of truth and forbids reinterpreting raw units in a new service.
   */
  decodeTrade(raw: RawPumpfunEvent): NormalizedTradeExecuted | null {
    const trade = normalizeTradeEvent(raw.envelope, raw.tx, raw.observedAt);
    if (!trade) return null;

    return {
      kind: "tradeExecuted",
      chain: SOLANA_CHAIN,
      venue: trade.venue,
      tokenAddress: trade.mint,
      // The bonding curve has no pool; a PumpSwap trade's pool is named by its own event (§14).
      poolAddress: null,
      side: trade.side,
      tokenAmount: trade.tokenAmount,
      quoteAmount: trade.quoteAmount,
      quoteAddress: trade.quoteMint,
      priceQuote: trade.priceQuote,
      // Computed at candle-aggregation time against a dated rate, never here (§10).
      priceUsd: null,
      trader: trade.trader,
      provenance: provenanceOf(raw),
      observedAt: raw.observedAt,
    };
  }

  /**
   * CreateEvent / CompleteEvent / CompletePumpAmmMigrationEvent -> lifecycle transition (§12).
   *
   * The three map to three genuinely different phases, and the distinction is the point:
   *
   *   CreateEvent                     -> bonding_curve    (NEW/BONDING)
   *   CompleteEvent                   -> bonding_complete (the curve finished — NOT graduated)
   *   CompletePumpAmmMigrationEvent   -> pumpswap         (GRADUATED: it names the destination
   *                                                        pool, established in this same tx)
   *
   * So graduation here is event-sourced and pool-proven, which is what §12 requires before
   * anything may be called migrated. There is no path in this method that reads log text.
   */
  decodeLifecycle(raw: RawPumpfunEvent): NormalizedLifecycleTransition | null {
    const { envelope } = raw;
    if (envelope.emittingProgram !== PUMP_PROGRAM_ID) return null;

    const base = {
      kind: "lifecycleTransition" as const,
      chain: SOLANA_CHAIN,
      venue: PUMPFUN_VENUE,
      sourceVenue: "pump",
      confidence: raw.confidence,
      provenance: provenanceOf(raw),
      observedAt: raw.observedAt,
    };

    if (envelope.eventName === "CreateEvent") {
      const event = decodePumpCreateEvent(envelope.payload);
      return {
        ...base,
        tokenAddress: event.mint,
        phase: "bonding_curve",
        eventType: "created",
        destinationVenue: null,
        destinationPool: null,
        curveAddress: event.bondingCurve,
        eventTimestamp: eventTimestampIso(event.timestamp),
        payload: {
          name: event.name || null,
          symbol: event.symbol || null,
          uri: event.uri || null,
          creator: event.creator,
          user: event.user,
          quoteMint: event.quoteMint,
          tokenTotalSupply: event.tokenTotalSupply,
          virtualTokenReserves: event.virtualTokenReserves,
          virtualSolReserves: event.virtualSolReserves,
          realTokenReserves: event.realTokenReserves,
        },
      };
    }

    if (envelope.eventName === "CompleteEvent") {
      const event = decodePumpCompleteEvent(envelope.payload);
      return {
        ...base,
        tokenAddress: event.mint,
        phase: "bonding_complete",
        eventType: "completed",
        // The curve is done. Where it goes next is not asserted by this event, so it stays null
        // rather than being guessed as PumpSwap.
        destinationVenue: null,
        destinationPool: null,
        curveAddress: event.bondingCurve,
        eventTimestamp: eventTimestampIso(event.timestamp),
        payload: { user: event.user, quoteMint: event.quoteMint },
      };
    }

    if (envelope.eventName === "CompletePumpAmmMigrationEvent") {
      const event = decodeCompletePumpAmmMigrationEvent(envelope.payload);
      return {
        ...base,
        tokenAddress: event.mint,
        phase: "pumpswap",
        eventType: "migrated",
        destinationVenue: "pumpswap",
        destinationPool: event.pool,
        curveAddress: event.bondingCurve,
        eventTimestamp: eventTimestampIso(event.timestamp),
        payload: {
          user: event.user,
          pool: event.pool,
          mintAmount: event.mintAmount,
          solAmount: event.solAmount,
          poolMigrationFee: event.poolMigrationFee,
          quoteMint: event.quoteMint,
        },
      };
    }

    return null;
  }
}

export const pumpfunAdapter = new PumpfunAdapter();
