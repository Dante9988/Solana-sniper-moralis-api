export interface SolsnifferResponse {
    tokenData: {
        indicatorData: {
            high: {
                count: number;
                details: string;
            };
            moderate: {
                count: number;
                details: string;
            };
            low: {
                count: number;
                details: string;
            };
            specific: {
                count: number;
                details: string;
            };
        };
        tokenOverview: {
            deployer: string;
            mint: string;
            address: string;
            type: string;
        };
        address: string;
        deployTime: string;
        externals: string;
        liquidityList: Array<{
            raydium?: {
                address: string;
                amount: number;
                lpPair: string;
            };
        }>;
        marketCap: number;
        ownersList: TokenHolder[];
        score: number;
        tokenImg: string;
        tokenName: string;
        tokenSymbol: string;
        auditRisk: {
            mintDisabled: boolean;
            freezeDisabled: boolean;
            lpBurned: boolean;
            top10Holders: boolean;
        };
    };
    tokenInfo: {
        price: string;
        supplyAmount: number;
        mktCap: number;
    };
}

export interface TokenHolder {
    address: string;
    amount: string;
    percentage: string;
}

export interface TokenSafetyCheck {
  isRugSafe: boolean;
  tokenName: string;
  tokenSymbol: string;
  deployer: string;
  price: string;
  marketCap: number;
  ownersList: TokenHolder[];
  auditRisk: {
      mintDisabled: boolean;
      freezeDisabled: boolean;
      lpBurned: boolean;
      top10Holders: boolean;
  };
}

export interface TrenchBundleData {
    ticker?: string;
    bonded?: boolean;
    totalBundles?: number;
    holdingBundles?: number;
    totalSolSpent?: number;
    holdingPercentage?: number;
}

export interface AlertMetrics {
    start: number;
    safetyChecks: number;
    discordSend: number;
    total: number;
}

export interface HolderAnalysis {
    topHolderPercentage: number;
    top10HoldersPercentage: number;
    isDistributionHealthy: boolean;
}

export interface MoralisTokenMetadata {
  mint: string;
  standard: string;
  name: string;
  symbol: string;
  logo: string;
  decimals: string;
  metaplex: {
    metadataUri: string;
    masterEdition: boolean;
    isMutable: boolean;
    sellerFeeBasisPoints: number;
    updateAuthority: string;
    primarySaleHappened: number;
  };
  fullyDilutedValue: string;
  totalSupply: string;
  totalSupplyFormatted: string;
  links: any | null;
  description: string | null;
}

export interface MoralisPairToken {
  tokenAddress: string;
  tokenName: string;
  tokenSymbol: string;
  tokenLogo: string | null;
  tokenDecimals: string;
  pairTokenType: string;
  liquidityUsd: number;
}

export interface MoralisPair {
  exchangeAddress: string;
  exchangeName: string;
  exchangeLogo: string;
  pairAddress: string;
  pairLabel: string;
  usdPrice: number;
  usdPrice24hrPercentChange: number;
  usdPrice24hrUsdChange: number;
  volume24hrNative: number;
  volume24hrUsd: number;
  liquidityUsd: number;
  baseToken: string;
  quoteToken: string;
  inactivePair: boolean;
  pair: MoralisPairToken[];
}

export interface MoralisPairsResponse {
  pairs: MoralisPair[];
}

export interface TokenMarketData {
  metadata: MoralisTokenMetadata;
  pairs: MoralisPairsResponse;
  price: number;
  totalSupply: number;
  marketCap: number;
  volume24h: number;
  liquidity: number;
  priceChangePercentage24h: number;
}
