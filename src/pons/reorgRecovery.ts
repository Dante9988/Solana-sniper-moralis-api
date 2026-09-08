/**
 * Phase 7B.5A §2 — bounded reorg rollback/replay.
 *
 * Phase 7B.4 could only detect a checkpoint-hash mismatch and halt, keeping
 * existing rows untouched but never reconciling them (ARCHITECTURE.md
 * §19.9 item 3). This module is the real automatic response, favoring
 * correctness over availability:
 *
 *  1. Walk the chain-scoped (height, hash) history (`ChainBlockCheckpoint`,
 *     recorded by checkpointStore.recordChainBlockCheckpoint on every
 *     committed tick) newest-to-oldest, comparing each recorded hash
 *     against a fresh live read, until one matches — that height is the
 *     common canonical ancestor.
 *  2. If found within the retained (bounded, pruned) history window: mark
 *     every DiscoveredToken/ChainTrade row above that height ORPHANED
 *     (never deleted — auditable), reset their graduation state (it was
 *     read against a token whose launch may no longer be canonical), roll
 *     every ChainIngestionCheckpoint for this chain back to the ancestor,
 *     and prune history above it — all in one transaction, so a crash
 *     mid-recovery leaves either the pre- or post-recovery state, never a
 *     half-reconciled one. The next tick's ordinary replay (idempotent
 *     upserts) then re-populates canonical facts from the ancestor forward.
 *  3. If no match is found within the retained window: fail closed. The
 *     caller (discoveryListener.ts/tradeListener.ts) records this as an
 *     unresolved reorg on the checkpoint row so the source-health
 *     projection reports REORG_RECOVERY and API consumers are never left
 *     mistaking stale/orphaned data for a healthy feed.
 *
 * This module never deletes a checkpoint outright and never fabricates an
 * ancestor when the search is inconclusive.
 */

import type { PrismaClient } from "@prisma/client";
import type { ChainReader } from "./chainClient";

export type ReorgRecoveryResult =
  | {
      status: "RECOVERED";
      ancestorHeight: bigint;
      ancestorHash: string;
      orphanedTokens: number;
      orphanedTrades: number;
      rolledBackSources: string[];
      /** Phase 7B.5B §9 — distinct tokens a CandleInvalidation row was written for in this same transaction. */
      candlesInvalidated: number;
    }
  | { status: "UNRESOLVED"; searchedDepth: number; reason: string }
  | { status: "UNAVAILABLE"; reason: string };

export interface ReorgRecoveryDeps {
  readonly chainClient: ChainReader;
  readonly db: PrismaClient;
  readonly chain: string;
}

/**
 * `chain`-scoped: a reorg is a chain-level fact, not a per-listener one, so
 * recovery rolls back every ingestion source for this chain (discovery and
 * trades both), not just whichever listener happened to detect it first —
 * required so the two checkpoints, which the discovery-before-trades
 * barrier (tradeListener.ts) assumes are mutually consistent, never end up
 * on two different sides of a fork.
 */
