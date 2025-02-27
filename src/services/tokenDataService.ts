import axios from 'axios';
import { MoralisTokenMetadata, MoralisPairsResponse, TokenMarketData } from '../interfaces/responseDto';

// Cache to store token data
const tokenDataCache: Record<string, { data: TokenMarketData, timestamp: number }> = {};
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes in milliseconds

export async function getTokenMarketData(tokenMint: string): Promise<TokenMarketData | null> {
  try {
    // Check if we have cached data that's still valid
    const cachedData = tokenDataCache[tokenMint];
    const now = Date.now();
    
    if (cachedData && (now - cachedData.timestamp) < CACHE_TTL) {
      console.log(`Using cached data for token ${tokenMint}`);
      return cachedData.data;
    }
    
    // Fetch fresh data
    console.log(`Fetching fresh data for token ${tokenMint}`);
    const [metadataResponse, pairsResponse] = await Promise.all([
      axios.get<MoralisTokenMetadata>(
        `https://solana-gateway.moralis.io/token/mainnet/${tokenMint}/metadata`,
        {
          headers: {
            'accept': 'application/json',
            'X-API-Key': process.env.MORALIS_API_KEY
          }
        }
      ),
      axios.get<MoralisPairsResponse>(
        `https://solana-gateway.moralis.io/token/mainnet/${tokenMint}/pairs`,
        {
          headers: {
            'accept': 'application/json',
            'X-API-Key': process.env.MORALIS_API_KEY
          }
        }
      )
    ]);
    
    const metadata = metadataResponse.data;
    const pairs = pairsResponse.data;
    
    // Process the data
    const firstPair = pairs.pairs?.[0];
    const price = firstPair?.usdPrice || 0;
    const totalSupply = metadata?.totalSupplyFormatted ? parseFloat(metadata.totalSupplyFormatted) : 0;
    const marketCap = price * totalSupply;
    const volume24h = firstPair?.volume24hrUsd || 0;
    const liquidity = firstPair?.liquidityUsd || 0;
    const priceChangePercentage24h = firstPair?.usdPrice24hrPercentChange || 0;
    
    // Create the processed data object
    const tokenData: TokenMarketData = {
      metadata,
      pairs,
      price,
      totalSupply,
      marketCap,
      volume24h,
      liquidity,
      priceChangePercentage24h
    };
    
    // Cache the data
    tokenDataCache[tokenMint] = {
      data: tokenData,
      timestamp: now
    };
    
    return tokenData;
  } catch (error) {
    console.error('Error fetching token market data:', error);
    return null;
  }
}

// Helper functions to format data for display
export function formatPrice(price: number): string {
  if (price >= 1) {
    return `$${price.toFixed(2)}`;
  } else if (price >= 0.01) {
    return `$${price.toFixed(4)}`;
  } else if (price >= 0.0001) {
    return `$${price.toFixed(6)}`;
  } else {
    return `$${price.toExponential(2)}`;
  }
}

export function formatMarketCap(marketCap: number): string {
  return `$${marketCap.toLocaleString()}`;
}

export function formatVolume(volume: number): string {
  return `$${volume.toLocaleString()}`;
}

export function formatLiquidity(liquidity: number): string {
  return `$${liquidity.toLocaleString()}`;
} 
