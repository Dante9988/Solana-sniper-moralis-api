/**
 * Phase 7E.4.4 — the terminal's market data for one Solana token, in the SAME `TokenMarketData`
 * shape Robinhood's terminal already renders (src/pons/market/marketDataService.ts), so the frontend
 * reuses one terminal instead of growing a second one.
 *
 * Database only: every number comes from canonical `ChainTrade` rows and the token's own row. The
 * window arithmetic is Robinhood's (`marketStats.ts`), unchanged. Only coverage is Solana's own:
 *
 *   from  the token's create, when the create was observed LIVE — every later trade of a mint we
 *         watched being created is in the program subscription or the recovery sweep. A create that
 *         was only found by a later backfill means earlier trades were never observed, so `from`
 *         is unknown and the windows say PARTIAL rather than implying a complete history.
 *   to    the finalized slot time the Pump.fun checkpoint has reached.
 *
 * USD is never computed: there is no trusted SOL/USD source configured (§12). Every USD field is
 * null with the reason stated, and the quote amounts are exact.
 */

import type { PrismaClient } from "@prisma/client";

import { CheckpointStore } from "../pons/checkpointStore";
import { computeWindows, formatUnits, priceScaled, type Coverage, type StatTrade } from "../pons/market/marketStats";
import type { MarketDataOutcome, RecentTrade } from "../pons/market/marketDataService";
import { PUMPFUN_CHECKPOINT_SOURCE } from "./pumpfunIngestionEngine";
import { solanaQuoteAsset } from "./solanaQuoteAssets";

const CHAIN = "solana";
const MAX_WINDOW_TRADES = 20_000;
const RECENT_TRADES = 50;
export const SOLANA_USD_UNAVAILABLE = "No trusted SOL/USD rate is configured, so USD values are not shown.";

