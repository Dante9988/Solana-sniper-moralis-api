/**
 * Phase 7E.4.4 — the Solana quote assets OnlyPump names, from their canonical addresses only (never
 * from a token's own metadata, same rule as Robinhood's registry in chainlinkQuoteUsdRateProvider).
 *
 * Pump.fun's CreateEvent/TradeEvent name native SOL as the System Program id
 * 11111111111111111111111111111111 (observed on every mainnet fixture, e.g.
 * pump_create_and_dev_buy_with_completion.json), and PumpSwap pools hold wrapped SOL
 * So11111111111111111111111111111111111111112 (pumpswap_buy.json's pool vault). Both are 9 decimals.
 * No USD feed is attached: there is no trusted SOL/USD source configured.
 */

export interface SolanaQuoteAsset {
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly kind: "native" | "wrapped-native";
}

export const SOLANA_NATIVE_QUOTE = "11111111111111111111111111111111";
export const SOLANA_WRAPPED_SOL = "So11111111111111111111111111111111111111112";

const ASSETS: Record<string, SolanaQuoteAsset> = {
  [SOLANA_NATIVE_QUOTE]: { symbol: "SOL", name: "Solana", decimals: 9, kind: "native" },
  [SOLANA_WRAPPED_SOL]: { symbol: "SOL", name: "Wrapped SOL", decimals: 9, kind: "wrapped-native" },
};

export function solanaQuoteAsset(address: string): SolanaQuoteAsset | null {
  return ASSETS[address] ?? null;
}

/** Addresses whose amounts are SOL at 9 decimals, so they can be ordered against each other. */
export const SOL_QUOTE_ADDRESSES: readonly string[] = Object.keys(ASSETS);
