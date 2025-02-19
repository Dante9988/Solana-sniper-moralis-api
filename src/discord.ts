import { Client, TextChannel, Message, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import dotenv from 'dotenv';
import axios from 'axios';
import { PublicKey, Connection } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import { CallStatsAnalyzer } from './callStats';
import { PUMP_FUN_PROGRAM } from './constants';
import { analyzeTokenWithGrok, TokenAnalysisData, updateDiscordWithGrokAnalysis } from './grok';
import { getRugCheckConfirmed } from './transactions';

dotenv.config();

// Create connection instance
const connection = new Connection(process.env.HELIUS_HTTPS_URI || 'https://api.mainnet-beta.solana.com');

const client = new Client({
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

function formatPrice(price: string | number | undefined): string {
    if (!price) return 'Unknown';
    
    const numPrice = Number(price);
    
    // Convert to full decimal format
    if (numPrice < 1) {
        // Convert to string to avoid scientific notation
        const priceString = numPrice.toFixed(20);
        // Remove trailing zeros after decimal
        const trimmedPrice = priceString.replace(/\.?0+$/, '');
        return `$${trimmedPrice}`;
    }
    
    // For numbers >= 1, use regular formatting
    return `$${numPrice.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 8
    })}`;
}

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
        parallel: 0,
        total: 0
    };

    try {
        // Get all necessary data in parallel
        const startParallel = performance.now();
        const [
            priceData, 
            totalSupply
        ] = await Promise.all([
            getTokenPriceInUSDC(tokenMint),
            getTokenTotalSupply(tokenMint)
        ]);
        metrics.parallel = performance.now() - startParallel;

        const priceInUsd = priceData;

        if (!priceInUsd || !totalSupply) {
            metrics.total = performance.now() - metrics.start;
            console.log(`⚠️ Missing price or supply data (${metrics.total.toFixed(2)}ms)`);
            return {};
        }

        const marketCap = priceInUsd * totalSupply;

        metrics.total = performance.now() - metrics.start;
        console.log(`\n📊 Token Data Fetch:
• Total Time: ${metrics.total.toFixed(2)}ms
• Parallel Fetch: ${metrics.parallel.toFixed(2)}ms
• Price: $${priceInUsd.toFixed(6)}
• Total Supply: ${totalSupply}
• Market Cap: $${marketCap.toLocaleString()}`);

        // Only return data if we have valid values
        if (marketCap > 0) {
            return {
                price: formatPrice(priceInUsd),
                marketCap: `$${marketCap.toLocaleString()}`
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
        const response = await axios.get(
            `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`
        );

        const pair = response.data?.pairs?.[0];
        return {
            volume1h: pair?.volume?.h1 ? `$${Number(pair.volume.h1).toLocaleString()}` : 'Unknown',
            volume24h: pair?.volume?.h24 ? `$${Number(pair.volume.h24).toLocaleString()}` : 'Unknown',
            liquidity: pair?.liquidity?.usd ? `$${Number(pair.liquidity.usd).toLocaleString()}` : 'Unknown'
        };
    } catch (error) {
        console.error('Error fetching token data from DexScreener:', error);
        return {};
    }
}

async function getTokenTotalSupply(tokenMint: string): Promise<number> {
    try {
        const mint = await getMint(
            connection,
            new PublicKey(tokenMint)
        );
        
        // Calculate total supply considering decimals
        const totalSupply = Number(mint.supply) / Math.pow(10, mint.decimals);
        
        return totalSupply;
    } catch (error) {
        console.error('Error fetching token supply:', error);
        return 0;
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

async function getSolPrice(): Promise<number> {
    try {
        const response = await axios.get(
            'https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112'
        );
        
        const pair = response.data?.pairs?.[0];
        if (pair?.priceUsd) {
            return Number(pair.priceUsd);
        }
        
        return 0;
    } catch (error) {
        console.error('Error fetching SOL price from DexScreener:', error);
        return 0;
    }
}

async function getTokenLiquidity(tokenMint: string): Promise<string> {
    try {
        const response = await axios.get(
            `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`
        );

        const pair = response.data?.pairs?.[0];
        if (pair?.liquidity?.usd) {
            return `$${Number(pair.liquidity.usd).toLocaleString()}`;
        }
        
        return 'Unknown';
    } catch (error) {
        console.error('Error fetching token liquidity from DexScreener:', error);
        return 'Unknown';
    }
}

async function getTokenPriceFromJupiter(tokenMint: string): Promise<{priceInSol: number, liquidity?: string}> {
    try {
        const response = await axios.get(`https://api.jup.ag/price/v2`, {
            params: {
                ids: tokenMint,
                vsToken: 'So11111111111111111111111111111111111111112' // SOL mint address
            }
        });
        
        const priceData = response.data?.data?.[tokenMint];
        if (!priceData) {
            throw new Error('No price data found for token');
        }

        return {
            priceInSol: priceData.price || 0,
            liquidity: 'From Jupiter' // You can format this if needed
        };
    } catch (error) {
        console.error('Error getting token price from Jupiter:', error);
        return { priceInSol: 0 };
    }
}

async function getTokenPriceInUSDC(tokenMint: string): Promise<number> {
    const response = await fetch(`https://api.jup.ag/price/v2?ids=${tokenMint}`);
    const data = await response.json() as any;
    return parseFloat(data.data[tokenMint]?.price || '0');
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

export async function sendTokenAlert(tokenMint: string, rugCheckPassed: boolean) {
    const metrics = {
        start: performance.now(),
        total: 0
    };

    if (!channel) {
        console.log('❌ Cannot send message - channel not found');
        return;
    }

    try {
        const [marketResult, trenchResult, volumeLiquidityResult] = await Promise.allSettled([
            fetchTokenData(tokenMint),
            fetchTrenchData(tokenMint),
            getTokenVolumeAndLiquidity(tokenMint)
            //checkBondingCurveStatus(tokenMint)
        ]);
        
        const initialMarketData = marketResult.status === "fulfilled" ? marketResult.value : {};
        const trenchData = trenchResult.status === "fulfilled" ? trenchResult.value : {};
        const volumeLiquidity = volumeLiquidityResult.status === "fulfilled" ? volumeLiquidityResult.value : {};
        //const isBonded = bondingResult.status === "fulfilled" ? bondingResult.value : false;

        const detectedTime = getEasternTime();
        const quickMessage = {
            embeds: [{
                color: 0x2ecc71,
                title: `🚀 New Token Launch Detected: ${trenchData.ticker?.toUpperCase() || 'UNKNOWN'}`,
                description: `
\`\`\`
Token: ${tokenMint}
\`\`\`

🔄 *Fetching market data...*`,
                footer: {
                    text: `🕒 Detected at ${detectedTime} EST`,
                    icon_url: 'https://pump.fun/favicon.ico'
                }
            }],
            components: [
                new ActionRowBuilder<ButtonBuilder>().addComponents(
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
                ),
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder()
                        .setLabel('🔄 Raydium')
                        .setStyle(ButtonStyle.Link)
                        .setURL(`https://raydium.io/swap/?inputCurrency=sol&outputCurrency=${tokenMint}`),
                    new ButtonBuilder()
                        .setLabel('🦅 Birdeye')
                        .setStyle(ButtonStyle.Link)
                        .setURL(`https://birdeye.so/token/${tokenMint}?chain=solana`)
                )
            ]
        };

        const quickAlert = await channel.send(quickMessage);

        if (!initialMarketData || !trenchData) {
            throw new Error('Failed to fetch token data');
        }

        const updateTime = getEasternTime();
        const updatedMessage = {
            embeds: [{
                color: 0x2ecc71,
                title: `🚀 New Token Launch Detected: ${trenchData.ticker?.toUpperCase() || 'UNKNOWN'}`,
                description: `
\`\`\`
Token: ${tokenMint}
\`\`\`

**💹 Market Analysis**
━━━━━━━━━━━━━━━━━━━━━━
💰 **Market Cap:** ${initialMarketData.marketCap || 'Unknown'}
📈 **Price:** ${initialMarketData.price || 'Unknown'}
💧 **Liquidity:** ${volumeLiquidity.liquidity || 'Unknown'}
📊 **1H Volume:** ${volumeLiquidity.volume1h || 'Unknown'}
📊 **24H Volume:** ${volumeLiquidity.volume24h || 'Unknown'}

**🎯 Quick Stats**
━━━━━━━━━━━━━━━━━━━━━━

📦 **Bundles:** ${trenchData.holdingBundles || '0'}/${trenchData.totalBundles || '0'}
📦 **Percentage:** ${trenchData.holdingPercentage || '0'}%
💵 **SOL Spent:** ${trenchData.totalSolSpent ? `◎${trenchData.totalSolSpent}` : 'Unknown'}
🛡️ **Security:** ${rugCheckPassed ? '✅ PASSED' : '⚠️ CAUTION'}

> 💡 *DYOR - Trade at your own risk*`,
                footer: {
                    text: `🕒 ${detectedTime} EST • Updated at ${updateTime} EST`,
                    icon_url: 'https://pump.fun/favicon.ico'
                }
            }],
            components: quickMessage.components // Reuse the same buttons
        };

        await quickAlert.edit(updatedMessage);

        metrics.total = performance.now() - metrics.start;
        console.log(`✨ Alert sent in ${metrics.total.toFixed(2)}ms for ${tokenMint}`);

    } catch (error) {
        console.error(`❌ Alert error (${performance.now() - metrics.start}ms):`, error);
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

export async function handleAICommand(message: any, tokenMint: string) {
    try {
        console.log('🤖 Fetching AI analysis for:', tokenMint);
        // Wait for 5 seconds
        await new Promise(resolve => setTimeout(resolve, 2000));
        const priceHistory = await getTokenPriceHistory(tokenMint);
        await new Promise(resolve => setTimeout(resolve, 2000));
        const [tokenData, trenchData, isBonded, rugCheckPassed, volumeLiquidity] = await Promise.all([
            fetchTokenData(tokenMint),
            fetchTrenchData(tokenMint),
            checkBondingCurveStatus(tokenMint),
            getRugCheckConfirmed(tokenMint),
            getTokenVolumeAndLiquidity(tokenMint)
        ]);

        const { totalSupply, decimals } = await getTokenSupplyAndDecimals(tokenMint);
        
        const analysisData: TokenAnalysisData = {
            tokenMint,
            ticker: trenchData.ticker?.toUpperCase() || tokenMint.slice(0, 4),
            marketCap: tokenData.marketCap || '0',
            currentPrice: parseFloat(tokenData.price || '0'),
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
            decimals
        };

        const analysis = await analyzeTokenWithGrok(analysisData);
        
        await message.reply({
            embeds: [{
                color: 0x2ecc71,
                title: '🤖 STROBE AI ANALYSIS',
                description: `**Token Data:**
${trenchData.ticker} (${tokenMint})
💰 Market Cap: ${formatNumber(tokenData.marketCap || 'Unknown')}
💧 Liquidity: ${formatNumber(volumeLiquidity.liquidity || 'Unknown')}
👨‍💻 Dev Stats: ${trenchData.holdingBundles}/${trenchData.totalBundles} bundles, ${formatNumber(trenchData.totalSolSpent)} SOL spent
🔒 Security: ${rugCheckPassed ? 'PASSED' : 'FAILED'}, Bonded: ${isBonded ? 'Yes' : 'No'}

**📈 MARKET_CAP_LEVELS**
${analysis.split('SOCIAL_POSTS')[0].split('MARKET_CAP_LEVELS')[1].trim()}

**🐦 SOCIAL_POSTS**
${analysis.split('SOCIAL_POSTS')[1].split('ANALYSIS_SUMMARY')[0].trim()}

**📊 ANALYSIS_SUMMARY**
${analysis.split('ANALYSIS_SUMMARY')[1].trim()}`,
                footer: {
                    text: `Analysis for ${tokenMint}`,
                    icon_url: 'https://pump.fun/favicon.ico'
                }
            }]
        });

    } catch (error) {
        console.error('Error in AI analysis:', error);
        await message.reply('❌ Failed to generate AI analysis. Please try again later.');
    }
}

// Helper function to format numbers
function formatNumber(value: string | number | undefined): string {
    if (value === undefined) return 'Unknown';
    const num = typeof value === 'string' ? parseFloat(value.replace(/[^0-9.]/g, '')) : value;
    if (isNaN(num)) return 'Unknown';
    
    if (num >= 1e9) return `$${(num / 1e9).toFixed(2)}B`;
    if (num >= 1e6) return `$${(num / 1e6).toFixed(2)}M`;
    if (num >= 1e3) return `$${(num / 1e3).toFixed(2)}K`;
    return `$${num.toFixed(2)}`;
}

client.login(process.env.DISCORD_BOT_TOKEN)
    .then(() => console.log('🔓 Bot logged in successfully'))
    .catch(error => console.error('❌ Failed to log in:', error)); 
