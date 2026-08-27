export type SupportedChain = "SOLANA" | "ETHEREUM" | "BNB_SMART_CHAIN";

export interface AssetIdentity {
  id?: string;
  chain: SupportedChain;
  chainId: string;
  /** Supplied/display address. This is not the database identity key. */
  address: string;
  normalizedAddress: string;
  symbol?: string;
  name?: string;
}

export interface AssetResolutionInput {
  address: string;
  /** `string` permits explicit UNSUPPORTED_CHAIN results at runtime boundaries. */
  chain?: SupportedChain | string;
  symbol?: string;
  name?: string;
}

export type AssetResolutionResult =
  | { status: "RESOLVED"; asset: AssetIdentity }
  | { status: "AMBIGUOUS_CHAIN"; inputAddress: string; candidateChains: SupportedChain[] }
  | { status: "INVALID_ADDRESS"; reason: string }
  | { status: "UNSUPPORTED_CHAIN"; reason: string };

export type AssetObservationType =
  | "POSITION"
  | "DISCOVERY"
  | "TRENDING"
  | "SIGNAL"
  | "RESEARCH"
  | "MARKET";

/** POSITION is deliberately excluded from the Phase 4 research store. */
export type ResearchAssetObservationType = Exclude<AssetObservationType, "POSITION">;

export interface ResearchAssetObservation {
  type: ResearchAssetObservationType;
  observationKey: string;
  observedAt: Date;
  source: string;
  provider?: string;
  priceUsd?: number;
  estimatedBuyPriceUsd?: number;
  estimatedSellPriceUsd?: number;
  liquidityUsd?: number;
  marketCapUsd?: number;
  fdvUsd?: number;
  volume24hUsd?: number;
  rawPayload?: unknown;
}

export interface MarketObservation extends ResearchAssetObservation {
  type: "MARKET";
  asset: AssetIdentity;
}
