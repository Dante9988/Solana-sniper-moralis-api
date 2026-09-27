/**
 * Phase 7E.4 §1/§2/§10 — who is allowed into Trending, and why.
 *
 * This is deliberately NOT a safe/unsafe boolean.
 *
 * Nothing here ever says a token is safe. It cannot: no gate in this file, and no gate this
 * project could write, prevents a creator pulling liquidity a second after the check ran.
 * What it does is state verifiable facts — this token's liquidity is 0.05% of its valuation,
 * this token has three traders, this token's snapshot is nine minutes old — and classify on
 * those facts alone. `ELIGIBLE` means "clears the configured bars for promotion", not "safe".
 * `HIGH_RISK` means "has a severe, measured liquidity or provenance problem", not "scam".
 *
 * Default Trending shows ELIGIBLE only. The reasons travel with the classification so a UI
 * can explain an exclusion instead of silently dropping a token the user was looking for.
 */

import type { TrendingConfig } from "./trendingConfig";

export const RISK_CLASSIFICATIONS = ["ELIGIBLE", "CAUTION", "HIGH_RISK", "UNVERIFIED"] as const;
export type RiskClassification = (typeof RISK_CLASSIFICATIONS)[number];

/**
 * Stable codes, not prose. A client branches on these; the sentence shown to a human is the
 * client's business and can be translated.
 */
export type RiskReason =
  | "VALUATION_BELOW_FLOOR"
  | "LIQUIDITY_BELOW_FLOOR"
  | "LIQUIDITY_RATIO_BELOW_FLOOR"
  | "LIQUIDITY_RATIO_SEVERE"
  | "NO_LIQUIDITY"
  | "LOW_TRADE_COUNT"
  | "LOW_UNIQUE_TRADER_COUNT"
  | "STALE_MARKET_SNAPSHOT"
  | "STALE_LAST_TRADE"
  | "SNAPSHOT_UNAVAILABLE"
  | "VALUATION_UNKNOWN"
  | "LIQUIDITY_UNKNOWN"
  | "UNVERIFIED_ROUTE"
  | "TRADING_UNAVAILABLE";

/**
 * How a valuation was arrived at.
 *
 * §1 is explicit: do not silently call FDV market cap. Robinhood Chain gives us total supply
 * from the token contract, and nothing tells us how much of it is circulating — so what we
 * compute is FDV, and it says FDV.
 */
export type ValuationBasis = "FDV" | "MARKET_CAP";

export interface EligibilityInput {
  /** Null when the snapshot could not be read at all. */
  valuationUsd: number | null;
  valuationBasis: ValuationBasis;
  liquidityUsd: number | null;
  trades1h: number;
  traders1h: number;
  /** Age of the market snapshot backing the valuation and liquidity figures. */
  snapshotAgeMs: number | null;
  /** Age of this token's most recent canonical trade. */
  lastTradeAgeMs: number | null;
  /** False when the factory/pool provenance behind the route could not be confirmed. */
  routeVerified: boolean;
  /** True when the venue itself reports the token cannot currently be traded. */
  tradingUnavailable: boolean;
}

export interface EligibilityResult {
  classification: RiskClassification;
  reasons: RiskReason[];
  /** Liquidity as a fraction of valuation, in bps. Null when either side is unknown. */
  liquidityRatioBps: number | null;
}

export function liquidityRatioBps(liquidityUsd: number | null, valuationUsd: number | null): number | null {
  if (liquidityUsd === null || valuationUsd === null || valuationUsd <= 0) return null;
  return Math.round((liquidityUsd / valuationUsd) * 10_000);
}

/**
 * Classify one token.
 *
 * The order matters. Missing evidence is UNVERIFIED rather than HIGH_RISK, because "we could
 * not tell" and "we measured something bad" are different statements and collapsing them
 * would put honest tokens in the same bucket as broken ones. A severe measured problem then
 * outranks a merely thin one.
 */
export function classifyEligibility(input: EligibilityInput, config: TrendingConfig): EligibilityResult {
  const t = config.thresholds;
  const ratio = liquidityRatioBps(input.liquidityUsd, input.valuationUsd);
  const reasons: RiskReason[] = [];

  // --- unverifiable: not enough evidence to make any claim ---------------------------
  const unverified: RiskReason[] = [];
  if (input.valuationUsd === null) unverified.push("VALUATION_UNKNOWN");
  if (input.liquidityUsd === null) unverified.push("LIQUIDITY_UNKNOWN");
  if (input.snapshotAgeMs === null) unverified.push("SNAPSHOT_UNAVAILABLE");
  if (!input.routeVerified) unverified.push("UNVERIFIED_ROUTE");
  if (unverified.length > 0) return { classification: "UNVERIFIED", reasons: unverified, liquidityRatioBps: ratio };

  // --- severe, measured problems ------------------------------------------------------
  const severe: RiskReason[] = [];
  if (input.tradingUnavailable) severe.push("TRADING_UNAVAILABLE");
  if (input.liquidityUsd! <= 0) severe.push("NO_LIQUIDITY");
  // A token whose liquidity is a rounding error against its own valuation can be bought and
  // not sold. On this chain that describes the median traded token.
  else if (ratio !== null && ratio < t.cautionLiquidityRatioBps) severe.push("LIQUIDITY_RATIO_SEVERE");
  if (severe.length > 0) return { classification: "HIGH_RISK", reasons: severe, liquidityRatioBps: ratio };

  // --- the promotion bars -------------------------------------------------------------
  if (input.valuationUsd! < t.minValuationUsd) reasons.push("VALUATION_BELOW_FLOOR");
  if (input.liquidityUsd! < t.minLiquidityUsd) reasons.push("LIQUIDITY_BELOW_FLOOR");
  if (ratio !== null && ratio < t.minLiquidityRatioBps) reasons.push("LIQUIDITY_RATIO_BELOW_FLOOR");
  if (input.trades1h < t.minTrades1h) reasons.push("LOW_TRADE_COUNT");
  if (input.traders1h < t.minTraders1h) reasons.push("LOW_UNIQUE_TRADER_COUNT");
  if (input.snapshotAgeMs! > t.maxSnapshotAgeMs) reasons.push("STALE_MARKET_SNAPSHOT");
  if (input.lastTradeAgeMs === null || input.lastTradeAgeMs > t.maxLastTradeAgeMs) reasons.push("STALE_LAST_TRADE");

  if (reasons.length === 0) return { classification: "ELIGIBLE", reasons: [], liquidityRatioBps: ratio };
  return { classification: "CAUTION", reasons, liquidityRatioBps: ratio };
}
