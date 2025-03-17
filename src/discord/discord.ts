import { Client, TextChannel, Message, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import dotenv from 'dotenv';
import axios from 'axios';
import { PublicKey, Connection } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import { CallStatsAnalyzer } from '../callStats';
import { PUMP_FUN_PROGRAM } from '../constants';
import { analyzeTokenWithGrok, TokenAnalysisData, updateDiscordWithGrokAnalysis } from '../grok';
import { getRugCheckConfirmed } from '../transactions';
import { getTokenMarketData, formatPrice, formatMarketCap, formatVolume, formatLiquidity } from '../services/tokenDataService';
import { fetchSniperData } from '../services/sniperDataService';
import { storeTokenAlert } from '../services/tokenTrackingService';

dotenv.config();

// Create connection instance
const connection = new Connection(process.env.HELIUS_HTTPS_URI || 'https://api.mainnet-beta.solana.com');

export const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

let channel: TextChannel | null = null;

client.once('ready', () => {
    console.log('🤖 Discord bot is ready!');
    const channelId = process.env.DISCORD_CHANNEL_ID;
    console.log('Channel ID from env:', channelId);
    
    if (channelId) {
        try {
            channel = client.channels.cache.get(channelId.replace(/"/g, '')) as TextChannel;
            if (channel) {
                console.log('✅ Successfully connected to channel:', channel.name);
            } else {
                console.log('❌ Could not find channel with ID:', channelId);
                console.log('Available channels:', Array.from(client.channels.cache.values()).map(c => ({
                    id: c.id,
                    name: 'name' in c ? c.name : 'unknown'
                })));
            }
        } catch (error) {
            console.error('Error getting channel:', error);
        }
    } else {
        console.log('❌ No channel ID found in .env file');
    }
});

export interface TokenData {
    price?: string;
    marketCap?: string;
}

export interface VolumeLiquidityData {
    volume1h?: string;
    volume24h?: string;
    liquidity?: string;
}

// function formatPrice(price: string | number | undefined): string {
//     if (!price) return 'Unknown';
    
//     const numPrice = Number(price);
    
//     // Convert to full decimal format
//     if (numPrice < 1) {
//         // Convert to string to avoid scientific notation
//         const priceString = numPrice.toFixed(20);
//         // Remove trailing zeros after decimal
//         const trimmedPrice = priceString.replace(/\.?0+$/, '');
//         return `$${trimmedPrice}`;
//     }
    
//     // For numbers >= 1, use regular formatting
//     return `$${numPrice.toLocaleString(undefined, {
//         minimumFractionDigits: 2,
//         maximumFractionDigits: 8
//     })}`;
// }

export async function getTokenPriceHistory(tokenMint: string): Promise<{
    items: Array<{
        unixTime: number;
        value: number;
    }>;
    success: boolean;
}> {
    try {
        // Get current timestamp
        const currentTime = Math.floor(Date.now() / 1000);
        // Start from 24 hours ago by default
        const startTime = currentTime - (24 * 60 * 60);

        const response = await axios.get(
            `https://public-api.birdeye.so/defi/history_price`, {
                params: {
                    address: tokenMint,
                    address_type: 'token',
                    type: '15m',
                    time_from: startTime,
                    time_to: currentTime
                },
                headers: {
                    'X-API-KEY': process.env.BIRDEYE_API_KEY,
                    'x-chain': 'solana',
                    'accept': 'application/json'
                }
            }
        );

        if (!response.data.success) {
            throw new Error('Failed to fetch price history');
        }

        return {
            items: response.data.data.items,
            success: true
        };
    } catch (error) {
        console.error('Error fetching price history:', error);
        return {
            items: [],
            success: false
        };
    }
}

async function fetchTokenData(tokenMint: string): Promise<TokenData> {
    const metrics = {
      start: performance.now(),
      total: 0
    };
  
    try {
      const tokenData = await getTokenMarketData(tokenMint);
      
      metrics.total = performance.now() - metrics.start;
      
      if (!tokenData) {
        console.log(`⚠️ Failed to fetch token data (${metrics.total.toFixed(2)}ms)`);
        return {};
      }
      
      console.log(`\n📊 Token Data Fetch:
  • Total Time: ${metrics.total.toFixed(2)}ms
  • Price: ${formatPrice(tokenData.price)}
  • Total Supply: ${tokenData.totalSupply}
  • Market Cap: ${formatMarketCap(tokenData.marketCap)}`);
  
      // Only return data if we have valid values
      if (tokenData.marketCap > 0) {
        return {
          price: formatPrice(tokenData.price),
          marketCap: formatMarketCap(tokenData.marketCap)
        };
      }
  
      return {};
    } catch (error) {
      metrics.total = performance.now() - metrics.start;
      console.error(`❌ Error fetching token data (${metrics.total.toFixed(2)}ms):`, error);
      return {};
    }
  }

  async function getTokenVolumeAndLiquidity(tokenMint: string): Promise<VolumeLiquidityData> {
    try {
      const tokenData = await getTokenMarketData(tokenMint);
      
      if (!tokenData) {
        return {};
      }
      
      return {
        volume24h: formatVolume(tokenData.volume24h),
        liquidity: formatLiquidity(tokenData.liquidity),
      };
    } catch (error) {
      console.error('Error getting token volume and liquidity:', error);
      return {};
    }
  }

interface TrenchBundleData {
    ticker?: string;
    bonded?: boolean;
    totalBundles?: number;
    holdingBundles?: number;
    totalSolSpent?: number;
    holdingPercentage?: number;
}

async function fetchTrenchData(tokenMint: string): Promise<TrenchBundleData> {
    try {
        const response = await axios.get(
            `https://trench.bot/api/bundle/bundle_advanced/${tokenMint}`
        );

        // Count holding bundles (bundles with holding_amount > 0)
        const holdingBundles = Object.values(response.data.bundles).filter(
            (bundle: any) => bundle.holding_amount > 0
        ).length;

        return {
            ticker: response.data.ticker,
            bonded: response.data.bonded,
            totalBundles: response.data.total_bundles,
            holdingBundles: holdingBundles,
            totalSolSpent: response.data.total_sol_spent,
            holdingPercentage: response.data.total_holding_percentage
        };
    } catch (error) {
        console.error('Error fetching Trench data:', error);
        return {};
    }
}

async function calculateMarketCap(tokenMint: string): Promise<number> {
    try {
      const tokenData = await getTokenMarketData(tokenMint);
      return tokenData?.marketCap || 0;
    } catch (error) {
      console.error('Error calculating market cap:', error);
      return 0;
    }
  }

function getEasternTime(): string {
    const options: Intl.DateTimeFormatOptions = {
        timeZone: 'America/New_York',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
    };

    return new Date().toLocaleString('en-US', options);
}

// Add function to check bonding curve status
async function checkBondingCurveStatus(tokenMint: string): Promise<boolean> {
    try {
        // Get bonding curve PDA
        const [bondingCurvePDA] = PublicKey.findProgramAddressSync(
            [
                Buffer.from("bonding-curve"),
                new PublicKey(tokenMint).toBuffer()
            ],
            new PublicKey(PUMP_FUN_PROGRAM)
        );

        // Fetch raw account data
        const accountInfo = await connection.getAccountInfo(bondingCurvePDA);
        if (!accountInfo) {
            return false;
        }

        // Check complete status (byte at offset 48)
        return accountInfo.data.readUInt8(48) === 1;
    } catch (error) {
        console.error('Error checking bonding curve status:', error);
        return false;
    }
}

// Helper function to delay execution
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Helper function to fetch latest price with retry
async function fetchLatestPrice(tokenMint: string, retryCount = 3): Promise<number> {
  const RETRY_DELAY = 1000; // 1 second delay
  let attempts = 0;
  
  while (attempts < retryCount) {
    try {
      if (attempts > 0) {
        console.log(`Retrying latest price fetch for ${tokenMint} (attempt ${attempts + 1}/${retryCount})...`);
        await sleep(RETRY_DELAY);
      }
      
      const response = await axios.get(
        `https://solana-gateway.moralis.io/token/mainnet/${tokenMint}/price`,
        {
          headers: {
            'accept': 'application/json',
            'X-API-Key': process.env.MORALIS_API_KEY || ''
          },
          timeout: 10000 // 10 seconds timeout
        }
      );
      
      // Check if we got valid price data
      if (response.data && response.data.usdPrice && response.data.usdPrice > 0) {
        console.log(`Successfully fetched latest price data for ${tokenMint}: $${response.data.usdPrice}`);
        return response.data.usdPrice;
      } else {
        console.warn(`Received invalid latest price data for ${tokenMint}: ${JSON.stringify(response.data)}`);
        // Treat this as an error and retry
        throw new Error('Invalid latest price data received');
      }
    } catch (error) {
      console.error(`Error fetching latest price for ${tokenMint} (attempt ${attempts + 1}/${retryCount}):`, error);
      attempts++;
      
      if (attempts >= retryCount) {
        console.error(`All ${retryCount} latest price fetch attempts failed for ${tokenMint}`);
        return 0;
      }
    }
  }
  
  return 0;
}

export async function sendTokenAlert(tokenMint: string, rugCheckPassed: boolean) {
    const metrics = {
        start: performance.now(),
        total: 0
    };

    if (!channel) {
        console.log('❌ Cannot send message - channel not found');
        return;
    }

    // Check if this is a Pump.fun token
    const isPumpToken = tokenMint.toLowerCase().endsWith('pump');
    console.log(`Token ${tokenMint} is ${isPumpToken ? 'a Pump.fun token' : 'not a Pump.fun token'}`);
    
    // Skip non-Pump.fun tokens
    if (!isPumpToken) {
        console.log(`⏭️ Skipping alert for non-Pump.fun token: ${tokenMint}`);
        return;
    }

    try {
        // Fetch all necessary data in parallel, but handle failures independently
        const [tokenDataResult, trenchResult, sniperDataResult] = await Promise.allSettled([
            getTokenMarketData(tokenMint),
            fetchTrenchData(tokenMint),
            fetchSniperData(tokenMint)
        ]);
        
        // Safely extract data from results
        const tokenData = tokenDataResult.status === 'fulfilled' ? tokenDataResult.value : null;
        const trenchData = trenchResult.status === 'fulfilled' ? trenchResult.value : {
            holdingBundles: 0,
            totalBundles: 0,
            holdingPercentage: 0,
            totalSolSpent: null,
            ticker: null
        };
        const sniperData = sniperDataResult.status === 'fulfilled' ? sniperDataResult.value : null;
        
        // Get the latest price right before sending the alert
        console.log(`Fetching latest price for ${tokenMint} before sending alert...`);
        const price = await fetchLatestPrice(tokenMint);
        
        // Calculate market cap with the latest price
        const PUMPFUN_TOTAL_SUPPLY = 1_000_000_000; // 1 billion tokens
        const marketCap = price * PUMPFUN_TOTAL_SUPPLY;
        
        console.log(`Latest data for ${tokenMint}:
        - Price: ${price}
        - Market Cap: ${marketCap}`);
        
        // Get token name and ticker from Moralis data if available
        const tokenName = tokenData?.metadata?.name || trenchData.ticker?.toUpperCase() || 'UNKNOWN';
        const tokenSymbol = tokenData?.metadata?.symbol || trenchData.ticker?.toUpperCase() || 'UNKNOWN';
        const tokenLogo = tokenData?.metadata?.logo || null;
        const moralisLink = tokenData?.metadata?.links?.moralis || null;
        
        // Create first row of buttons
        const firstRowButtons = [
            new ButtonBuilder()
                .setLabel('🌊 Pump')
                .setStyle(ButtonStyle.Link)
                .setURL(`https://pump.fun/${tokenMint}`),
            new ButtonBuilder()
                .setLabel('👽 GMGN')
                .setStyle(ButtonStyle.Link)
                .setURL(`https://gmgn.ai/sol/token/${tokenMint}`),
            new ButtonBuilder()
                .setLabel('🐂 BullX')
                .setStyle(ButtonStyle.Link)
                .setURL(`https://neo.bullx.io/terminal?chainId=1399811149&address=${tokenMint}`),
            new ButtonBuilder()
                .setLabel('⭐ Photon')
                .setStyle(ButtonStyle.Link)
                .setURL(`https://photon-sol.tinyastro.io/en/r/@Strobe/${tokenMint}`),
            new ButtonBuilder()
                .setLabel('🌌 Axiom')
                .setStyle(ButtonStyle.Link)
                .setURL(`https://axiom.trade/t/${tokenMint}`)
        ];
        
        // Create second row of buttons
        const secondRowButtons = [
            new ButtonBuilder()
                .setLabel('🔄 Raydium')
                .setStyle(ButtonStyle.Link)
                .setURL(`https://raydium.io/swap/?inputCurrency=sol&outputCurrency=${tokenMint}`),
            new ButtonBuilder()
                .setLabel('🦅 Birdeye') 
                .setStyle(ButtonStyle.Link)
                .setURL(`https://birdeye.so/token/${tokenMint}?chain=solana`),
            new ButtonBuilder()
                .setLabel('📊 DexScreener')
                .setStyle(ButtonStyle.Link)
                .setURL(`https://dexscreener.com/solana/${tokenMint}`)
        ];
        
        // Add Moralis link if available
        if (moralisLink) {
            secondRowButtons.push(
                new ButtonBuilder()
                    .setLabel('Moralis')
                    .setStyle(ButtonStyle.Link)
                    .setURL(moralisLink)
                    .setEmoji('🔍')
            );
        }
        
        const detectedTime = getEasternTime();
        
        // Prepare sniper data section if available
        let sniperSection = '';
        if (sniperData && sniperData.totalSnipers > 0) {
            sniperSection = `
**🤖 Sniper Analysis**
━━━━━━━━━━━━━━━━━━━━━━
🎯 **Total Snipers:** ${sniperData.totalSnipers}
💰 **Profitable:** ${sniperData.profitableSnipers} (${sniperData.profitablePercentage.toFixed(1)}%)
📈 **Avg Profit:** ${sniperData.averageProfitPercentage.toFixed(1)}%
💵 **Total Sniped:** ${formatNumber(sniperData.totalSnipedUsd || 0)}
💸 **Total Sold:** ${formatNumber(sniperData.totalSoldUsd || 0)}
💎 **Total Profit:** ${formatNumber(sniperData.totalProfitUsd || 0)}
⏱️ **Quickest Sell:** ${sniperData.quickestSellBlocksAfter ? `${sniperData.quickestSellBlocksAfter} blocks` : 'N/A'}
`;
        }
        
        // Create complete message with all available data
        const message = {
            embeds: [{
                color: 0x2ecc71,
                title: `🚀 New Token Launch Detected: ${tokenSymbol}`,
                description: `
\`\`\`
Token: ${tokenMint}
\`\`\`

**💹 Market Analysis**
━━━━━━━━━━━━━━━━━━━━━━
💰 **Market Cap:** ${marketCap > 0 ? formatMarketCap(marketCap) : 'Unknown'}
💧 **Liquidity:** ${tokenData?.liquidity ? formatLiquidity(tokenData.liquidity) : 'Unknown'}
📊 **24H Volume:** ${tokenData?.volume24h ? formatVolume(tokenData.volume24h) : 'Unknown'}

**🎯 Quick Stats**
━━━━━━━━━━━━━━━━━━━━━━
📦 **Bundles:** ${trenchData.holdingBundles || '0'}/${trenchData.totalBundles || '0'}
📦 **Percentage:** ${trenchData.holdingPercentage || '0'}%
💵 **SOL Spent:** ${trenchData.totalSolSpent ? `◎${trenchData.totalSolSpent}` : 'Unknown'}
🛡️ **Security:** ${rugCheckPassed ? '✅ PASSED' : '⚠️ CAUTION'}
${sniperSection}
> 💡 *DYOR - Trade at your own risk*`,
                footer: {
                    text: `🕒 Detected at ${detectedTime} EST`,
                    icon_url: 'https://pump.fun/favicon.ico'
                },
                // Add thumbnail if token logo exists
                ...(tokenLogo ? { thumbnail: { url: tokenLogo } } : {})
            }],
            components: [
                new ActionRowBuilder<ButtonBuilder>().addComponents(...firstRowButtons),
                new ActionRowBuilder<ButtonBuilder>().addComponents(...secondRowButtons)
            ]
        };

        // After fetching token data and before sending Discord message
        if (isPumpToken && tokenData) {
            await storeTokenAlert({
                tokenAddress: tokenMint,
                tokenSymbol: tokenData?.metadata?.symbol || undefined,
                tokenName: tokenData?.metadata?.name || undefined,
                initialMarketCap: marketCap,
                initialPrice: price,
                bundlePercentage: trenchData.holdingPercentage || undefined
            });
        }

        await channel.send(message);

        metrics.total = performance.now() - metrics.start;
        console.log(`✨ Alert sent in ${metrics.total.toFixed(2)}ms for ${tokenMint}`);

    } catch (error) {
        console.error('Error in sendTokenAlert:', error);
    }
}

client.on('error', (error) => {
    console.error('Discord client error:', error);
});

client.on('messageCreate', async (message) => {
    if (message.content.toLowerCase() === '!callstats') {
        try {
            const analyzer = new CallStatsAnalyzer(message.channel as TextChannel);
            const stats = await analyzer.getStatistics();
            const embed = analyzer.createStatsEmbed(stats);
            
            await message.reply({ embeds: [embed] });
        } catch (error) {
            console.error('Error handling callstats command:', error);
            await message.reply('Error fetching call statistics. Please try again later.');
        }
    }
});

client.on('messageCreate', async (message: Message) => {
    if (message.author.bot) return;

    if (message.content.startsWith('!ai')) {
        const tokenMint = message.content.split(' ')[1];
        if (!tokenMint) {
            await message.reply('Please provide a token address. Usage: !ai <token_address>');
            return;
        }
        await handleAICommand(message, tokenMint);
    }
});

async function getTokenSupplyAndDecimals(mintAddress: string) {
    try {
        const mintPubkey = new PublicKey(mintAddress);
        const mintInfo = await getMint(connection, mintPubkey);
        
        return {
            totalSupply: Number(mintInfo.supply),
            decimals: mintInfo.decimals
        };
    } catch (error) {
        console.error('Error fetching token supply:', error);
        return {
            totalSupply: 1_000_000_000,
            decimals: 9
        };
    }
}

// Helper function to fetch swap data
async function fetchSwapData(tokenMint: string): Promise<any> {
    try {
        const response = await axios.get(
            `https://solana-gateway.moralis.io/token/mainnet/${tokenMint}/swaps?limit=50`,
            {
                headers: {
                    'accept': 'application/json',
                    'X-API-Key': process.env.MORALIS_API_KEY || ''
                },
                timeout: 5000
            }
        );
        
        const swaps = response.data.result || [];
        
        if (swaps.length === 0) {
            return null;
        }
        
        // Define interface for swap data
        interface SwapData {
            bought?: {
                address: string;
                usdPrice?: number;
            };
            sold?: {
                address: string;
                usdPrice?: number;
            };
            walletAddress: string;
        }
        
        // Process swap data
        let buySwaps = 0;
        let sellSwaps = 0;
        let totalSwapSize = 0;
        let largestSwap = 0;
        const uniqueWallets = new Set();
        
        swaps.forEach((swap: SwapData) => {
            // Determine if it's a buy or sell
            if (swap.bought && swap.bought.address.toLowerCase() === tokenMint.toLowerCase()) {
                buySwaps++;
            } else if (swap.sold && swap.sold.address.toLowerCase() === tokenMint.toLowerCase()) {
                sellSwaps++;
            }
            
            // Calculate swap size in USD
            const swapSize = (swap.bought?.usdPrice || 0) + (swap.sold?.usdPrice || 0);
            totalSwapSize += swapSize;
            largestSwap = Math.max(largestSwap, swapSize);
            
            // Track unique wallets
            uniqueWallets.add(swap.walletAddress);
        });
        
        return {
            recentSwaps: swaps.length,
            buySwaps,
            sellSwaps,
            buyRatio: buySwaps / (buySwaps + sellSwaps || 1),
            averageSwapSize: totalSwapSize / swaps.length,
            largestSwap,
            uniqueWallets: uniqueWallets.size
        };
    } catch (error) {
        console.error('Error fetching swap data:', error);
        return null;
    }
}

export async function handleAICommand(message: any, tokenMint: string) {
    try {
        console.log('🤖 Fetching AI analysis for:', tokenMint);
        
        // Send initial loading message with degen humor
        const loadingEmbed = {
            color: 0x9933FF, // Purple for loading
            title: '🤖 STROBE AI - ANALYZING TOKEN',
            description: `
⚡ **Scanning ${tokenMint.slice(0, 6)}...${tokenMint.slice(-4)}** ⚡

*Checking if this is the next 100x or just another Solana rug...*

${['Counting paper hands...', 'Measuring degen energy...', 'Calculating ape index...', 'Scanning for exit liquidity...', 'Looking for diamond hands...'][Math.floor(Math.random() * 5)]}

*Please wait while I analyze this potentially life-changing opportunity (or total dumpster fire)*
            `,
            footer: {
                text: "Powered by Strobe AI - The degen's best friend",
                icon_url: 'https://pump.fun/favicon.ico'
            }
        };
        
        const initialResponse = await message.reply({ embeds: [loadingEmbed] });
        
        // Wait for 2 seconds for dramatic effect
        await new Promise(resolve => setTimeout(resolve, 2000));
        const priceHistory = await getTokenPriceHistory(tokenMint);
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Fetch all data in parallel
        const [
            tokenData, 
            trenchData, 
            isBonded, 
            rugCheckPassed, 
            volumeLiquidity,
            sniperDataResult,
            swapDataResult,
            latestPrice
        ] = await Promise.all([
            fetchTokenData(tokenMint),
            fetchTrenchData(tokenMint),
            checkBondingCurveStatus(tokenMint),
            getRugCheckConfirmed(tokenMint),
            getTokenVolumeAndLiquidity(tokenMint),
            fetchSniperData(tokenMint),
            fetchSwapData(tokenMint),
            fetchLatestPrice(tokenMint)
        ]);

        const { totalSupply, decimals } = await getTokenSupplyAndDecimals(tokenMint);
        
        // Use latest price if available
        const currentPrice = latestPrice > 0 ? latestPrice : 0;
        
        // Calculate market cap with latest price
        const marketCap = currentPrice * totalSupply;
        
        // Format market cap without 'M' suffix
        const formattedMarketCap = formatMarketCapValue(marketCap);
        
        // Convert sniperData to the expected format or undefined if null
        const sniperData = sniperDataResult ? {
            totalSnipers: sniperDataResult.totalSnipers,
            profitableSnipers: sniperDataResult.profitableSnipers,
            profitablePercentage: sniperDataResult.profitablePercentage,
            averageProfitPercentage: sniperDataResult.averageProfitPercentage,
            totalSnipedUsd: sniperDataResult.totalSnipedUsd,
            totalSoldUsd: sniperDataResult.totalSoldUsd,
            totalProfitUsd: sniperDataResult.totalProfitUsd,
            quickestSellBlocksAfter: sniperDataResult.quickestSellBlocksAfter
        } : undefined;
        
        // Convert swapData to the expected format or undefined if null
        const swapData = swapDataResult ? {
            recentSwaps: swapDataResult.recentSwaps,
            buySwaps: swapDataResult.buySwaps,
            sellSwaps: swapDataResult.sellSwaps,
            buyRatio: swapDataResult.buyRatio,
            averageSwapSize: swapDataResult.averageSwapSize,
            largestSwap: swapDataResult.largestSwap,
            uniqueWallets: swapDataResult.uniqueWallets
        } : undefined;
        
        const analysisData: TokenAnalysisData = {
            tokenMint,
            ticker: trenchData.ticker?.toUpperCase() || tokenMint.slice(0, 4),
            marketCap: formattedMarketCap,
            currentPrice,
            initialPrice: priceHistory.items[0]?.value || 0,
            liquidity: volumeLiquidity.liquidity || '0',
            volume24h: volumeLiquidity.volume24h || '0',
            totalBundles: trenchData.totalBundles || 0,
            holdingBundles: trenchData.holdingBundles || 0,
            totalSolSpent: trenchData.totalSolSpent?.toString() || '0',
            holdingPercentage: trenchData.holdingPercentage?.toString() || '0',
            isBonded,
            rugCheckPassed,
            priceHistory: priceHistory.items || [],
            totalSupply,
            decimals,
            priceChangePercentage24h: tokenData && 'priceChangePercentage24h' in tokenData ? (tokenData.priceChangePercentage24h as number) : 0,
            sniperData,
            swapData
        };

        // Update with "analyzing" message
        await initialResponse.edit({
            embeds: [{
                color: 0xFFA500, // Orange for processing
                title: '🧠 STROBE AI - DEEP ANALYSIS IN PROGRESS',
                description: `
**Analyzing ${trenchData.ticker || tokenMint.slice(0, 6)}...**

💰 Market Cap: ${formattedMarketCap}
💧 Liquidity: ${formatNumber(volumeLiquidity.liquidity || 'Unknown')}
🔒 Security: ${rugCheckPassed ? '✅ PASSED' : '⚠️ FAILED'}

*Crunching numbers and consulting with the degen gods...*
*${Math.floor(Math.random() * 69) + 42}% complete...*
                `,
                footer: {
                    text: `Analysis for ${tokenMint}`,
                    icon_url: 'https://pump.fun/favicon.ico'
                }
            }]
        });

        // Get Grok analysis
        const analysis = await analyzeTokenWithGrok(analysisData);
        
        // Check if this is a dead token analysis
        const isDeadToken = analysis.includes('DEAD TOKEN ALERT');
        
        // Format the analysis sections with better styling
        let formattedAnalysis = '';
        
        if (isDeadToken) {
            // For dead tokens, just show the dead token alert and summary
            const deadTokenAlert = analysis.split('DEAD TOKEN ALERT')[1].split('ANALYSIS_SUMMARY')[0].trim();
            const analysisSummary = analysis.split('ANALYSIS_SUMMARY')[1].trim();
            
            // Add some degen humor for dead tokens
            const deadTokenMemes = [
                "Even my ex-girlfriend didn't dump this hard 📉",
                "This token is so dead, it's getting rejected at the cemetery 💀",
                "Congratulations! You found the exit liquidity 🎉",
                "Not even CPR can save this one 🚑",
                "This chart looks like my dating life - all downhill 📉"
            ];
            
            const randomMeme = deadTokenMemes[Math.floor(Math.random() * deadTokenMemes.length)];
            
            formattedAnalysis = `**Token Data:**
${trenchData.ticker} (${tokenMint})
💰 **Market Cap:** ${formattedMarketCap}
💧 **Liquidity:** ${formatNumber(volumeLiquidity.liquidity || 'Unknown')}
👨‍💻 **Dev Stats:** ${trenchData.holdingBundles}/${trenchData.totalBundles} bundles, ${formatNumber(trenchData.totalSolSpent)} SOL spent
🔒 **Security:** ${rugCheckPassed ? 'PASSED' : 'FAILED'}, Bonded: ${isBonded ? 'Yes' : 'No'}

**💀 DEAD TOKEN ALERT**
\`\`\`
${deadTokenAlert}

${randomMeme}
\`\`\`

**🧟 ANALYSIS_SUMMARY**
\`\`\`
${analysisSummary}
\`\`\`

> *"Sir, this is a Wendy's. We don't serve dead tokens here."*`;
        } else {
            // For active tokens, format all sections
            const marketCapLevels = analysis.split('MARKET_CAP_LEVELS')[1].split('FIBONACCI_LEVELS')[0].trim();
            const fibonacciLevels = analysis.split('FIBONACCI_LEVELS')[1].split('SNIPER_ACTIVITY')[0].trim();
            const sniperActivity = analysis.split('SNIPER_ACTIVITY')[1].split('SWAP_ACTIVITY')[0].trim();
            const swapActivity = analysis.split('SWAP_ACTIVITY')[1].split('SOCIAL_POSTS')[0].trim();
            const socialPosts = analysis.split('SOCIAL_POSTS')[1].split('ANALYSIS_SUMMARY')[0].trim();
            const analysisSummary = analysis.split('ANALYSIS_SUMMARY')[1].trim();
            
            // Add some degen humor for active tokens
            const activeTokenMemes = [
                "Not financial advice, but my hamster says buy 🐹",
                "Wen lambo? Perhaps soon, perhaps never 🏎️",
                "Remember: 1 SOL = 1 SOL, but this token = pure degen energy ⚡",
                "My technical analysis: line go up = good, line go down = bad 📊",
                "This is either going to 100x or 0. No in-between. This is the way 🚀"
            ];
            
            const randomMeme = activeTokenMemes[Math.floor(Math.random() * activeTokenMemes.length)];
            
            formattedAnalysis = `**Token Data:**
${trenchData.ticker} (${tokenMint})
💰 **Market Cap:** ${formattedMarketCap}
💧 **Liquidity:** ${formatNumber(volumeLiquidity.liquidity || 'Unknown')}
👨‍💻 **Dev Stats:** ${trenchData.holdingBundles}/${trenchData.totalBundles} bundles, ${formatNumber(trenchData.totalSolSpent)} SOL spent
🔒 **Security:** ${rugCheckPassed ? '✅ PASSED' : '⚠️ FAILED'}, Bonded: ${isBonded ? 'Yes' : 'No'}

**📈 MARKET_CAP_LEVELS**
\`\`\`
${marketCapLevels}
\`\`\`

**📐 FIBONACCI_LEVELS**
\`\`\`
${fibonacciLevels}
\`\`\`

**🤖 SNIPER_ACTIVITY**
\`\`\`
${sniperActivity}
\`\`\`

**💱 SWAP_ACTIVITY**
\`\`\`
${swapActivity}
\`\`\`

**🐦 SOCIAL_POSTS**
\`\`\`
${socialPosts}
\`\`\`

**📊 ANALYSIS_SUMMARY**
\`\`\`
${analysisSummary}
\`\`\`

> *${randomMeme}*`;
        }
        
        // Create buttons for quick actions
        const buttons = [
            new ButtonBuilder()
                .setLabel('Trade on Jupiter')
                .setStyle(ButtonStyle.Link)
                .setURL(`https://jup.ag/swap/SOL-${tokenMint}`)
                .setEmoji('🪐'),
            new ButtonBuilder()
                .setLabel('View on Birdeye')
                .setStyle(ButtonStyle.Link)
                .setURL(`https://birdeye.so/token/${tokenMint}?chain=solana`)
                .setEmoji('👁️'),
            new ButtonBuilder()
                .setLabel('View on Solscan')
                .setStyle(ButtonStyle.Link)
                .setURL(`https://solscan.io/token/${tokenMint}`)
                .setEmoji('🔍')
        ];
        
        // Update the message with the full analysis
        await initialResponse.edit({
            embeds: [{
                color: isDeadToken ? 0xff0000 : 0x2ecc71, // Red for dead tokens, green for active
                title: isDeadToken ? '💀 STROBE AI ANALYSIS - DEAD TOKEN' : '🤖 STROBE AI ANALYSIS',
                description: formattedAnalysis,
                footer: {
                    text: `Analysis by Strobe AI - The degen's best friend | ${getEasternTime()} EST`,
                    icon_url: 'https://pump.fun/favicon.ico'
                }
            }],
            components: [
                new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)
            ]
        });

    } catch (error) {
        console.error('Error in AI analysis:', error);
        await message.reply({
            embeds: [{
                color: 0xFF0000,
                title: '❌ ANALYSIS FAILED',
                description: `
Failed to analyze token: ${tokenMint}

*Even AI has its limits when dealing with Solana tokens...*
*Try again later or find a different degen play!*
                `,
                footer: {
                    text: 'Error: ' + (error instanceof Error ? error.message : String(error)),
                    icon_url: 'https://pump.fun/favicon.ico'
                }
            }]
        });
    }
}

// Helper function to format numbers with commas and no suffixes
function formatNumber(value: string | number | undefined): string {
    if (value === undefined) return 'Unknown';
    const num = typeof value === 'string' ? parseFloat(value.replace(/[^0-9.]/g, '')) : value;
    if (isNaN(num)) return 'Unknown';
    
    return `$${num.toLocaleString('en-US', {maximumFractionDigits: 2})}`;
}

// Helper function to format market cap with commas and no suffixes
function formatMarketCapValue(marketCap: number): string {
    return `$${marketCap.toLocaleString('en-US', {maximumFractionDigits: 2})}`;
}

client.login(process.env.DISCORD_BOT_TOKEN)
    .then(() => console.log('🔓 Bot logged in successfully'))
    .catch(error => console.error('❌ Failed to log in:', error)); 
