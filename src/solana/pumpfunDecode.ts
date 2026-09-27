/**
 * Phase 7E.4.3 §1/§6 — one transaction in, canonical OnlyPump facts out. Pure and synchronous.
 *
 * This is the single decode path that BOTH the live subscription and the recovery backfill call
 * (§7: "Live and recovery MUST call the same event processing path" — there is no
 * livePumpProcessor/backfillPumpProcessor split anywhere in this module).
 *
 * Decimals are resolved by the caller and passed in, which is what keeps this function pure: the
 * listener fetches them once per mint and caches, and a mint whose decimals could not be read
 * arrives here as null and stays null. Nothing here defaults to 6 or 9.
 */

import { findEvents } from "../pump/eventWalker";
import type { DecodedEventEnvelope, RawTransactionLike } from "../pump/eventWalker";
import { eventIdentityKey, eventIdentityOf } from "../pump/eventIdentity";
import { PUMPSWAP_PROGRAM_ID, PUMP_PROGRAM_ID } from "../pump/discriminators";
import { decodePumpCompleteEvent, decodePumpCreateEvent, decodeCompletePumpAmmMigrationEvent, decodePumpSwapBuyEvent, decodePumpSwapSellEvent, decodePumpTradeEvent } from "../pump/eventDecoder";
import type { NormalizedLifecycleTransition, NormalizedTokenDiscovered, NormalizedTradeExecuted } from "../discovery/types";
import { normalizeTradeEvent } from "../pump/normalizeTrade";
import { pumpfunAdapter } from "./pumpfunAdapter";
import type { RawPumpfunEvent, SolanaBlockRef } from "./pumpfunAdapter";

/** Pump.fun bonding-curve events this step maps. Anything else is counted, never dropped silently. */
const MAPPED_PUMP_EVENTS = new Set(["CreateEvent", "TradeEvent", "CompleteEvent", "CompletePumpAmmMigrationEvent"]);

/**
 * PumpSwap events this step maps (§14).
 *
 * Trades only. `CreatePoolEvent` and `InitBoostEvent` are deliberately NOT mapped: graduation is
 * established from Pump.fun's own `CompletePumpAmmMigrationEvent`, which names the pool it creates in
 * that same transaction, and a PumpSwap pool creation on its own proves nothing about a Pump.fun
 * token — anyone can create a PumpSwap pool. They stay in `unmappedEventNames`, visible in the
 * counters rather than silently ignored.
 */
const MAPPED_PUMPSWAP_EVENTS = new Set(["BuyEvent", "SellEvent"]);

function isMapped(envelope: DecodedEventEnvelope): boolean {
  if (envelope.emittingProgram === PUMP_PROGRAM_ID) return MAPPED_PUMP_EVENTS.has(envelope.eventName);
  if (envelope.emittingProgram === PUMPSWAP_PROGRAM_ID) return MAPPED_PUMPSWAP_EVENTS.has(envelope.eventName);
  return false;
}

/** The quote mint of one trade event, for the decimals a caller must resolve before decoding. */
function tradeQuoteMintOf(envelope: DecodedEventEnvelope, tx: RawTransactionLike): string | null {
  if (envelope.emittingProgram === PUMP_PROGRAM_ID && envelope.eventName === "TradeEvent") {
    return decodePumpTradeEvent(envelope.payload).quoteMint;
  }
  if (envelope.emittingProgram === PUMPSWAP_PROGRAM_ID && MAPPED_PUMPSWAP_EVENTS.has(envelope.eventName)) {
    // PumpSwap's event payload carries no mint, so the quote mint comes from the enclosing call's
    // accounts — the same resolution normalizeTrade.ts performs, reused rather than duplicated.
    const trade = normalizeTradeEvent(envelope, tx, EPOCH_PLACEHOLDER);
    return trade?.quoteMint ?? null;
  }
  return null;
}

/**
 * `normalizeTradeEvent` requires an `observedAt` it only copies through. Resolving a quote mint does
 * not care about it, and passing the real one would make this helper's result look time-dependent.
 */
