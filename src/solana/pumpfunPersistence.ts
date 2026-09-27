/**
 * Phase 7E.4.3 §5/§6/§12/§13 — writing canonical Pump.fun facts into the EXISTING models.
 *
 * No new tables and no `SolanaDiscoveredToken` (§5). Four existing models carry it:
 *
 *   DiscoveredToken      chain="solana", venue="pumpfun"   — the token, one row per mint (§4)
 *   ChainTrade           chain="solana"                    — the trade the candle pipeline reads
 *   PumpLifecycleEvent                                     — the raw lifecycle/migration record
 *   TokenLifecycleState                                    — the token's current phase
 *
 * `PumpLifecycleEvent` was schema-only before this phase (no writer anywhere in the repository),
 * and it is used rather than replaced because its UNIQUE
 * (signature, outerInstructionIndex, innerPosition, emittingProgram) is exactly the canonical
 * Solana event identity §6 asks for, including the -1 innerPosition sentinel that exists because
 * Postgres treats NULLs in a UNIQUE index as distinct.
 *
 * `PumpTrade` is deliberately NOT written. It would be a second store of the same trades that
 * `ChainTrade` holds, and §11 requires the existing market pipeline — which reads `ChainTrade` —
 * to be the one that aggregates them. Two stores of one fact is how volume gets double counted.
 *
 * Idempotency is the database's job here, not a Set's (§6): every write below is an upsert or a
 * createMany(skipDuplicates) keyed on a canonical identity, so replaying a transaction — from a
 * duplicate WebSocket frame, a restart, or the recovery path fetching it again — changes nothing.
 */

import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

import { PUMP_PROGRAM_ID } from "../pump/discriminators";
import type { NormalizedLifecycleTransition, NormalizedTokenDiscovered, NormalizedTradeExecuted } from "../discovery/types";
import { decodeSolanaSourceIndex } from "./pumpfunAdapter";
import type { DecodedPumpfunBatch } from "./pumpfunDecode";

/** Which ingestion path produced a row. `PumpLifecycleEvent.source`'s existing vocabulary. */
export type SolanaIngestionSource = "live stream" | "historical backfill" | "block reconciliation";

/**
 * Canonical lifecycle eventType -> `PumpLifecycleEvent.eventType`'s existing vocabulary.
 *
 * "migrated" maps to `pumpswap_pool_created` because that is literally what
 * CompletePumpAmmMigrationEvent proves: the destination pool was created, in that transaction, and
 * the event names it. Reusing the existing vocabulary keeps one set of strings in the table.
 */
const LIFECYCLE_EVENT_TYPES: Record<string, string> = {
  created: "created",
  completed: "completed",
  migrated: "pumpswap_pool_created",
};

/**
 * Lifecycle phase ordering, used to guarantee a late-arriving earlier event can never drag a
 * token's state backwards. Recovery replays history out of order by design, so this is load
 * bearing, not defensive.
 */
const PHASE_RANK: Record<string, number> = { unsupported: -1, bonding_curve: 0, bonding_complete: 1, migrating: 2, pumpswap: 3 };

export interface PersistPumpfunResult {
  readonly tokensCreated: number;
  readonly tokensUpdated: number;
  readonly tradesPersisted: number;
  readonly tradesDuplicate: number;
  /** Trades whose mint has no DiscoveredToken row — counted, never silently dropped. */
  readonly tradesForUnknownToken: number;
  /**
   * §14 — trades whose quote asset has a different decimal scale than the one recorded on the token.
   * Refused, because the candle pipeline values every trade of a token at the token's recorded scale.
   */
  readonly tradesQuoteScaleMismatch: number;
  /**
   * §14 — PumpSwap trades for a token this backend has never seen graduate. The trade is stored (it
   * is real), but the lifecycle is NOT advanced from it. Surfaces the gap instead of inferring.
   */
  readonly pumpSwapTradesWithoutGraduation: number;
  readonly lifecyclePersisted: number;
  readonly lifecycleDuplicate: number;
  readonly lifecycleStateAdvanced: number;
  /** Facts that could not be written because a required chain fact was missing (fail closed). */
  readonly skippedIncomplete: number;
}

