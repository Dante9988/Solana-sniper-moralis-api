/**
 * Phase 7E.4.3 §6/§7/§8 — THE single Pump.fun processing path.
 *
 * §7 is a design constraint, not a preference: "Do not create livePumpProcessor and
 * backfillPumpProcessor with duplicated logic." Both the live subscription and the recovery
 * backfill call `processSignature` on this class, and neither one knows anything the other does
 * not. The only thing that differs between them is the `source` label persisted on the row.
 *
 * Two live-measured behaviours this class exists to handle, both of which would otherwise be
 * silent data loss (measured against mainnet 2026-09-26):
 *
 *  1. The WebSocket announces a signature BEFORE the RPC will return the transaction. 242 of
 *     1,736 immediate fetches came back null; all 20 sampled resolved once ~3s had passed. A
 *     listener that treated null as "nothing here" would drop ~14% of live activity while
 *     reporting itself healthy. So null is retried with backoff and, if it still does not
 *     resolve, handed to recovery — never discarded.
 *  2. `getBlock` for a very recent slot can be unanswerable. Its blockhash is the fact that makes
 *     a Solana row's `sourceHash` real, so a transaction whose block identity is missing is
 *     deferred rather than written with a placeholder.
 *
 * Finality model (§8): observation runs at `confirmed`, because `finalized` trails it by ~32
 * slots (measured: confirmed 450665109 / finalized 450665077) and discovery has to be fast.
 * Anything written from a not-yet-finalized slot is marked `provisional`, and only
 * src/solana/pumpfunFinalityReconciler.ts promotes it to `final`. Nothing irreversible — a
 * migration announcement, a social post — may act on a provisional row.
 */

import type { PrismaClient } from "@prisma/client";

import type { RawTransactionLike } from "../pump/eventWalker";
import { CheckpointStore } from "../pons/checkpointStore";
import { decodePumpfunTransaction, mintsNeedingDecimals } from "./pumpfunDecode";
import type { DecodedPumpfunBatch } from "./pumpfunDecode";
import { persistPumpfunBatch } from "./pumpfunPersistence";
import type { SolanaIngestionSource } from "./pumpfunPersistence";
import { SolanaDecimalsCache } from "./solanaDecimals";
import type { SolanaIngestionMetrics } from "./pumpfunMetrics";
import type { SolanaRpc } from "./rpc";

/**
 * One checkpoint for the whole Pump.fun stream.
 *
 * Robinhood needs separate discovery and trade checkpoints because two different `eth_getLogs`
 * queries produce them. On Solana both come out of the same transaction in the same pass, so a
 * second cursor could only ever disagree with the first.
 */
export const PUMPFUN_CHECKPOINT_SOURCE = "solana:pumpfun:ingestion";

export interface PumpfunEngineConfig {
  /** How many times to re-fetch a signature the RPC does not yet know about. */
  readonly visibilityAttempts: number;
  /** Delay between those attempts. ~3s is the measured visibility lag; this backs off from there. */
  readonly visibilityBackoffMs: number;
  /** Attempts to read the containing block's identity before deferring the transaction. */
  readonly blockIdentityAttempts: number;
}

export const DEFAULT_PUMPFUN_ENGINE_CONFIG: PumpfunEngineConfig = {
  visibilityAttempts: 4,
  visibilityBackoffMs: 1_200,
  blockIdentityAttempts: 2,
};

export type ProcessOutcome =
  | { readonly status: "PERSISTED"; readonly batch: DecodedPumpfunBatch }
  | { readonly status: "NO_EVENTS" }
  | { readonly status: "DEFERRED"; readonly reason: string }
  | { readonly status: "UNSUPPORTED_TX_VERSION"; readonly reason: string }
  | { readonly status: "FAILED"; readonly reason: string };

export interface PumpfunEngineDeps {
  readonly db: PrismaClient;
  readonly rpc: SolanaRpc;
  readonly metrics: SolanaIngestionMetrics;
  readonly config?: Partial<PumpfunEngineConfig>;
  /** Injectable for tests so retry paths do not actually wait. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
}

export class PumpfunIngestionEngine {
  private readonly config: PumpfunEngineConfig;
  private readonly decimals: SolanaDecimalsCache;
  private readonly blockCache = new Map<number, { blockhash: string; blockTime: number | null }>();
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  /** Signatures that could not be resolved live. Recovery re-attempts these first. */
  private readonly deferred = new Set<string>();
  private finalizedSlot = 0;

  constructor(private readonly deps: PumpfunEngineDeps) {
    this.config = { ...DEFAULT_PUMPFUN_ENGINE_CONFIG, ...deps.config };
    this.decimals = new SolanaDecimalsCache(deps.rpc);
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = deps.now ?? (() => new Date());
  }

  get deferredSignatures(): readonly string[] {
    return [...this.deferred];
  }

  /** Refreshes the finalized head, which decides whether new rows are provisional or final. */
  async refreshHeads(): Promise<void> {
    const [confirmed, finalized] = await Promise.all([this.deps.rpc.getSlot("confirmed"), this.deps.rpc.getSlot("finalized")]);
    this.deps.metrics.observeHead({
      confirmed: confirmed.status === "OK" ? confirmed.data : null,
      finalized: finalized.status === "OK" ? finalized.data : null,
    });
    if (finalized.status === "OK") this.finalizedSlot = finalized.data;
  }

