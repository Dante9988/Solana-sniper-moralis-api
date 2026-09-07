/**
 * Phase 7B.5B §4 — the chain-neutral candle domain's own input/output
 * contract. `CandleTradeInput` is the seam: a chain-specific adapter (Pons
 * today — src/pons/candleFeed.ts; a future Solana feed later) produces
 * these from its own raw facts (ChainTrade + verified decimals + an
 * optional USD rate), and `aggregate.ts` never imports anything
 * chain-specific — only this file and resolutions.ts.
 */

import type { CandleResolutionId } from "./resolutions";

/**
 * One already-normalized trade, ready for aggregation. Every amount is a
 * decimal-safe string (never a JS number) at a fixed 18-fractional-digit
 * scale (src/discovery/normalizedPrice.ts / decimalDivide's default) —
 * `aggregate.ts` parses these once into scaled BigInts for exact OHLC/volume
 * math, never floating point (phase7b5b.txt §2/§16).
 */
export interface CandleTradeInput {
  readonly side: "buy" | "sell";
  /** Normalized execution price — see src/discovery/normalizedPrice.ts. */
  readonly price: string;
  /** Normalized (decimal-adjusted) token amount, always positive. */
  readonly tokenAmount: string;
  /** Normalized (decimal-adjusted) quote amount, always positive. */
  readonly quoteAmount: string;
  /** Normalized USD amount, or null if no verified historical quote->USD rate was available for this trade's time (§3) — never estimated/backfilled from a later or current rate. */
  readonly usdAmount: string | null;
  /**
   * Phase 7B.5B §6 — the observed swap recipient/router-facing address
   * (`ChainTrade.trader`), NOT a verified ultimate economic trader. Counted
   * for `uniqueTraders` under that explicit semantic only — never presented
   * as a stronger "unique user" claim.
   */
  readonly trader: string;
  /** Total source order: (sourceHeight, sourceIndex) — phase7b5b.txt §1. Never Prisma row order, insertion order, UUID order, or tied timestamps. */
  readonly sourceHeight: bigint;
  readonly sourceIndex: number;
  /** The real source-chain block time — never DB insertion/API observation time. */
  readonly sourceTimestamp: Date;
}

/** One resolution's fully-computed bucket — pure aggregate.ts output, before status/persistence decisions. */
export interface CandleBucket {
  readonly resolution: CandleResolutionId;
  /** Unix seconds — the deterministic UTC bucket boundary (resolutions.ts's bucketStartFor), never a Date/ISO string here (matches the frontend Candle.startTime contract). */
  readonly bucketStart: number;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volumeToken: string;
  readonly volumeQuote: string;
  /** Null unless every trade contributing to this bucket had a non-null usdAmount — never partially estimated. */
  readonly volumeUsd: string | null;
  readonly tradeCount: number;
  readonly uniqueTraders: number;
  readonly firstSourceHeight: bigint;
  readonly lastSourceHeight: bigint;
}