const EMPTY: PersistPumpfunResult = {
  tokensCreated: 0,
  tokensUpdated: 0,
  tradesPersisted: 0,
  tradesDuplicate: 0,
  tradesForUnknownToken: 0,
  tradesQuoteScaleMismatch: 0,
  pumpSwapTradesWithoutGraduation: 0,
  lifecyclePersisted: 0,
  lifecycleDuplicate: 0,
  lifecycleStateAdvanced: 0,
  skippedIncomplete: 0,
};

export interface PersistPumpfunParams {
  readonly db: PrismaClient;
  readonly batch: DecodedPumpfunBatch;
  readonly source: SolanaIngestionSource;
}

/**
 * Persists one decoded transaction's facts in a single database transaction.
 *
 * All-or-nothing per transaction on purpose: a create and its own dev buy arrive together, and a
 * reader must never see the trade without the token it belongs to.
 */
export async function persistPumpfunBatch(params: PersistPumpfunParams): Promise<PersistPumpfunResult> {
  const { db, batch, source } = params;
  if (batch.discovered.length === 0 && batch.trades.length === 0 && batch.lifecycle.length === 0) return EMPTY;

  const blockTime = batch.blockTime === null ? null : new Date(batch.blockTime * 1000);

  return db.$transaction(async (tx) => {
    const result = { ...EMPTY } as {
      -readonly [K in keyof PersistPumpfunResult]: PersistPumpfunResult[K];
    };

    for (const token of batch.discovered) {
      const outcome = await upsertDiscoveredToken(tx, token);
      if (outcome === "created") result.tokensCreated += 1;
      else result.tokensUpdated += 1;
    }

    for (const trade of batch.trades) {
      if (blockTime === null) {
        // ChainTrade.sourceTimestamp is what a candle bucket is derived from. A trade with no
        // real chain time cannot contribute to one, and inventing a time would fabricate a bar.
        result.skippedIncomplete += 1;
        continue;
      }
      const known = await tx.discoveredToken.findUnique({
        where: { chain_tokenAddress: { chain: trade.chain, tokenAddress: trade.tokenAddress } },
        select: { id: true, quoteAddress: true, quoteDecimals: true },
      });
      if (!known) {
        // The token was created before this listener started observing. Its trades are real, but
        // nothing downstream can price them without the token's decimals, so they are counted
        // here and left for a backfill rather than written half-interpretable.
        result.tradesForUnknownToken += 1;
        continue;
      }

      // §14 — a migrated token keeps its identity, but its PumpSwap pool need not use the quote asset
      // its bonding curve did. Observed on mainnet 2026-09-26: PumpSwap pools quoted in wrapped SOL
      // (9 decimals) and in several 6-decimal assets. The candle pipeline reads ONE `quoteDecimals`
      // off the token's row and applies it to every trade of that token, so a trade at a different
      // scale would be mis-valued by a factor of 10^(difference) — silently, and in the chart.
      //
      // Refused rather than stored, because a stored row would be picked up by the aggregator. The
      // counter is what makes it visible. Trades that merely name a different ADDRESS at the same
      // scale (native SOL vs wrapped SOL, both 9) are fine and pass: they are the same asset.
      if (
        trade.quoteAddress !== known.quoteAddress &&
        trade.quoteDecimals != null &&
        known.quoteDecimals != null &&
        trade.quoteDecimals !== known.quoteDecimals
      ) {
        result.tradesQuoteScaleMismatch += 1;
        continue;
      }

      if (trade.venue === "pumpswap") {
        const lifecycle = await tx.tokenLifecycleState.findUnique({ where: { mint: trade.tokenAddress }, select: { state: true } });
        // A PumpSwap trade means the token must have migrated — but this backend only calls a token
        // graduated when a migration event proved it and named the pool. Seeing the trade first (we
        // started observing after the migration) is a coverage gap, reported as one. Inferring
        // graduation from a trade is exactly what §14 forbids, so the state is left alone.
        if (lifecycle?.state !== "pumpswap") result.pumpSwapTradesWithoutGraduation += 1;
      }

      const written = await upsertChainTrade(tx, trade, blockTime);
      if (written) result.tradesPersisted += 1;
      else result.tradesDuplicate += 1;
    }

    for (const transition of batch.lifecycle) {
      if (blockTime === null) {
        result.skippedIncomplete += 1;
        continue;
      }
      const written = await insertLifecycleEvent(tx, transition, batch, blockTime, source);
      if (written) result.lifecyclePersisted += 1;
      else result.lifecycleDuplicate += 1;
      if (await advanceLifecycleState(tx, transition, written)) result.lifecycleStateAdvanced += 1;
    }

    return result;
  });
}