const EPOCH_PLACEHOLDER = "1970-01-01T00:00:00.000Z";

export interface DecodedPumpfunBatch {
  readonly signature: string;
  readonly slot: number;
  readonly blockTime: number | null;
  readonly discovered: readonly NormalizedTokenDiscovered[];
  readonly trades: readonly NormalizedTradeExecuted[];
  readonly lifecycle: readonly NormalizedLifecycleTransition[];
  /** Canonical identity of every event mapped, so a caller can log/dedup without re-decoding. */
  readonly identities: readonly string[];
  /** Recognized Pump.fun events this version does not map yet (e.g. PumpSwap's, until §14). */
  readonly unmappedEventNames: readonly string[];
}

/**
 * The mints whose decimals a caller must resolve before decoding this transaction.
 *
 * Only creates need them: a trade's units are already exact integers and its USD conversion reads
 * decimals off the token's persisted `DiscoveredToken` row at aggregation time (§10/§11), not off
 * the trade. Returning them separately is what lets the listener batch the reads.
 */
export function mintsNeedingDecimals(tx: RawTransactionLike): { tokenMints: string[]; quoteMints: string[] } {
  const tokenMints = new Set<string>();
  const quoteMints = new Set<string>();
  for (const envelope of findEvents(tx)) {
    if (envelope.eventName === "CreateEvent" && envelope.emittingProgram === PUMP_PROGRAM_ID) {
      const event = decodePumpCreateEvent(envelope.payload);
      tokenMints.add(event.mint);
      quoteMints.add(event.quoteMint);
      continue;
    }
    // §14 — every trade's own quote mint, too. One token can trade against different quote assets
    // over its life (native SOL on the curve, whatever its PumpSwap pool uses afterwards), and a
    // trade whose quote scale differs from the token's must be caught, which needs its decimals.
    const quoteMint = tradeQuoteMintOf(envelope, tx);
    if (quoteMint) quoteMints.add(quoteMint);
  }
  return { tokenMints: [...tokenMints], quoteMints: [...quoteMints] };
}

export interface DecodePumpfunParams {
  readonly tx: RawTransactionLike;
  readonly block: SolanaBlockRef;
  readonly observedAt: string;
  /** §8 — "final" only when the containing slot is finalized. */
  readonly confidence: "provisional" | "final";
  /** mint -> decimals, or null when the read failed. Absent keys are treated as unresolved. */
  readonly decimals: ReadonlyMap<string, number | null>;
}

/**
 * Decodes one transaction into canonical facts.
 *
 * Returns an empty batch — never throws — for a transaction with no Pump.fun events, and for a
 * FAILED transaction: `findEvents` refuses those outright, because a failed transaction still
 * prints "Instruction: Buy" in its logs while no event ever fired. Verified live on 2026-09-26:
 * the WebSocket delivers failed transactions (`InstructionError`) in the same stream as
 * successful ones, so this is a real case, not a defensive one.
 */
export function decodePumpfunTransaction(params: DecodePumpfunParams): DecodedPumpfunBatch {
  const { tx, block, observedAt, confidence, decimals } = params;
  const envelopes = findEvents(tx);
  const signature = tx.transaction.signatures[0];

  const discovered: NormalizedTokenDiscovered[] = [];
  const trades: NormalizedTradeExecuted[] = [];
  const lifecycle: NormalizedLifecycleTransition[] = [];
  const identities: string[] = [];
  const unmappedEventNames: string[] = [];

  for (const envelope of envelopes) {
    if (!isMapped(envelope)) {
      unmappedEventNames.push(`${envelope.emittingProgram}:${envelope.eventName}`);
      continue;
    }

    const raw: RawPumpfunEvent = {
      envelope,
      tx,
      siblings: envelopes,
      block,
      observedAt,
      confidence,
      ...resolveDecimalsFor(envelope, tx, decimals),
    };

    const token = pumpfunAdapter.decodeTokenDiscovered(raw);
    if (token) discovered.push(token);

    const trade = pumpfunAdapter.decodeTrade(raw);
    if (trade) trades.push(trade);

    const transition = pumpfunAdapter.decodeLifecycle(raw);
    if (transition) lifecycle.push(transition);

    if (token || trade || transition) identities.push(eventIdentityKey(eventIdentityOf(envelope)));
  }

  return { signature, slot: block.slot, blockTime: block.blockTime, discovered, trades, lifecycle, identities, unmappedEventNames };
}

