import axios from 'axios';

interface SniperTransaction {
  transactionHash: string;
  transactionTimestamp: string;
  blocksAfterCreation: number;
}

interface SniperWallet {
  walletAddress: string;
  snipedTransactions: SniperTransaction[];
  sellTransactions: SniperTransaction[];
  totalSellTransactions: number;
  totalSnipedTransactions: number;
  totalTokensSniped: number;
  totalSnipedUsd: number;
  totalTokensSold: number;
  totalSoldUsd: number;
  currentBalance: number;
  currentBalanceUsdValue: number;
  realizedProfitPercentage: number;
  realizedProfitUsd: number;
}

interface SniperResponse {
  blockNumber: number;
  blockTimestamp: string;
  transactionHash: string;
  result: SniperWallet[];
}

export interface SniperAnalysis {
  totalSnipers: number;
  profitableSnipers: number;
  profitablePercentage: number;
  averageProfitPercentage: number;
  totalSnipedUsd: number;
  totalSoldUsd: number;
  totalProfitUsd: number;
  quickestSellBlocksAfter: number | null;
}

// Helper function to delay execution
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function fetchSniperData(tokenMint: string, blocksAfterCreation = 1000): Promise<SniperAnalysis | null> {
  try {
    console.log(`Fetching sniper data for ${tokenMint}...`);
    
    // Try up to 5 times with 1000ms delay between attempts
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        if (attempt > 0) {
          console.log(`Retrying sniper data fetch (attempt ${attempt + 1}/5)...`);
          await sleep(1000);
        }
        
        const response = await axios.get<SniperResponse>(
          `https://solana-gateway.moralis.io/token/mainnet/pairs/${tokenMint}/snipers?blocksAfterCreation=${blocksAfterCreation}`,
          {
            headers: {
              'accept': 'application/json',
              'X-API-Key': process.env.MORALIS_API_KEY || ''
            },
            timeout: 10000 // 10 seconds timeout
          }
        );
        
        const snipers = response.data.result || [];
        
        if (snipers.length === 0) {
          console.log(`No snipers found for ${tokenMint}`);
          return {
            totalSnipers: 0,
            profitableSnipers: 0,
            profitablePercentage: 0,
            averageProfitPercentage: 0,
            totalSnipedUsd: 0,
            totalSoldUsd: 0,
            totalProfitUsd: 0,
            quickestSellBlocksAfter: null
          };
        }
        
        // Analyze sniper data
        let profitableSnipers = 0;
        let totalProfitPercentage = 0;
        let totalSnipedUsd = 0;
        let totalSoldUsd = 0;
        let totalProfitUsd = 0;
        let quickestSellBlocksAfter: number | null = null;
        
        for (const sniper of snipers) {
          // Count profitable snipers
          if (sniper.realizedProfitPercentage > 0) {
            profitableSnipers++;
            totalProfitPercentage += sniper.realizedProfitPercentage;
          }
          
          // Sum up USD values
          totalSnipedUsd += sniper.totalSnipedUsd;
          totalSoldUsd += sniper.totalSoldUsd;
          totalProfitUsd += sniper.realizedProfitUsd;
          
          // Find quickest sell
          if (sniper.sellTransactions.length > 0) {
            const quickestSell = Math.min(...sniper.sellTransactions.map(tx => tx.blocksAfterCreation));
            if (quickestSellBlocksAfter === null || quickestSell < quickestSellBlocksAfter) {
              quickestSellBlocksAfter = quickestSell;
            }
          }
        }
        
        const analysis: SniperAnalysis = {
          totalSnipers: snipers.length,
          profitableSnipers,
          profitablePercentage: profitableSnipers > 0 ? (profitableSnipers / snipers.length) * 100 : 0,
          averageProfitPercentage: profitableSnipers > 0 ? totalProfitPercentage / profitableSnipers : 0,
          totalSnipedUsd,
          totalSoldUsd,
          totalProfitUsd,
          quickestSellBlocksAfter
        };
        
        console.log(`Sniper analysis for ${tokenMint}:`, analysis);
        return analysis;
        
      } catch (error) {
        if (attempt < 4) {
          console.error(`Error fetching sniper data (attempt ${attempt + 1}/5):`, error);
        } else {
          throw error; // Rethrow on last attempt
        }
      }
    }
    
    return null;
    
  } catch (error) {
    console.error('Error analyzing sniper data:', error);
    return null;
  }
} 