export async function fetchSolanaTokenMarketData(db: PrismaClient, mint: string, now: Date = new Date()): Promise<MarketDataOutcome> {
  // Exact, case-sensitive match: a base58 mint differs from its lowercase form.
  const token = await db.discoveredToken.findUnique({ where: { chain_tokenAddress: { chain: CHAIN, tokenAddress: mint } } });
  if (!token || token.canonicalStatus !== "CANONICAL") return { status: "UNKNOWN_TOKEN" };
  if (token.tokenDecimals === null || token.quoteDecimals === null) {
    return { status: "UNAVAILABLE", reason: "DECIMALS_UNAVAILABLE", detail: "the mint's decimals have not been read yet" };
  }
  const decimals = { tokenDecimals: token.tokenDecimals, quoteDecimals: token.quoteDecimals };
  const asset = solanaQuoteAsset(token.quoteAddress);
  if (asset && asset.decimals !== decimals.quoteDecimals) {
    return { status: "UNAVAILABLE", reason: "DECIMALS_CONFLICT", detail: `quote asset ${asset.symbol}: registry ${asset.decimals} decimals, chain ${decimals.quoteDecimals}` };
  }

  const [created, finality, lifecycle] = await Promise.all([
    db.pumpLifecycleEvent.findFirst({ where: { mint, eventType: "created" }, orderBy: { slot: "asc" }, select: { blockTime: true, source: true } }),
    new CheckpointStore(db).getFinalityState(PUMPFUN_CHECKPOINT_SOURCE),
    db.tokenLifecycleState.findUnique({ where: { mint }, select: { state: true } }),
  ]);
  const notes: string[] = [];
  const coverage: Coverage = { from: null, to: finality?.lastHeightTimestamp ?? null };
  if (created?.source === "live stream") coverage.from = created.blockTime;
  else notes.push("OnlyPump started watching this token after it launched, so trades before that are not indexed and windows are partial.");
  if (!coverage.to) notes.push("Solana ingestion has not confirmed any finalized progress yet.");
  if (lifecycle?.state === "pumpswap") notes.push("After graduation, PumpSwap trades are followed per pool; a pool first seen after it started trading may be missing earlier trades.");

  const windowStart = new Date(now.getTime() - 86_400_000);
  const [rows, baselineRow] = await Promise.all([
    db.chainTrade.findMany({
      where: { chain: CHAIN, tokenAddress: mint, canonicalStatus: "CANONICAL", sourceTimestamp: { gt: windowStart, lte: now } },
      orderBy: [{ sourceHeight: "asc" }, { sourceIndex: "asc" }],
      take: MAX_WINDOW_TRADES + 1,
    }),
    db.chainTrade.findFirst({
      where: { chain: CHAIN, tokenAddress: mint, canonicalStatus: "CANONICAL", sourceTimestamp: { lte: windowStart } },
      orderBy: [{ sourceHeight: "desc" }, { sourceIndex: "desc" }],
    }),
  ]);
  const truncated = rows.length > MAX_WINDOW_TRADES;
  const windowRows = truncated ? rows.slice(rows.length - MAX_WINDOW_TRADES) : rows;
  if (truncated) {
    coverage.from = windowRows[0].sourceTimestamp;
    notes.push(`More than ${MAX_WINDOW_TRADES} trades in 24h; only the latest are used.`);
  }

  const toStat = (r: (typeof rows)[number]): StatTrade => ({
    side: r.side === "buy" ? "buy" : "sell",
    tokenAmount: BigInt(r.tokenAmount.toFixed(0)),
    quoteAmount: BigInt(r.quoteAmount.toFixed(0)),
    timestamp: r.sourceTimestamp!,
    usd: null,
  });
  const stats = windowRows.map(toStat);
  const baseline = baselineRow?.sourceTimestamp ? toStat(baselineRow) : null;
  const windows = computeWindows({ trades: stats, baseline, now, coverage, ...decimals });

  const lastRow = windowRows.length > 0 ? windowRows[windowRows.length - 1] : baselineRow;
  const lastStat = windowRows.length > 0 ? stats[stats.length - 1] : baseline;
  const priceNative = lastStat ? priceScaled(lastStat, decimals.tokenDecimals, decimals.quoteDecimals) : null;
  const supply = token.supply !== null ? BigInt(token.supply.toFixed(0)) : null;
  const fdvScaled = supply !== null && priceNative !== null ? (supply * priceNative) / 10n ** BigInt(decimals.tokenDecimals) : null;

  const recentRows = await db.chainTrade.findMany({
    where: { chain: CHAIN, tokenAddress: mint, canonicalStatus: "CANONICAL", sourceTimestamp: { not: null, lte: now } },
    orderBy: [{ sourceHeight: "desc" }, { sourceIndex: "desc" }],
    take: RECENT_TRADES,
  });
  const recentTrades: RecentTrade[] = recentRows.map((r) => {
    const s = toStat(r);
    const p = priceScaled(s, decimals.tokenDecimals, decimals.quoteDecimals);
    return {
      side: s.side,
      tokenAmount: formatUnits(s.tokenAmount, decimals.tokenDecimals),
      quoteAmount: formatUnits(s.quoteAmount, decimals.quoteDecimals),
      price: p === null ? null : formatUnits(p, 18),
      usd: null,
      // Base58, exactly as the chain wrote it — never case-normalized.
      trader: r.trader,
      txHash: r.sourceTxHash,
      logIndex: r.sourceIndex,
      block: r.sourceHeight.toString(),
      timestamp: r.sourceTimestamp!.toISOString(),
      venue: r.venue === "pumpswap" ? "PUMPSWAP" : "BONDING_CURVE",
    };
  });

  return {
    status: "AVAILABLE",
    market: {
      token: { address: token.tokenAddress, symbol: token.symbol, name: token.name, decimals: decimals.tokenDecimals, lifecycle: token.graduated ? "GRADUATED" : "BONDING" },
      quoteAsset: { address: token.quoteAddress, symbol: asset?.symbol ?? null, decimals: decimals.quoteDecimals, identified: Boolean(asset), usdFeed: null },
      price: {
        native: priceNative === null ? null : formatUnits(priceNative, 18),
        lastTradeAt: lastRow?.sourceTimestamp?.toISOString() ?? null,
        usd: null,
        usdBasis: null,
        usdUnavailableReason: priceNative === null ? "no trades have been indexed for this token" : SOLANA_USD_UNAVAILABLE,
      },
      valuation: {
        totalSupply: supply === null ? null : formatUnits(supply, decimals.tokenDecimals),
        fdvNative: fdvScaled === null ? null : formatUnits(fdvScaled, 18),
        fdvUsd: null,
        basis: "TOTAL_SUPPLY_x_LAST_TRADE_PRICE",
        circulatingSupply: null,
        circulatingSupplyReason: "Circulating supply is not indexed, so market cap is not shown; FDV uses total supply.",
      },
      coverage: { from: coverage.from?.toISOString() ?? null, to: coverage.to?.toISOString() ?? null, truncated, notes },
      windows,
      recentTrades,
      observedAt: now.toISOString(),
    },
  };
}
