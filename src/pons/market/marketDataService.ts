/**
 * Phase 7D.4 §3 — the terminal's market data for one Pons V2 token, from OnlyPump's own indexed
 * trades: last traded price (native, and USD where a verified feed exists), total supply and FDV,
 * rolling windows with coverage, and recent trades.
 *
 * Coverage comes from ingestion, not from the presence of trades:
 *   - Bonding curve trades are ingested from the first V2 launch this database knows, so a token's
 *     curve history is complete from its own launch up to the curve stream's confirmed time.
 *   - After graduation, trades are V4 swaps. That stream starts wherever it was first run, so
 *     post-graduation coverage has an unknown start and is PARTIAL; if the stream has never
 *     committed, coverage ends at the graduation block.
 *
 * Never presents circulating market cap: circulating supply is not indexed. FDV is labelled as
 * total supply × last traded price.
 */

import type { PrismaClient } from "@prisma/client";
import { currentSessionPrefix } from "../ingestionSession";
import { ROBINHOOD_CHAIN } from "../discoveryListener";

import type { QuoteUsdRateProvider } from "../../candles/usdPricing";
import { resolveTokenDecimals } from "../../candles/decimalsResolver";
import type { ChainReader } from "../chainClient";
import { CheckpointStore } from "../checkpointStore";
import { CURVE_TRADE_CHECKPOINT_SOURCE } from "../curveTradeListener";
import { TRADE_V2_CHECKPOINT_SOURCE } from "../tradeV2Listener";
import { lookupQuoteAsset } from "../usd/chainlinkQuoteUsdRateProvider";
import { computeWindows, formatUnits, priceScaled, type Coverage, type StatTrade, type WindowStats } from "./marketStats";

const CHAIN = "robinhood";
const MAX_WINDOW_TRADES = 20_000;
const MAX_USD_VALUED_TRADES = 3_000;
const RECENT_TRADES = 50;

export interface RecentTrade {
  side: "buy" | "sell";
  tokenAmount: string;
  quoteAmount: string;
  price: string | null;
  usd: string | null;
  trader: string;
  txHash: string;
  logIndex: number;
  block: string;
  timestamp: string;
  venue: "BONDING_CURVE" | "UNISWAP_V4";
}

export interface TokenMarketData {
  token: { address: string; symbol: string | null; name: string | null; decimals: number; lifecycle: "BONDING" | "GRADUATED" };
  quoteAsset: { address: string; symbol: string | null; decimals: number; identified: boolean; usdFeed: string | null };
  price: {
    native: string | null;
    lastTradeAt: string | null;
    usd: string | null;
    usdBasis: string | null;
    usdUnavailableReason: string | null;
  };
  valuation: {
    totalSupply: string | null;
    fdvNative: string | null;
    fdvUsd: string | null;
    basis: "TOTAL_SUPPLY_x_LAST_TRADE_PRICE";
    circulatingSupply: null;
    circulatingSupplyReason: string;
  };
  coverage: { from: string | null; to: string | null; truncated: boolean; notes: string[] };
  windows: WindowStats[];
  recentTrades: RecentTrade[];
  observedAt: string;
}

export type MarketDataOutcome =
  | { status: "AVAILABLE"; market: TokenMarketData }
  | { status: "UNKNOWN_TOKEN" }
  | { status: "UNAVAILABLE"; reason: "DECIMALS_UNAVAILABLE" | "DECIMALS_CONFLICT"; detail: string };

export interface MarketDataDeps {
  db: PrismaClient;
  chainClient: ChainReader;
  usd: QuoteUsdRateProvider;
  now?: () => Date;
}

