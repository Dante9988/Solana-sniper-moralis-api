import axios from 'axios';
import { MoralisTokenMetadata, TokenMarketData, MoralisTokenPrice, MoralisSwapsResponse } from '../interfaces/responseDto';
import { fetchBirdeyeWithRetry } from '../utils/apiUtils';

// Cache to store token data
const tokenDataCache: Record<string, { data: TokenMarketData, timestamp: number }> = {};
const CACHE_TTL = 15 * 1000; // 15 seconds cache for fresh data

// Add timeout to axios requests
const AXIOS_TIMEOUT = 10000; // 10 seconds timeout

// Pump.fun tokens always have 1 billion total supply
const PUMPFUN_TOTAL_SUPPLY = 1_000_000_000;

// Retry configuration
const MAX_RETRIES = 5;
const RETRY_DELAY = 2000; // 2 seconds delay

// Helper function to delay execution
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Helper function to fetch price with retry
async function fetchPriceWithRetry(tokenMint: string, options: any, retryCount = MAX_RETRIES): Promise<MoralisTokenPrice | null> {
  let attempts = 0;
  
  while (attempts < retryCount) {
    try {
      if (attempts > 0) {
        console.log(`Retrying price fetch for ${tokenMint} (attempt ${attempts + 1}/${retryCount})...`);
        await sleep(RETRY_DELAY);
      }
      
      const response = await axios.get<MoralisTokenPrice>(
        `https://solana-gateway.moralis.io/token/mainnet/${tokenMint}/price`,
        options
      );
      
      // Check if we got valid price data
      if (response.data && response.data.usdPrice && response.data.usdPrice > 0) {
        console.log(`Successfully fetched price data for ${tokenMint}: $${response.data.usdPrice}`);
        return response.data;
      } else {
        console.warn(`Received invalid price data for ${tokenMint}: ${JSON.stringify(response.data)}`);
        // Treat this as an error and retry
        throw new Error('Invalid price data received');
      }
    } catch (error) {
      console.error(`Error fetching price for ${tokenMint} (attempt ${attempts + 1}/${retryCount}):`, error);
      attempts++;
      
      if (attempts >= retryCount) {
        console.error(`All ${retryCount} price fetch attempts failed for ${tokenMint}`);
        return null;
      }
    }
  }
  
  return null;
}

// Regular fetch with retry for metadata
async function fetchWithRetry<T>(url: string, options: any, retryCount = MAX_RETRIES): Promise<T | null> {
  let attempts = 0;
  
  while (attempts < retryCount) {
    try {
      if (attempts > 0) {
        console.log(`Retrying fetch for ${url} (attempt ${attempts + 1}/${retryCount})...`);
        await sleep(RETRY_DELAY);
      }
      
      const response = await axios.get<T>(url, options);
      return response.data;
    } catch (error) {
      console.error(`Error fetching ${url} (attempt ${attempts + 1}/${retryCount}):`, error);
      attempts++;
      
      if (attempts >= retryCount) {
        console.error(`All ${retryCount} fetch attempts failed for ${url}`);
        return null;
      }
    }
  }
  
  return null;
}

// Fallback function to get price from swaps
async function getPriceFromSwaps(tokenMint: string, options: any): Promise<number> {
  try {
    console.log(`Attempting to get price from swaps for ${tokenMint}...`);
    const swapsResponse = await axios.get<MoralisSwapsResponse>(
      `https://solana-gateway.moralis.io/token/mainnet/${tokenMint}/swaps?order=DESC&limit=10`,
      options
    );
    
    const swaps = swapsResponse.data.result || [];
    
    if (swaps.length === 0) {
      console.log(`No swaps found for ${tokenMint}`);
      return 0;
    }
    
    // Find the most recent swap with valid price data
    for (const swap of swaps) {
      // Check if the token is bought or sold in the swap
      if (swap.bought && swap.bought.address.toLowerCase() === tokenMint.toLowerCase() && swap.bought.usdPrice > 0) {
        console.log(`Found price from swaps (bought): $${swap.bought.usdPrice}`);
        return swap.bought.usdPrice;
      } else if (swap.sold && swap.sold.address.toLowerCase() === tokenMint.toLowerCase() && swap.sold.usdPrice > 0) {
        console.log(`Found price from swaps (sold): $${swap.sold.usdPrice}`);
        return swap.sold.usdPrice;
      }
    }
    
    console.log(`No valid price found in swaps for ${tokenMint}`);
    return 0;
  } catch (error) {
    console.error(`Error getting price from swaps for ${tokenMint}:`, error);
    return 0;
  }
}

