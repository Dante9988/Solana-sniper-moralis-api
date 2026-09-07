/**
 * Phase 7B.5B §4 — the Pons/Robinhood adapter boundary between raw
 * `ChainTrade` rows and the chain-neutral candle domain (src/candles/**).
 * This is the ONLY place `ChainTrade` rows get read for candle purposes and
 * the ONLY place Pons-specific pricing/enrichment (verified decimals, an
 * optional USD rate) is applied — src/candles/aggregate.ts never sees a
 * ChainTrade or knows Pons/EVM exist. A future Solana feed module would
 * mirror this file's shape, producing the same `CandleTradeInput[]` from
 * Pump.fun's own normalized trades.
 */

import type { PrismaClient } from "@prisma/client";
import type { ChainReader } from "./chainClient";
import { computeNormalizedPrice, normalizeAmount } from "../discovery/normalizedPrice";
import { formatScaledBigInt, parseDecimalToScaledBigInt } from "../discovery/decimal";
import { resolveTokenDecimals } from "../candles/decimalsResolver";
import type { QuoteUsdRateProvider } from "../candles/usdPricing";
import type { CandleTradeInput } from "../candles/types";

export type CandleFeedResult =
  | { status: "OK"; trades: CandleTradeInput[]; truncated: boolean }
  | { status: "DECIMALS_UNAVAILABLE"; reason: string };

export interface LoadCandleTradeInputsParams {
  readonly db: PrismaClient;
  readonly chainClient: ChainReader;
  readonly chain: string;
  readonly tokenAddress: string;
  readonly quoteAddress: string;
  /** Inclusive lower bound on sourceTimestamp. */
  readonly fromTimestamp: Date;
  /** Exclusive upper bound on sourceTimestamp, if bounding the window (recompute passes usually omit this — "through now"). */
  readonly toTimestamp?: Date;
  /** Bounded page size — never an unbounded in-memory trade history (phase7b5b.txt §8/§17). */
  readonly cap: number;
  readonly usdRateProvider: QuoteUsdRateProvider;
}

/**
 * Loads canonical, timestamp-resolved trades for one token in a bounded
 * time window, normalizes them via verified decimals, and optionally
 * attaches a historical USD amount — the exact Pons-specific step
 * phase7b5b.txt §4 calls "Robinhood/Pons-specific enrichment/pricing... at
 * the adapter boundary."
 *
 * Excludes rows with `canonicalStatus != CANONICAL` (never fold an orphaned
 * trade into a bar) and rows with `sourceTimestamp: null` (an
 * unbackfilled/unresolved-timestamp row cannot honestly contribute to a
 * candle — phase7b5b.txt §1: "Do not fabricate timestamps for rows that
 * cannot be resolved").
 */
export async function loadCandleTradeInputs(params: LoadCandleTradeInputsParams): Promise<CandleFeedResult> {
  const decimals = await resolveTokenDecimals(params.chainClient, params.db, params.chain, params.tokenAddress, params.quoteAddress);
  if (!decimals) {
    return { status: "DECIMALS_UNAVAILABLE", reason: `verified token/quote decimals() could not be resolved for ${params.tokenAddress} (quote ${params.quoteAddress}) — see src/candles/decimalsResolver.ts` };
  }

  const rows = await params.db.chainTrade.findMany({
    where: {
      chain: params.chain,
      tokenAddress: params.tokenAddress,
      canonicalStatus: "CANONICAL",
      sourceTimestamp: { not: null, gte: params.fromTimestamp, ...(params.toTimestamp ? { lt: params.toTimestamp } : {}) },
    },
    orderBy: [{ sourceHeight: "asc" }, { sourceIndex: "asc" }],
    take: params.cap + 1,
  });

  const truncated = rows.length > params.cap;
  const page = truncated ? rows.slice(0, params.cap) : rows;

  const trades: CandleTradeInput[] = [];
  for (const row of page) {
    const tokenAmountRaw = row.tokenAmount.toFixed();
    const quoteAmountRaw = row.quoteAmount.toFixed();
    const price = computeNormalizedPrice(quoteAmountRaw, decimals.quoteDecimals, tokenAmountRaw, decimals.tokenDecimals);
    const tokenAmount = normalizeAmount(tokenAmountRaw, decimals.tokenDecimals);
    const quoteAmount = normalizeAmount(quoteAmountRaw, decimals.quoteDecimals);

    let usdAmount: string | null = null;
    // row.sourceTimestamp is non-null by construction of the query filter above.
    const sourceTimestamp = row.sourceTimestamp as Date;
    const rate = await params.usdRateProvider.getHistoricalRate({ chain: params.chain, quoteAddress: params.quoteAddress, at: sourceTimestamp });
    if (rate.status === "AVAILABLE") {
      usdAmount = multiplyDecimalStrings(quoteAmount, rate.rate.rateUsdPerQuote);
    }

    trades.push({
      side: row.side === "buy" ? "buy" : "sell",
      price,
      tokenAmount,
      quoteAmount,
      usdAmount,
      trader: row.trader,
      sourceHeight: row.sourceHeight,
      sourceIndex: row.sourceIndex,
      sourceTimestamp,
    });
  }

  return { status: "OK", trades, truncated };
}

/** Decimal-safe (never float) multiply of two decimal strings at 18-fractional-digit scale — used only for the optional USD amount. */
function multiplyDecimalStrings(a: string, b: string): string {
  const SCALE = 18;
  const scaledA = parseDecimalToScaledBigInt(a, SCALE);
  const scaledB = parseDecimalToScaledBigInt(b, SCALE);
  const product = (scaledA * scaledB) / 10n ** BigInt(SCALE);
  return formatScaledBigInt(product, SCALE);
}