type Tx = Prisma.TransactionClient;

async function upsertDiscoveredToken(tx: Tx, token: NormalizedTokenDiscovered): Promise<"created" | "updated"> {
  const existing = await tx.discoveredToken.findUnique({
    where: { chain_tokenAddress: { chain: token.chain, tokenAddress: token.tokenAddress } },
    select: { id: true, name: true, symbol: true, tokenDecimals: true, quoteDecimals: true, logoUrl: true },
  });

  const metadata = token.metadata;

  if (!existing) {
    await tx.discoveredToken.create({
      data: {
        chain: token.chain,
        venue: token.venue,
        tokenAddress: token.tokenAddress,
        deployer: token.deployer,
        poolAddress: token.poolAddress,
        curveAddress: metadata?.curveAddress ?? null,
        quoteAddress: token.quoteAddress,
        name: metadata?.name ?? null,
        symbol: metadata?.symbol ?? null,
        // The metadata URI is recorded, never fetched here (§2: the listener resolves no images).
        description: metadata?.metadataUri ?? null,
        supply: new Prisma.Decimal(token.supply),
        initialBuyAmount: new Prisma.Decimal(token.initialBuyAmount),
        tokenDecimals: metadata?.tokenDecimals ?? null,
        quoteDecimals: metadata?.quoteDecimals ?? null,
        // "COMPLETE" here means nothing further is owed: unlike Pons, every field above came out
        // of the CreateEvent itself or a mint read in the same tick — there is no second
        // enrichment call to wait for. PENDING when a decimals read failed, so it retries.
        enrichmentStatus: metadata?.tokenDecimals != null && metadata?.quoteDecimals != null ? "COMPLETE" : "PENDING",
        richMetadataStatus: metadata?.name ? "FOUND" : "UNAVAILABLE",
        richMetadataSource: metadata?.name ? "pumpfun_create_event" : null,
        sourceHeight: BigInt(token.provenance.sourceHeight),
        sourceHash: token.provenance.sourceHash,
        sourceTxHash: token.provenance.sourceTxHash,
        sourceIndex: token.provenance.sourceIndex,
      },
    });
    return "created";
  }

  // A replayed CreateEvent must not rewrite the token's origin: sourceHeight/sourceHash/
  // sourceTxHash/sourceIndex and deployer are first-observation facts and are never updated here.
  // Only genuinely-missing fields are filled in, so a later read that succeeded can complete a row
  // an earlier failed read left partial.
  const fill: Prisma.DiscoveredTokenUpdateInput = {};
  if (existing.name === null && metadata?.name) fill.name = metadata.name;
  if (existing.symbol === null && metadata?.symbol) fill.symbol = metadata.symbol;
  if (existing.tokenDecimals === null && metadata?.tokenDecimals != null) fill.tokenDecimals = metadata.tokenDecimals;
  if (existing.quoteDecimals === null && metadata?.quoteDecimals != null) fill.quoteDecimals = metadata.quoteDecimals;
  if (Object.keys(fill).length > 0) {
    const decimalsNowComplete =
      (existing.tokenDecimals ?? metadata?.tokenDecimals ?? null) !== null &&
      (existing.quoteDecimals ?? metadata?.quoteDecimals ?? null) !== null;
    if (decimalsNowComplete) fill.enrichmentStatus = "COMPLETE";
    await tx.discoveredToken.update({
      where: { chain_tokenAddress: { chain: token.chain, tokenAddress: token.tokenAddress } },
      data: fill,
    });
  }
  return "updated";
}