  /**
   * Fetch, decode and persist one transaction. Idempotent: calling it twice with the same
   * signature writes nothing the second time, because every write is keyed on canonical identity.
   */
  async processSignature(signature: string, source: SolanaIngestionSource): Promise<ProcessOutcome> {
    const { rpc, metrics } = this.deps;

    let tx: RawTransactionLike | null = null;
    for (let attempt = 0; attempt < Math.max(1, this.config.visibilityAttempts); attempt += 1) {
      const fetched = await rpc.getTransaction(signature, "confirmed");
      if (fetched.status === "UNSUPPORTED_TX_VERSION") {
        // Loud, counted, and never mistaken for "no events here" (§19).
        metrics.increment("unsupportedTxVersion");
        return { status: "UNSUPPORTED_TX_VERSION", reason: fetched.reason };
      }
      if (fetched.status === "FAILED") {
        metrics.recordError(fetched.reason);
        return { status: "FAILED", reason: fetched.reason };
      }
      if (fetched.data) {
        tx = fetched.data as unknown as RawTransactionLike;
        break;
      }
      metrics.increment("notFoundAtCommitment");
      if (attempt + 1 < this.config.visibilityAttempts) await this.sleep(this.config.visibilityBackoffMs * (attempt + 1));
    }

    if (!tx) {
      this.deferred.add(signature);
      metrics.increment("deferredToRecovery");
      return { status: "DEFERRED", reason: "transaction not visible at confirmed commitment" };
    }

    this.deferred.delete(signature);
    metrics.increment("decoded");

    const events = mintsNeedingDecimals(tx);
    const decimals = await this.decimals.resolveAll([...events.tokenMints, ...events.quoteMints]);

    const block = await this.blockIdentity(tx.slot);
    if (!block) {
      this.deferred.add(signature);
      metrics.increment("blockIdentityMissing");
      metrics.increment("deferredToRecovery");
      return { status: "DEFERRED", reason: `block identity unavailable for slot ${tx.slot}` };
    }

    const batch = decodePumpfunTransaction({
      tx,
      block: { slot: tx.slot, blockhash: block.blockhash, blockTime: block.blockTime ?? tx.blockTime },
      observedAt: this.now().toISOString(),
      // The heart of §8: a slot past the finalized head is settled; anything newer is provisional.
      confidence: tx.slot <= this.finalizedSlot ? "final" : "provisional",
      decimals,
    });

    metrics.increment("unmappedEvents", batch.unmappedEventNames.length);
    if (batch.discovered.length === 0 && batch.trades.length === 0 && batch.lifecycle.length === 0) {
      return { status: "NO_EVENTS" };
    }

    const persisted = await persistPumpfunBatch({ db: this.deps.db, batch, source });
    metrics.increment("persisted", persisted.tokensCreated + persisted.tradesPersisted + persisted.lifecyclePersisted);
    metrics.increment("duplicate", persisted.tradesDuplicate + persisted.lifecycleDuplicate);
    metrics.increment("tradesForUnknownToken", persisted.tradesForUnknownToken);
    if (persisted.tradesPersisted > 0) metrics.recordEvent("trade");
    if (persisted.tokensCreated > 0) metrics.recordEvent("create");
    for (const transition of batch.lifecycle) {
      if (transition.phase === "bonding_complete") metrics.recordEvent("complete");
      if (transition.phase === "pumpswap") metrics.recordEvent("migration");
    }
    metrics.observeProcessedSlot(tx.slot);

    // The checkpoint is advanced outside the persistence transaction on purpose: it records how far
    // observation has got, and re-processing a slot is free (every write is identity-keyed), while
    // a checkpoint ahead of the data would skip events permanently.
    await this.advanceCheckpoint(tx.slot, block.blockhash);

    return { status: "PERSISTED", batch };
  }

  private async blockIdentity(slot: number): Promise<{ blockhash: string; blockTime: number | null } | null> {
    const cached = this.blockCache.get(slot);
    if (cached) return cached;
    for (let attempt = 0; attempt < Math.max(1, this.config.blockIdentityAttempts); attempt += 1) {
      const result = await this.deps.rpc.getBlockIdentity(slot, "confirmed");
      if (result.status === "OK" && result.data) {
        const value = { blockhash: result.data.blockhash, blockTime: result.data.blockTime };
        this.blockCache.set(slot, value);
        // Bounded: a listener runs for weeks, and only recent slots are ever asked for again.
        if (this.blockCache.size > 4_096) {
          for (const key of [...this.blockCache.keys()].sort((a, b) => a - b).slice(0, 1_024)) this.blockCache.delete(key);
        }
        return value;
      }
      if (attempt + 1 < this.config.blockIdentityAttempts) await this.sleep(this.config.visibilityBackoffMs);
    }
    return null;
  }

  /**
   * Moves the checkpoint forward only. Out-of-order arrival is normal — several workers process
   * different slots concurrently — and a checkpoint that went backwards would re-scan, while one
   * that jumped ahead would skip.
   */
  private async advanceCheckpoint(slot: number, blockhash: string): Promise<void> {
    const store = new CheckpointStore(this.deps.db);
    const existing = await store.get(PUMPFUN_CHECKPOINT_SOURCE);
    if (existing && existing.lastHeight >= BigInt(slot)) return;
    await store.set(
      PUMPFUN_CHECKPOINT_SOURCE,
      { lastHeight: BigInt(slot), lastHash: blockhash },
      this.finalizedSlot > 0 ? BigInt(this.finalizedSlot) : undefined,
      // Deliberately NOT set here. `lastHeightTimestamp` is what §11's finality gate
      // (src/candles/finality.ts) reads to decide whether a candle bucket may become FINAL, and
      // this method runs on CONFIRMED slots — writing it here would finalize buckets from data
      // that can still change. Only pumpfunFinalityReconciler.ts, which works behind the
      // finalized head, advances it. `lastHeight` tracks confirmed progress because that is what
      // recovery needs as its floor; the two fields answer different questions on purpose.
      undefined
    );
  }
}