export async function attemptReorgRecovery(deps: ReorgRecoveryDeps): Promise<ReorgRecoveryResult> {
  const history = await deps.db.chainBlockCheckpoint.findMany({
    where: { chain: deps.chain },
    orderBy: { height: "desc" },
  });
  if (history.length === 0) {
    return { status: "UNAVAILABLE", reason: "no checkpoint history recorded for this chain yet — cannot search for a common ancestor" };
  }

  let ancestor: { height: bigint; hash: string; timestamp: bigint } | null = null;
  let searched = 0;
  for (const entry of history) {
    searched += 1;
    const live = await deps.chainClient.getBlockRef(entry.height);
    if (live.status === "UNAVAILABLE") {
      return { status: "UNAVAILABLE", reason: `getBlockRef(${entry.height.toString()}) during ancestor search: ${live.reason}` };
    }
    if (live.data.hash.toLowerCase() === entry.hash.toLowerCase()) {
      ancestor = { height: entry.height, hash: live.data.hash, timestamp: live.data.timestamp };
      break;
    }
  }

  if (!ancestor) {
    return {
      status: "UNRESOLVED",
      searchedDepth: searched,
      reason: `no common ancestor found within the retained ${searched}-checkpoint recovery window for chain "${deps.chain}"`,
    };
  }

  const { height: ancestorHeight, hash: ancestorHash, timestamp: ancestorTimestamp } = ancestor;
  const ancestorTime = new Date(Number(ancestorTimestamp) * 1000);

  const outcome = await deps.db.$transaction(async (tx) => {
    // Phase 7B.5B §9 — capture exactly which tokens are about to lose
    // canonical trades *before* orphaning them, so the CandleInvalidation
    // rows below are written in the same transaction as the orphaning
    // itself (a crash between the two cannot happen — either both land or
    // neither does). Using ancestorTime (rather than trying to find the
    // first orphaned block's own timestamp) is a deliberately conservative
    // lower bound: it can cause one extra bucket to be recomputed
    // needlessly, but can never miss one.
    const affectedTokens = await tx.chainTrade.findMany({
      where: { chain: deps.chain, canonicalStatus: "CANONICAL", sourceHeight: { gt: ancestorHeight } },
      select: { tokenAddress: true },
      distinct: ["tokenAddress"],
    });

    const orphanedTokens = await tx.discoveredToken.updateMany({
      where: { chain: deps.chain, canonicalStatus: "CANONICAL", sourceHeight: { gt: ancestorHeight } },
      data: {
        canonicalStatus: "ORPHANED",
        orphanedAt: new Date(),
        // The launch that produced this row may no longer be canonical, so
        // any graduation read against it is now unknown, not false-but-known.
        graduated: false,
        graduationPairedPrincipal: null,
        graduationThreshold: null,
        graduationCheckedAt: null,
        // Phase 7D §3 — same rationale, for Pons V2's event-sourced
        // graduation fields. Always already null for non-V2 rows, so this
        // is a no-op for V1/other venues.
        graduationPositionId: null,
        graduationTokenAmount: null,
        graduationPairTokenAmount: null,
        graduationSourceHeight: null,
        graduationSourceHash: null,
        graduationSourceTxHash: null,
        // Phase 7D §2 — the Uniswap V4 pool identity is equally a fact of
        // the (possibly no-longer-canonical) graduation event, not of the
        // token itself; reset alongside it. name/symbol/logoUrl/
        // description/socials are deliberately NOT reset here — those are
        // properties of the token contract/launch call itself (same
        // address, same immutable facts) regardless of which fork wins.
        poolId: null,
      },
    });

    // Phase 7D §2/§3 — a token can be launched well before ancestorHeight
    // (so the updateMany above never touches its row, correctly — the
    // launch itself is still canonical) but graduate *after* it. Pons V2's
    // graduation is event-sourced and never re-polled once set (unlike
    // V1's graduationPoller, which re-reads graduationStatus() every tick
    // regardless), so a reorg that invalidates only the graduation
    // transaction would otherwise leave a stale graduated=true/poolId on
    // an un-orphaned, still-canonical row. A separate query, keyed on
    // graduationSourceHeight rather than sourceHeight, closes that gap.
    await tx.discoveredToken.updateMany({
      where: { chain: deps.chain, canonicalStatus: "CANONICAL", graduationSourceHeight: { gt: ancestorHeight } },
      data: {
        graduated: false,
        graduationPositionId: null,
        graduationTokenAmount: null,
        graduationPairTokenAmount: null,
        graduationSourceHeight: null,
        graduationSourceHash: null,
        graduationSourceTxHash: null,
        poolId: null,
      },
    });

    const orphanedTrades = await tx.chainTrade.updateMany({
      where: { chain: deps.chain, canonicalStatus: "CANONICAL", sourceHeight: { gt: ancestorHeight } },
      data: { canonicalStatus: "ORPHANED", orphanedAt: new Date() },
    });

    // Phase 7B.5B §9 — one durable invalidation record per affected token.
    // The candle worker (src/candles/invalidation.ts) processes unprocessed
    // rows by fully recomputing every bucket at/after this timestamp from
    // `ChainTrade WHERE canonicalStatus = CANONICAL` — never incremental
    // arithmetic. Left unprocessed (never deleted here) until the worker
    // marks it `processedAt` — durable across a worker restart.
    if (affectedTokens.length > 0) {
      await tx.candleInvalidation.createMany({
        data: affectedTokens.map((t) => ({ chain: deps.chain, tokenAddress: t.tokenAddress, invalidatedFromTimestamp: ancestorTime })),
      });
    }

    const checkpoints = await tx.chainIngestionCheckpoint.findMany({ where: { source: { startsWith: `${deps.chain}:` } } });
    const rolledBackSources: string[] = [];
    const now = new Date();
    for (const cp of checkpoints) {
      if (cp.lastHeight > ancestorHeight) {
        await tx.chainIngestionCheckpoint.update({
          where: { source: cp.source },
          data: {
            lastHeight: ancestorHeight,
            lastHash: ancestorHash,
            lastReorgAt: now,
            reorgUnresolvedAt: null,
            reorgUnresolvedReason: null,
            lastError: null,
            lastErrorAt: null,
          },
        });
        rolledBackSources.push(cp.source);
      } else if (cp.reorgUnresolvedAt !== null) {
        // Defensive: a source that wasn't actually past the ancestor but
        // had somehow been flagged unresolved should still be cleared.
        await tx.chainIngestionCheckpoint.update({
          where: { source: cp.source },
          data: { reorgUnresolvedAt: null, reorgUnresolvedReason: null },
        });
      }
    }

    await tx.chainBlockCheckpoint.deleteMany({ where: { chain: deps.chain, height: { gt: ancestorHeight } } });

    return { orphanedTokens: orphanedTokens.count, orphanedTrades: orphanedTrades.count, rolledBackSources, candlesInvalidated: affectedTokens.length };
  });

  return { status: "RECOVERED", ancestorHeight, ancestorHash, ...outcome };
}
