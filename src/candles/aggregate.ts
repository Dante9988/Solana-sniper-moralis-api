/**
 * Phase 7B.5B §4/§5 — the pure, deterministic, chain-neutral candle
 * aggregation algorithm. No I/O, no Prisma, no viem, no knowledge of Pons/
 * EVM/Solana — only src/candles/types.ts and resolutions.ts. This is the
 * function a future Solana `ChainAdapter`-backed feed reuses unchanged.
 *
 * Ordering (phase7b5b.txt §1): trades are sorted once, here, by the total
 * source order (sourceHeight asc, then sourceIndex asc) — never trusted to
 * already be in that order, and never Prisma row order, insertion order, or
 * tied-timestamp order. See ARCHITECTURE.md §21.3 for why EVM `logIndex`
 * (this repo's `sourceIndex` for Robinhood/Pons) is a safe total order
 * within a block: the EVM assigns log indexes sequentially and uniquely
 * across every log in a block, in the exact order transactions execute and
 * emit them — never per-transaction-scoped, never re-used. `sourceHeight`
 * alone breaks ties across blocks; `sourceIndex` alone breaks ties within
 * one block; together they are a total order over any set of trades from
 * one chain.
 *
 * No-trade interval = no candle (phase7b5b.txt §5): a resolution/bucket
 * pair only ever appears in the output map if at least one trade fell in
 * it. Never a fabricated flat candle.
 */

import { formatScaledBigInt, parseDecimalToScaledBigInt } from "../discovery/decimal";
import { bucketStartFor, CandleResolutionId, CANDLE_RESOLUTIONS } from "./resolutions";
import type { CandleBucket, CandleTradeInput } from "./types";

const SCALE = 18;

function toSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/** Total source order — see this file's header comment. Stable sort (Array#sort in modern V8/Node is stable) but ties should never occur for distinct real trades; two trades at the same (sourceHeight, sourceIndex) would violate ChainTrade's own unique constraint upstream. */
function compareBySourceOrder(a: CandleTradeInput, b: CandleTradeInput): number {
  if (a.sourceHeight !== b.sourceHeight) return a.sourceHeight < b.sourceHeight ? -1 : 1;
  return a.sourceIndex - b.sourceIndex;
}

/**
 * Aggregates already-normalized trades into OHLCV candles for every
 * requested resolution. Trades may be passed in any order — this function
 * establishes the canonical order itself and never relies on input order.
 */
export function aggregateTrades(trades: readonly CandleTradeInput[], resolutions: readonly CandleResolutionId[] = CANDLE_RESOLUTIONS): Map<CandleResolutionId, CandleBucket[]> {
  const result = new Map<CandleResolutionId, CandleBucket[]>();
  if (trades.length === 0) {
    for (const r of resolutions) result.set(r, []);
    return result;
  }

  const ordered = [...trades].sort(compareBySourceOrder);

  for (const resolution of resolutions) {
    const buckets: CandleBucket[] = [];
    let current: {
      bucketStart: number;
      openPrice: bigint;
      highPrice: bigint;
      lowPrice: bigint;
      closePrice: bigint;
      volumeToken: bigint;
      volumeQuote: bigint;
      volumeUsd: bigint | null;
      usdAvailableForAll: boolean;
      tradeCount: number;
      traders: Set<string>;
      firstSourceHeight: bigint;
      lastSourceHeight: bigint;
    } | null = null;

    const flush = () => {
      if (!current) return;
      buckets.push({
        resolution,
        bucketStart: current.bucketStart,
        open: formatScaledBigInt(current.openPrice, SCALE),
        high: formatScaledBigInt(current.highPrice, SCALE),
        low: formatScaledBigInt(current.lowPrice, SCALE),
        close: formatScaledBigInt(current.closePrice, SCALE),
        volumeToken: formatScaledBigInt(current.volumeToken, SCALE),
        volumeQuote: formatScaledBigInt(current.volumeQuote, SCALE),
        volumeUsd: current.usdAvailableForAll && current.volumeUsd !== null ? formatScaledBigInt(current.volumeUsd, SCALE) : null,
        tradeCount: current.tradeCount,
        uniqueTraders: current.traders.size,
        firstSourceHeight: current.firstSourceHeight,
        lastSourceHeight: current.lastSourceHeight,
      });
      current = null;
    };

    for (const trade of ordered) {
      const bucketStart = bucketStartFor(toSeconds(trade.sourceTimestamp), resolution);
      const price = parseDecimalToScaledBigInt(trade.price, SCALE);
      const tokenAmount = parseDecimalToScaledBigInt(trade.tokenAmount, SCALE);
      const quoteAmount = parseDecimalToScaledBigInt(trade.quoteAmount, SCALE);
      const usdAmount = trade.usdAmount !== null ? parseDecimalToScaledBigInt(trade.usdAmount, SCALE) : null;

      if (current === null || current.bucketStart !== bucketStart) {
        flush();
        current = {
          bucketStart,
          openPrice: price,
          highPrice: price,
          lowPrice: price,
          closePrice: price,
          volumeToken: tokenAmount,
          volumeQuote: quoteAmount,
          volumeUsd: usdAmount,
          usdAvailableForAll: usdAmount !== null,
          tradeCount: 1,
          traders: new Set([trade.trader]),
          firstSourceHeight: trade.sourceHeight,
          lastSourceHeight: trade.sourceHeight,
        };
        continue;
      }

      current.closePrice = price;
      if (price > current.highPrice) current.highPrice = price;
      if (price < current.lowPrice) current.lowPrice = price;
      current.volumeToken += tokenAmount;
      current.volumeQuote += quoteAmount;
      current.usdAvailableForAll = current.usdAvailableForAll && usdAmount !== null;
      current.volumeUsd = current.usdAvailableForAll ? (current.volumeUsd ?? 0n) + (usdAmount ?? 0n) : null;
      current.tradeCount += 1;
      current.traders.add(trade.trader);
      current.lastSourceHeight = trade.sourceHeight;
    }
    flush();

    result.set(resolution, buckets);
  }

  return result;
}