/**
 * Looks up the decimals one event needs: both for a create, the quote asset's for a trade.
 *
 * A trade's token decimals are deliberately left null — they are already recorded on the token's own
 * row from its create, and re-reading them per trade would be a mint lookup per trade.
 */
function resolveDecimalsFor(
  envelope: DecodedEventEnvelope,
  tx: RawTransactionLike,
  decimals: ReadonlyMap<string, number | null>
): { tokenDecimals: number | null; quoteDecimals: number | null } {
  if (envelope.eventName === "CreateEvent" && envelope.emittingProgram === PUMP_PROGRAM_ID) {
    const event = decodePumpCreateEvent(envelope.payload);
    return {
      tokenDecimals: decimals.get(event.mint) ?? null,
      quoteDecimals: decimals.get(event.quoteMint) ?? null,
    };
  }
  const quoteMint = tradeQuoteMintOf(envelope, tx);
  return { tokenDecimals: null, quoteDecimals: quoteMint === null ? null : decimals.get(quoteMint) ?? null };
}

/**
 * A human-readable summary of one event, for the live-capture evidence script (§17) and for
 * debugging. Deliberately not used by the ingestion path — nothing downstream parses this.
 */
export function describeEvent(envelope: DecodedEventEnvelope): string {
  if (envelope.emittingProgram === PUMPSWAP_PROGRAM_ID) {
    if (envelope.eventName === "BuyEvent") {
      const e = decodePumpSwapBuyEvent(envelope.payload);
      return `PumpSwap BuyEvent pool=${e.pool} baseOut=${e.baseAmountOut} userQuoteIn=${e.userQuoteAmountIn} user=${e.user}`;
    }
    if (envelope.eventName === "SellEvent") {
      const e = decodePumpSwapSellEvent(envelope.payload);
      return `PumpSwap SellEvent pool=${e.pool} baseIn=${e.baseAmountIn} userQuoteOut=${e.userQuoteAmountOut} user=${e.user}`;
    }
    return `PumpSwap ${envelope.eventName}`;
  }
  if (envelope.emittingProgram !== PUMP_PROGRAM_ID) return `${envelope.eventName}`;
  switch (envelope.eventName) {
    case "CreateEvent": {
      const e = decodePumpCreateEvent(envelope.payload);
      return `CreateEvent mint=${e.mint} symbol=${e.symbol} supply=${e.tokenTotalSupply} curve=${e.bondingCurve} quote=${e.quoteMint} creator=${e.creator}`;
    }
    case "TradeEvent": {
      const e = decodePumpTradeEvent(envelope.payload);
      return `TradeEvent mint=${e.mint} side=${e.isBuy ? "buy" : "sell"} token=${e.tokenAmount} quote=${e.quoteAmount} quoteMint=${e.quoteMint} trader=${e.user}`;
    }
    case "CompleteEvent": {
      const e = decodePumpCompleteEvent(envelope.payload);
      return `CompleteEvent mint=${e.mint} curve=${e.bondingCurve} quote=${e.quoteMint}`;
    }
    case "CompletePumpAmmMigrationEvent": {
      const e = decodeCompletePumpAmmMigrationEvent(envelope.payload);
      return `CompletePumpAmmMigrationEvent mint=${e.mint} pool=${e.pool} mintAmount=${e.mintAmount} solAmount=${e.solAmount}`;
    }
    default:
      return envelope.eventName;
  }
}
