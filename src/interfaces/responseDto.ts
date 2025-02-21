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