export async function getTokenMarketData(tokenMint: string): Promise<TokenMarketData | null> {
  try {
    // Check if we have cached data that's still valid
    const cachedData = tokenDataCache[tokenMint];
    const now = Date.now();
    
    if (cachedData && (now - cachedData.timestamp) < CACHE_TTL) {
      console.log(`Using cached data for token ${tokenMint}`);
      return cachedData.data;
    }
    
    // Fetch fresh data with retries
    console.log(`Fetching fresh data for token ${tokenMint}`);
    
    const requestOptions = {
      headers: {
        'accept': 'application/json',
        'X-API-Key': process.env.MORALIS_API_KEY || ''
      },
      timeout: AXIOS_TIMEOUT
    };
    
    // Fetch both price and metadata in parallel, with retries for each
    const [priceResult, metadataResult] = await Promise.allSettled([
      fetchPriceWithRetry(tokenMint, requestOptions, MAX_RETRIES),
      fetchWithRetry<MoralisTokenMetadata>(
        `https://solana-gateway.moralis.io/token/mainnet/${tokenMint}/metadata`,
        requestOptions,
        MAX_RETRIES
      )
    ]);
    
    // Extract data safely
    let priceData = priceResult.status === 'fulfilled' ? priceResult.value : null;
    const metadata = metadataResult.status === 'fulfilled' ? metadataResult.value : null;
    
    // Log any errors
    if (priceResult.status === 'rejected') {
      console.error('Error fetching token price:', priceResult.reason);
    }
    
    if (metadataResult.status === 'rejected') {
      console.error('Error fetching token metadata:', metadataResult.reason);
    }
    
    // Get price from price endpoint
    let price = priceData?.usdPrice || 0;
    let priceChangePercentage24h = priceData?.usdPrice24hrPercentChange || 0;
    
    // If price is still 0, try to get it from swaps as a fallback
    if (price === 0) {
      console.log(`Price is 0 for ${tokenMint}, trying to get it from swaps...`);
      price = await getPriceFromSwaps(tokenMint, requestOptions);
      
      if (price > 0) {
        console.log(`Successfully got price from swaps for ${tokenMint}: $${price}`);
      } else {
        console.warn(`Failed to get price from swaps for ${tokenMint}`);
      }
    }
    
    // For Pump.fun tokens, use fixed 1 billion supply
    const isPumpToken = tokenMint.toLowerCase().endsWith('pump');
    const totalSupply = isPumpToken ? PUMPFUN_TOTAL_SUPPLY : 
                       (metadata?.totalSupplyFormatted ? parseFloat(metadata.totalSupplyFormatted) : 0);
    
    // Calculate market cap
    const marketCap = price * totalSupply;
    
    // Estimate volume and liquidity (rough estimates)
    // Use a percentage of market cap as a fallback if we don't have actual data
    const volume24h = price > 0 ? (price * totalSupply * 0.05) : 0; // Rough estimate: 5% of market cap
    const liquidity = price > 0 ? (price * totalSupply * 0.02) : 0; // Rough estimate: 2% of market cap
    
    // Log calculated values for debugging
    console.log(`Token ${tokenMint} calculated values:
    - Price: ${price}
    - Total Supply: ${totalSupply}
    - Market Cap: ${marketCap}
    - Volume 24h: ${volume24h}
    - Liquidity: ${liquidity}
    - Price Change 24h: ${priceChangePercentage24h}%`);
    
    // Create the processed data object
    const tokenData: TokenMarketData = {
      metadata: {
        mint: tokenMint,
        standard: metadata?.standard || '',
        name: metadata?.name || priceData?.name || 'Unknown',
        symbol: metadata?.symbol || priceData?.symbol || 'Unknown',
        logo: metadata?.logo || priceData?.logo || '',
        decimals: metadata?.decimals || '0',
        metaplex: metadata?.metaplex || {
          metadataUri: '',
          masterEdition: false,
          isMutable: false,
          sellerFeeBasisPoints: 0,
          updateAuthority: '',
          primarySaleHappened: 0
        },
        fullyDilutedValue: metadata?.fullyDilutedValue || '0',
        totalSupply: metadata?.totalSupply || totalSupply.toString(),
        totalSupplyFormatted: metadata?.totalSupplyFormatted || totalSupply.toString(),
        links: metadata?.links || null,
        description: metadata?.description || null
      },
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
    
    // Even if we have an error, try to return partial data if we have it
    try {
      // For Pump.fun tokens, use fixed 1 billion supply
      const isPumpToken = tokenMint.toLowerCase().endsWith('pump');
      const totalSupply = isPumpToken ? PUMPFUN_TOTAL_SUPPLY : 0;
      
      return {
        metadata: {
          mint: tokenMint,
          standard: '',
          name: 'Unknown',
          symbol: 'Unknown',
          logo: '',
          decimals: '0',
          metaplex: {
            metadataUri: '',
            masterEdition: false,
            isMutable: false,
            sellerFeeBasisPoints: 0,
            updateAuthority: '',
            primarySaleHappened: 0
          },
          fullyDilutedValue: '0',
          totalSupply: totalSupply.toString(),
          totalSupplyFormatted: totalSupply.toString(),
          links: null,
          description: null
        },
        price: 0,
        totalSupply,
        marketCap: 0,
        volume24h: 0,
        liquidity: 0,
        priceChangePercentage24h: 0
      };
    } catch (fallbackError) {
      console.error('Error creating fallback token data:', fallbackError);
      return null;
    }
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
  if (marketCap >= 1_000_000) {
    return `$${(marketCap / 1_000_000).toFixed(2)}M`;
  } else if (marketCap >= 1_000) {
    return `$${(marketCap / 1_000).toFixed(2)}K`;
  } else {
    return `$${marketCap.toFixed(2)}`;
  }
}

export function formatVolume(volume: number): string {
  if (volume >= 1_000_000) {
    return `$${(volume / 1_000_000).toFixed(2)}M`;
  } else if (volume >= 1_000) {
    return `$${(volume / 1_000).toFixed(2)}K`;
  } else {
    return `$${volume.toFixed(2)}`;
  }
}

export function formatLiquidity(liquidity: number): string {
  if (liquidity >= 1_000_000) {
    return `$${(liquidity / 1_000_000).toFixed(2)}M`;
  } else if (liquidity >= 1_000) {
    return `$${(liquidity / 1_000).toFixed(2)}K`;
  } else {
    return `$${liquidity.toFixed(2)}`;
  }
}

// Helper function to format currency values with commas and no suffixes
function formatCurrency(value: number): string {
  if (isNaN(value) || value === null) return '$0.00';
  return `$${value.toLocaleString('en-US', {maximumFractionDigits: 2})}`;
}

// Update the function that fetches token price history
export async function getTokenPriceHistory(tokenMint: string): Promise<any> {
  try {
    console.log(`Fetching price history for ${tokenMint}...`);
    
    const response = await fetchBirdeyeWithRetry<any>(
      `defi/price_history?address=${tokenMint}&type=1H&limit=168`
    );
    
    return response.data || { items: [] };
  } catch (error) {
    console.error('Error fetching token price history:', error);
    return { items: [] };
  }
}

// Update the function that fetches token volume and liquidity
export async function getTokenVolumeAndLiquidity(tokenMint: string): Promise<any> {
  try {
    console.log(`Fetching volume and liquidity for ${tokenMint}...`);
    
    const response = await fetchBirdeyeWithRetry<any>(
      `defi/token_info?address=${tokenMint}`
    );
    
    if (response.data && response.success) {
      return {
        volume24h: formatCurrency(response.data.volume24h || 0),
        liquidity: formatCurrency(response.data.liquidity || 0)
      };
    }
    
    return { volume24h: '0', liquidity: '0' };
  } catch (error) {
    console.error('Error fetching token volume and liquidity:', error);
    return { volume24h: '0', liquidity: '0' };
  }
}

// Update the function that fetches latest price
export async function fetchLatestPrice(tokenMint: string): Promise<number> {
  try {
    console.log(`Fetching latest price for ${tokenMint}...`);
    
    const response = await fetchBirdeyeWithRetry<any>(
      `defi/token_price?address=${tokenMint}`
    );
    
    if (response.data && response.success) {
      return response.data.value || 0;
    }
    
    return 0;
  } catch (error) {
    console.error('Error fetching latest price:', error);
    return 0;
  }
} 