/** True when a new row was written, false when this exact trade identity was already stored. */
async function upsertChainTrade(tx: Tx, trade: NormalizedTradeExecuted, blockTime: Date): Promise<boolean> {
  const created = await tx.chainTrade.createMany({
    data: [
      {
        chain: trade.chain,
        venue: trade.venue,
        tokenAddress: trade.tokenAddress,
        poolAddress: trade.poolAddress,
        side: trade.side,
        tokenAmount: new Prisma.Decimal(trade.tokenAmount),
        quoteAmount: new Prisma.Decimal(trade.quoteAmount),
        quoteAddress: trade.quoteAddress,
        priceQuote: new Prisma.Decimal(trade.priceQuote),
        trader: trade.trader,
        sourceHeight: BigInt(trade.provenance.sourceHeight),
        sourceHash: trade.provenance.sourceHash,
        sourceTxHash: trade.provenance.sourceTxHash,
        sourceIndex: trade.provenance.sourceIndex,
        // The chain's own time for this slot, never insertion time — the candle bucket depends on it.
        sourceTimestamp: blockTime,
      },
    ],
    skipDuplicates: true,
  });
  return created.count > 0;
}

async function insertLifecycleEvent(
  tx: Tx,
  transition: NormalizedLifecycleTransition,
  batch: DecodedPumpfunBatch,
  blockTime: Date,
  source: SolanaIngestionSource
): Promise<boolean> {
  const { outerInstructionIndex, innerPosition } = decodeSolanaSourceIndex(transition.provenance.sourceIndex);
  const created = await tx.pumpLifecycleEvent.createMany({
    data: [
      {
        mint: transition.tokenAddress,
        eventType: LIFECYCLE_EVENT_TYPES[transition.eventType] ?? transition.eventType,
        emittingProgram: PUMP_PROGRAM_ID,
        signature: transition.provenance.sourceTxHash,
        outerInstructionIndex,
        innerPosition,
        slot: BigInt(transition.provenance.sourceHeight),
        outerTxPosition: null,
        blockTime,
        eventTime: transition.eventTimestamp ? new Date(transition.eventTimestamp) : null,
        // §8 — a pre-finalized observation is provisional, so nothing downstream may treat it as
        // irreversible. The reconciler promotes it to final, or marks it orphaned.
        status: transition.confidence === "final" ? "final" : "provisional",
        source,
        poolAddress: transition.destinationPool,
        bondingCurveAddress: transition.curveAddress,
        // §13's migration contract, stored so a later social/outbox consumer needs no RPC at all.
        payload: {
          ...transition.payload,
          chain: transition.chain,
          launchpad: transition.venue,
          sourceVenue: transition.sourceVenue,
          destinationVenue: transition.destinationVenue,
          destinationPool: transition.destinationPool,
          phase: transition.phase,
          canonicalEventType: transition.eventType,
          sourceHash: transition.provenance.sourceHash,
          blockTime: blockTime.toISOString(),
          batchSignature: batch.signature,
        } as Prisma.InputJsonValue,
      },
    ],
    skipDuplicates: true,
  });
  return created.count > 0;
}

/**
 * Moves the token's current phase forward, never backward.
 *
 * Guarded on both the phase ranking and the slot, because the recovery path can legitimately
 * deliver an older CreateEvent after a newer CompleteEvent has already been seen live.
 */
async function advanceLifecycleState(tx: Tx, transition: NormalizedLifecycleTransition, isNewEvent: boolean): Promise<boolean> {
  const slot = BigInt(transition.provenance.sourceHeight);
  const existing = await tx.tokenLifecycleState.findUnique({ where: { mint: transition.tokenAddress } });

  if (!existing) {
    await tx.tokenLifecycleState.create({
      data: {
        mint: transition.tokenAddress,
        state: transition.phase,
        bondingCurve: transition.curveAddress,
        pumpswapPool: transition.destinationPool,
        lastEventId: transition.provenance.sourceTxHash,
        lastEventSlot: slot,
      },
    });
    return true;
  }

  const currentRank = PHASE_RANK[existing.state] ?? -1;
  const nextRank = PHASE_RANK[transition.phase] ?? -1;
  if (nextRank < currentRank) return false;
  if (nextRank === currentRank && !isNewEvent) return false;
  if (nextRank === currentRank && existing.lastEventSlot >= slot) return false;

  await tx.tokenLifecycleState.update({
    where: { mint: transition.tokenAddress },
    data: {
      state: transition.phase,
      bondingCurve: transition.curveAddress ?? existing.bondingCurve,
      pumpswapPool: transition.destinationPool ?? existing.pumpswapPool,
      lastEventId: transition.provenance.sourceTxHash,
      lastEventSlot: slot,
    },
  });
  return true;
}
