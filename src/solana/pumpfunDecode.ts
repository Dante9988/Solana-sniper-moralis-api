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
import { PUMP_PROGRAM_ID } from "../pump/discriminators";
import { decodePumpCompleteEvent, decodePumpCreateEvent, decodeCompletePumpAmmMigrationEvent, decodePumpTradeEvent } from "../pump/eventDecoder";
import type { NormalizedLifecycleTransition, NormalizedTokenDiscovered, NormalizedTradeExecuted } from "../discovery/types";
import { pumpfunAdapter } from "./pumpfunAdapter";
import type { RawPumpfunEvent, SolanaBlockRef } from "./pumpfunAdapter";

/** Event names this step maps. Anything else in the transaction is counted, not dropped silently. */
const MAPPED_PUMP_EVENTS = new Set(["CreateEvent", "TradeEvent", "CompleteEvent", "CompletePumpAmmMigrationEvent"]);

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
    if (envelope.eventName !== "CreateEvent" || envelope.emittingProgram !== PUMP_PROGRAM_ID) continue;
    const event = decodePumpCreateEvent(envelope.payload);
    tokenMints.add(event.mint);
    quoteMints.add(event.quoteMint);
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
    if (envelope.emittingProgram !== PUMP_PROGRAM_ID || !MAPPED_PUMP_EVENTS.has(envelope.eventName)) {
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
      ...resolveDecimalsFor(envelope, decimals),
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

/** Looks up the two decimals a create needs. Both null for every other event — they are unused. */
function resolveDecimalsFor(
  envelope: DecodedEventEnvelope,
  decimals: ReadonlyMap<string, number | null>
): { tokenDecimals: number | null; quoteDecimals: number | null } {
  if (envelope.eventName !== "CreateEvent") return { tokenDecimals: null, quoteDecimals: null };
  const event = decodePumpCreateEvent(envelope.payload);
  return {
    tokenDecimals: decimals.get(event.mint) ?? null,
    quoteDecimals: decimals.get(event.quoteMint) ?? null,
  };
}

/**
 * A human-readable summary of one event, for the live-capture evidence script (§17) and for
 * debugging. Deliberately not used by the ingestion path — nothing downstream parses this.
 */
export function describeEvent(envelope: DecodedEventEnvelope): string {
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
