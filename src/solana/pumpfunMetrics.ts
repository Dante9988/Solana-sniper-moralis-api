/**
 * Phase 7E.4.3 §19 — Solana ingestion counters.
 *
 * The durable half of this (processed slot, observed head) lives in `ChainIngestionCheckpoint`,
 * the same table every Robinhood stream uses; this module holds the per-process counters that
 * table has no column for.
 *
 * `unsupportedTxVersion` is the reason this file names its counters individually rather than
 * using a generic bucket. §19: "A v2/future transaction that we cannot parse must appear as
 * unsupportedTxVersion > 0, not disappear silently." The same applies to the two failure modes
 * the first live capture run exposed, both of which a naive listener would lose without trace:
 *
 *   notFoundAtCommitment  the WebSocket announces a signature ~3s before `getTransaction` can
 *                         return it. Measured 2026-09-26: 242 of 1,736 fetched immediately came
 *                         back null; every one of 20 resolved once ~3s had passed.
 *   blockIdentityMissing  `getBlock` for the containing slot was not answerable yet, so the
 *                         fact has no real `sourceHash` and is deferred rather than written with
 *                         a fabricated one.
 */

export interface SolanaIngestionCountersSnapshot {
  /** WebSocket notifications received. */
  observed: number;
  /** Notifications for transactions the chain rejected — no event ever fired in them. */
  observedFailedTx: number;
  /** Transactions fetched and decoded. */
  decoded: number;
  /** Canonical rows written. */
  persisted: number;
  /** Canonical facts already stored under the same identity — replay working as designed. */
  duplicate: number;
  /** Fetch or decode failures. */
  failed: number;
  /** Transactions whose version this build cannot parse (see transactionVersion.ts). */
  unsupportedTxVersion: number;
  /** Signatures not yet visible to the RPC; requeued, not dropped. */
  notFoundAtCommitment: number;
  /** Signatures still not visible after every retry — handed to recovery. */
  deferredToRecovery: number;
  /** Slots whose block identity could not be read, so their facts were deferred. */
  blockIdentityMissing: number;
  /** Trades for a mint with no DiscoveredToken row (created before observation began). */
  tradesForUnknownToken: number;
  /** Trades refused because their quote asset has a different decimal scale than the token's (§14). */
  tradesQuoteScaleMismatch: number;
  /** PumpSwap trades for a token whose graduation this backend never observed (§14). */
  pumpSwapTradesWithoutGraduation: number;
  /** Tokens whose create transaction was found and persisted after the fact (§14). */
  createsBackfilled: number;
  /** Tokens whose create could not be reached, so their trades stay unstorable. */
  createBackfillUnresolved: number;
  /** Recognized events this build does not map yet (PumpSwap's, until §14). */
  unmappedEvents: number;
  /** Notifications dropped because the fetch queue was full; recovery covers the gap. */
  queueOverflowed: number;
}

export interface SolanaIngestionSnapshot extends SolanaIngestionCountersSnapshot {
  solanaLiveHeadSlot: number | null;
  solanaProcessedSlot: number | null;
  solanaLagSlots: number | null;
  /** Finalized head, the basis of the §8 reconciliation window. */
  solanaFinalizedSlot: number | null;
  lastSolanaEventAt: string | null;
  lastPumpFunTradeAt: string | null;
  lastPumpFunCreateAt: string | null;
  lastPumpFunCompleteAt: string | null;
  lastPumpFunMigrationAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
}

export class SolanaIngestionMetrics {
  private counters: SolanaIngestionCountersSnapshot = {
    observed: 0,
    observedFailedTx: 0,
    decoded: 0,
    persisted: 0,
    duplicate: 0,
    failed: 0,
    unsupportedTxVersion: 0,
    notFoundAtCommitment: 0,
    deferredToRecovery: 0,
    blockIdentityMissing: 0,
    tradesForUnknownToken: 0,
    tradesQuoteScaleMismatch: 0,
    pumpSwapTradesWithoutGraduation: 0,
    createsBackfilled: 0,
    createBackfillUnresolved: 0,
    unmappedEvents: 0,
    queueOverflowed: 0,
  };

  private liveHeadSlot: number | null = null;
  private finalizedSlot: number | null = null;
  private processedSlot: number | null = null;
  private lastEventAt: Date | null = null;
  private lastTradeAt: Date | null = null;
  private lastCreateAt: Date | null = null;
  private lastCompleteAt: Date | null = null;
  private lastMigrationAt: Date | null = null;
  private lastErrorAt: Date | null = null;
  private lastError: string | null = null;

  constructor(private readonly now: () => Date = () => new Date()) {}

  increment(counter: keyof SolanaIngestionCountersSnapshot, by = 1): void {
    this.counters[counter] += by;
  }

  observeHead(params: { confirmed?: number | null; finalized?: number | null }): void {
    // Monotonic: a fresh sample never walks the head backwards past a slot already processed.
    if (params.confirmed != null && (this.liveHeadSlot === null || params.confirmed > this.liveHeadSlot)) this.liveHeadSlot = params.confirmed;
    if (params.finalized != null) this.finalizedSlot = params.finalized;
  }

  /** The highest slot whose facts are committed. Monotonic — a later out-of-order slot cannot lower it. */
  observeProcessedSlot(slot: number): void {
    if (this.processedSlot === null || slot > this.processedSlot) this.processedSlot = slot;
    // The head is a periodic sample; the processed slot updates per transaction, so the sample is
    // routinely the staler of the two. Having committed a slot's facts IS evidence the head had
    // reached it, so the head reading is raised to match rather than left to report a negative lag —
    // the first live run reported `solanaLagSlots: -29`, which is not a thing a lag can be.
    if (this.liveHeadSlot === null || slot > this.liveHeadSlot) this.liveHeadSlot = slot;
  }

  recordEvent(kind: "trade" | "create" | "complete" | "migration"): void {
    const at = this.now();
    this.lastEventAt = at;
    if (kind === "trade") this.lastTradeAt = at;
    if (kind === "create") this.lastCreateAt = at;
    if (kind === "complete") this.lastCompleteAt = at;
    if (kind === "migration") this.lastMigrationAt = at;
  }

  recordError(reason: string): void {
    this.counters.failed += 1;
    this.lastError = reason;
    this.lastErrorAt = this.now();
  }

  snapshot(): SolanaIngestionSnapshot {
    return {
      ...this.counters,
      solanaLiveHeadSlot: this.liveHeadSlot,
      solanaProcessedSlot: this.processedSlot,
      solanaLagSlots: this.liveHeadSlot !== null && this.processedSlot !== null ? this.liveHeadSlot - this.processedSlot : null,
      solanaFinalizedSlot: this.finalizedSlot,
      lastSolanaEventAt: this.lastEventAt?.toISOString() ?? null,
      lastPumpFunTradeAt: this.lastTradeAt?.toISOString() ?? null,
      lastPumpFunCreateAt: this.lastCreateAt?.toISOString() ?? null,
      lastPumpFunCompleteAt: this.lastCompleteAt?.toISOString() ?? null,
      lastPumpFunMigrationAt: this.lastMigrationAt?.toISOString() ?? null,
      lastErrorAt: this.lastErrorAt?.toISOString() ?? null,
      lastError: this.lastError,
    };
  }
}