export async function fetchTokenMarketData(deps: MarketDataDeps, tokenAddressInput: string): Promise<MarketDataOutcome> {
  const now = deps.now?.() ?? new Date();
  const tokenAddress = tokenAddressInput.toLowerCase();
  const token = await deps.db.discoveredToken.findFirst({
    where: { chain: CHAIN, tokenAddress: { equals: tokenAddress, mode: "insensitive" }, canonicalStatus: "CANONICAL" },
  });
  if (!token) return { status: "UNKNOWN_TOKEN" };

  const decimals =
    token.tokenDecimals !== null && token.quoteDecimals !== null
      ? { tokenDecimals: token.tokenDecimals, quoteDecimals: token.quoteDecimals }
      : await resolveTokenDecimals(deps.chainClient, deps.db, CHAIN, token.tokenAddress, token.quoteAddress);
  if (!decimals) return { status: "UNAVAILABLE", reason: "DECIMALS_UNAVAILABLE", detail: "token or quote decimals() could not be verified on chain" };

  const asset = lookupQuoteAsset(token.quoteAddress);
  if (asset && asset.decimals !== decimals.quoteDecimals) {
    // Conflicting decimals would silently rescale every price and USD figure.
    return { status: "UNAVAILABLE", reason: "DECIMALS_CONFLICT", detail: `quote asset ${asset.symbol}: registry ${asset.decimals} decimals, chain ${decimals.quoteDecimals}` };
  }

  // Coverage from ingestion checkpoints and this token's own launch/graduation block times.
  // Phase 7D.5 — coverage is measured against the live session's streams.
  const store = new CheckpointStore(deps.db, await currentSessionPrefix(deps.db, ROBINHOOD_CHAIN));
  const [curve, v4] = await Promise.all([store.getFinalityState(CURVE_TRADE_CHECKPOINT_SOURCE), store.getFinalityState(TRADE_V2_CHECKPOINT_SOURCE)]);
  const notes: string[] = [];
  const launchAt = await blockTime(deps.chainClient, token.sourceHeight);
  const graduatedAt = token.graduated && token.graduationSourceHeight !== null ? await blockTime(deps.chainClient, token.graduationSourceHeight) : null;
  let coverage: Coverage;
  if (!token.graduated) {
    coverage = { from: launchAt, to: curve?.lastHeightTimestamp ?? null };
  } else if (!v4?.lastHeightTimestamp) {
    const curveTo = curve?.lastHeightTimestamp ?? null;
    coverage = { from: launchAt, to: curveTo && graduatedAt ? (curveTo < graduatedAt ? curveTo : graduatedAt) : curveTo };
    notes.push("Uniswap V4 trades after graduation are not ingested yet; activity after graduation is not covered.");
  } else {
    coverage = { from: null, to: v4.lastHeightTimestamp };
    notes.push("Post-graduation trade history has an unknown start, so windows are partial.");
  }
  if (!launchAt) notes.push("Launch block time could not be read; coverage start is unknown.");

  const windowStart = new Date(now.getTime() - 86_400_000);
  const [rows, baselineRow] = await Promise.all([
    deps.db.chainTrade.findMany({
      where: { chain: CHAIN, tokenAddress: token.tokenAddress.toLowerCase(), canonicalStatus: "CANONICAL", sourceTimestamp: { gt: windowStart, lte: now } },
      orderBy: [{ sourceHeight: "asc" }, { sourceIndex: "asc" }],
      take: MAX_WINDOW_TRADES + 1,
    }),
    deps.db.chainTrade.findFirst({
      where: { chain: CHAIN, tokenAddress: token.tokenAddress.toLowerCase(), canonicalStatus: "CANONICAL", sourceTimestamp: { lte: windowStart } },
      orderBy: [{ sourceHeight: "desc" }, { sourceIndex: "desc" }],
    }),
  ]);
  const truncated = rows.length > MAX_WINDOW_TRADES;
  const windowRows = truncated ? rows.slice(rows.length - MAX_WINDOW_TRADES) : rows;
  if (truncated) {
    // Dropping the oldest trades means the 24h window no longer starts where it claims to.
    coverage = { ...coverage, from: windowRows[0].sourceTimestamp };
    notes.push(`More than ${MAX_WINDOW_TRADES} trades in 24h; only the latest are used.`);
  }

  // USD per trade at its own time, newest first so recent trades and short windows are valued first.
  const usdByIndex = new Map<number, string | null>();
  const toValue = windowRows.map((_, i) => i).reverse().slice(0, MAX_USD_VALUED_TRADES);
  for (const i of toValue) {
    const r = windowRows[i];
    const rate = await deps.usd.getHistoricalRate({ chain: CHAIN, quoteAddress: token.quoteAddress, at: r.sourceTimestamp! });
    usdByIndex.set(i, rate.status === "AVAILABLE" ? multiplyUnits(BigInt(r.quoteAmount.toFixed(0)), decimals.quoteDecimals, rate.rate.rateUsdPerQuote) : null);
  }

  const toStat = (r: (typeof rows)[number], usd: string | null): StatTrade => ({
    side: r.side === "buy" ? "buy" : "sell",
    tokenAmount: BigInt(r.tokenAmount.toFixed(0)),
    quoteAmount: BigInt(r.quoteAmount.toFixed(0)),
    timestamp: r.sourceTimestamp!,
    usd,
  });
  const stats = windowRows.map((r, i) => toStat(r, usdByIndex.get(i) ?? null));
  const baseline = baselineRow?.sourceTimestamp ? toStat(baselineRow, null) : null;
  const windows = computeWindows({ trades: stats, baseline, now, coverage, tokenDecimals: decimals.tokenDecimals, quoteDecimals: decimals.quoteDecimals });

  // Last traded price, and its present USD value where the quote asset has a fresh feed.
  const lastRow = windowRows.length > 0 ? windowRows[windowRows.length - 1] : baselineRow;
  const lastStat = windowRows.length > 0 ? stats[stats.length - 1] : baseline;
  const priceNative = lastStat ? priceScaled(lastStat, decimals.tokenDecimals, decimals.quoteDecimals) : null;
  let priceUsd: string | null = null;
  let usdReason: string | null = null;
  let rateNow: string | null = null;
  if (priceNative !== null) {
    const rate = await deps.usd.getHistoricalRate({ chain: CHAIN, quoteAddress: token.quoteAddress, at: now });
    if (rate.status === "AVAILABLE") {
      rateNow = rate.rate.rateUsdPerQuote;
      priceUsd = multiplyScaled(priceNative, rateNow, 10);
    } else {
      usdReason = rate.reason;
    }
  } else {
    usdReason = "no trades have been indexed for this token";
  }

  const supply = token.supply !== null ? BigInt(token.supply.toFixed(0)) : null;
  const fdvScaled = supply !== null && priceNative !== null ? (supply * priceNative) / 10n ** BigInt(decimals.tokenDecimals) : null;

  // Latest indexed trades regardless of window: while ingestion trails the chain these can be older
  // than 24h, and each carries its own timestamp so that is visible.
  const recentRows = await deps.db.chainTrade.findMany({
    where: { chain: CHAIN, tokenAddress: token.tokenAddress.toLowerCase(), canonicalStatus: "CANONICAL", sourceTimestamp: { not: null, lte: now } },
    orderBy: [{ sourceHeight: "desc" }, { sourceIndex: "desc" }],
    take: RECENT_TRADES,
  });
  const recentTrades: RecentTrade[] = [];
  for (const r of recentRows) {
    const inWindow = windowRows.findIndex((w) => w.id === r.id);
    let usd = inWindow >= 0 ? usdByIndex.get(inWindow) ?? null : null;
    if (inWindow < 0) {
      const rate = await deps.usd.getHistoricalRate({ chain: CHAIN, quoteAddress: token.quoteAddress, at: r.sourceTimestamp! });
      usd = rate.status === "AVAILABLE" ? multiplyUnits(BigInt(r.quoteAmount.toFixed(0)), decimals.quoteDecimals, rate.rate.rateUsdPerQuote) : null;
    }
    const s = toStat(r, usd);
    const p = priceScaled(s, decimals.tokenDecimals, decimals.quoteDecimals);
    recentTrades.push({
      side: s.side,
      tokenAmount: formatUnits(s.tokenAmount, decimals.tokenDecimals),
      quoteAmount: formatUnits(s.quoteAmount, decimals.quoteDecimals),
      price: p === null ? null : formatUnits(p, 18),
      usd,
      trader: r.trader,
      txHash: r.sourceTxHash,
      logIndex: r.sourceIndex,
      block: r.sourceHeight.toString(),
      timestamp: r.sourceTimestamp!.toISOString(),
      venue: r.poolId ? "UNISWAP_V4" : "BONDING_CURVE",
    });
  }

  return {
    status: "AVAILABLE",
    market: {
      token: { address: token.tokenAddress, symbol: token.symbol, name: token.name, decimals: decimals.tokenDecimals, lifecycle: token.graduated ? "GRADUATED" : "BONDING" },
      quoteAsset: { address: token.quoteAddress.toLowerCase(), symbol: asset?.symbol ?? null, decimals: decimals.quoteDecimals, identified: Boolean(asset), usdFeed: asset?.feed?.name ?? null },
      price: {
        native: priceNative === null ? null : formatUnits(priceNative, 18),
        lastTradeAt: lastRow?.sourceTimestamp?.toISOString() ?? null,
        usd: priceUsd,
        usdBasis: priceUsd ? `last traded price × ${asset?.feed?.name ?? "quote"} now` : null,
        usdUnavailableReason: usdReason,
      },
      valuation: {
        totalSupply: supply === null ? null : formatUnits(supply, decimals.tokenDecimals),
        fdvNative: fdvScaled === null ? null : formatUnits(fdvScaled, 18),
        fdvUsd: fdvScaled !== null && rateNow ? multiplyScaled(fdvScaled, rateNow, 2) : null,
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

const blockTimes = new Map<string, Date | null>();
async function blockTime(chainClient: ChainReader, height: bigint): Promise<Date | null> {
  const key = height.toString();
  if (blockTimes.has(key)) return blockTimes.get(key)!;
  const ref = await chainClient.getBlockRef(height);
  const value = ref.status === "AVAILABLE" ? new Date(Number(ref.data.timestamp) * 1000) : null;
  if (value) blockTimes.set(key, value); // failures are retried next request
  return value;
}

function decimalToScaled(value: string, scale: number): bigint {
  const [whole, frac = ""] = value.split(".");
  return BigInt(whole) * 10n ** BigInt(scale) + BigInt((frac + "0".repeat(scale)).slice(0, scale) || "0");
}

/** raw quote base units × USD-per-whole-quote -> USD decimal string (2 dp, truncated). */
function multiplyUnits(raw: bigint, decimals: number, usdPerUnit: string): string {
  const scaled = (raw * decimalToScaled(usdPerUnit, 18)) / 10n ** BigInt(decimals);
  return formatUnits(scaled, 18, 18);
}

/** (value scaled 1e18) × decimal string -> decimal string with `fraction` digits. */
function multiplyScaled(scaled: bigint, factor: string, fraction: number): string {
  return formatUnits((scaled * decimalToScaled(factor, 18)) / 10n ** 18n, 18, fraction);
}
