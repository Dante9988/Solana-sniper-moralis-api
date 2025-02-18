import { Client, TextChannel, Message, GatewayIntentBits } from 'discord.js';
import dotenv from 'dotenv';
import axios from 'axios';
import { PublicKey, Connection } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import { CallStatsAnalyzer } from './callStats';

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

interface TokenData {
    price?: string;
    marketCap?: string;
    liquidity?: string;
    volume1h?: string;
    volume24h?: string;
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

// async function fetchTokenData(tokenMint: string): Promise<TokenData> {
//     try {
//         // Get all necessary data in parallel
//         const [solPrice, totalSupply, tokenData] = await Promise.all([
//             getSolPrice(),
//             getTokenTotalSupply(tokenMint),
//             getTokenPriceFromJupiter(tokenMint)
//         ]);

//         const { volume1h, volume24h, liquidity } = await getTokenVolumeAndLiquidity(tokenMint);

//         if (tokenData.priceInSol > 0) {
//             // Calculate token price in USD (token/SOL ratio * SOL price in USD)
//             const priceInUsd = tokenData.priceInSol * solPrice;
            
//             // Calculate market cap
//             const marketCap = priceInUsd * totalSupply;

//             return {
//                 price: formatPrice(priceInUsd),
//                 marketCap: marketCap ? `$${marketCap.toLocaleString()}` : 'Unknown',
//                 liquidity: liquidity || 'failed to get liquidity',
//                 volume1h: volume1h || 'failed to get volume',
//                 volume24h: volume24h || 'failed to get volume'
//             };
//         }
        
//         return {};
//     } catch (error) {
//         console.error('Error fetching token data:', error);
//         return {};
//     }
// }

async function fetchTokenData(tokenMint: string): Promise<TokenData> {
    const metrics = {
        start: performance.now(),
        parallel: 0,
        total: 0
    };

    try {
        // Get all necessary data in parallel including volume/liquidity
        const startParallel = performance.now();
        const [
            solPrice, 
            totalSupply, 
            tokenData,
            volumeLiquidity
        ] = await Promise.all([
            getSolPrice(),
            getTokenTotalSupply(tokenMint),
            getTokenPriceFromJupiter(tokenMint),
            getTokenVolumeAndLiquidity(tokenMint)
        ]);
        metrics.parallel = performance.now() - startParallel;

        if (tokenData.priceInSol > 0) {
            const priceInUsd = tokenData.priceInSol * solPrice;
            const marketCap = priceInUsd * totalSupply;

            metrics.total = performance.now() - metrics.start;
            console.log(`\n📊 Token Data Fetch:
• Total Time: ${metrics.total.toFixed(2)}ms
• Parallel Fetch: ${metrics.parallel.toFixed(2)}ms
• Price: $${priceInUsd.toFixed(6)}
• Market Cap: $${marketCap.toLocaleString()}`);

            return {
                price: formatPrice(priceInUsd),
                marketCap: marketCap ? `$${marketCap.toLocaleString()}` : 'Unknown',
                liquidity: volumeLiquidity.liquidity || 'Unknown',
                volume1h: volumeLiquidity.volume1h || 'Unknown',
                volume24h: volumeLiquidity.volume24h || 'Unknown'
            };
        }
        
        metrics.total = performance.now() - metrics.start;
        console.log(`⚠️ No price data found (${metrics.total.toFixed(2)}ms)`);
        return {};

    } catch (error) {
        metrics.total = performance.now() - metrics.start;
        console.error(`❌ Error fetching token data (${metrics.total.toFixed(2)}ms):`, error);
        return {};
    }
}

async function getTokenVolumeAndLiquidity(tokenMint: string): Promise<{volume1h?: string, volume24h?: string, liquidity?: string}> {
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

// async function fetchTokenData(tokenMint: string): Promise<TokenData> {
//     try {
//         const response = await axios.get(
//             `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`
//         );

//         const pair = response.data?.pairs?.[0];
//         if (pair) {
//             return {
//                 price: formatPrice(pair.priceUsd),
//                 marketCap: pair.fdv ? `$${Number(pair.fdv).toLocaleString()}` : 'Unknown',
//                 liquidity: pair.liquidity?.usd ? `$${Number(pair.liquidity.usd).toLocaleString()}` : 'Unknown',
//                 volume: pair.volume?.h24 ? `$${Number(pair.volume.h24).toLocaleString()}` : 'Unknown',
//                 pair: pair.pairAddress || 'Unknown'
//             };
//         }
        
//         return {};
//     } catch (error) {
//         console.error('Error fetching token data:', error);
//         return {};
//     }
// }

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

export async function sendTokenAlert(tokenMint: string) {
    const metrics = {
        tokenData: 0,
        trenchData: 0,
        discordPost: 0,
        total: 0
    };

    const startTotal = performance.now();

    if (!channel) {
        console.log('❌ Cannot send message - channel not found');
        return;
    }

    console.log('🔄 Attempting to send message for token:', tokenMint);

    try {
        // Fetch both token and trench data in parallel
        const startDataFetch = performance.now();
        const [tokenData, trenchData] = await Promise.all([
            fetchTokenData(tokenMint),
            fetchTrenchData(tokenMint)
        ]);
        
        metrics.tokenData = performance.now() - startDataFetch;

        const message = {
            content: '🚀 **NEW TOKEN DETECTED** 🚀',
            embeds: [{
                color: 0x00FF00,
                description: `
💎 **Token Address:** \`${tokenMint}\`

📊 **Token Info:**
• 💵 Price: ${tokenData.price || 'Unknown'}
• 💰 Market Cap: ${tokenData.marketCap || 'Unknown'}
• 💧 Liquidity: ${tokenData.liquidity || 'Unknown'}
• 📈 1h Volume: ${tokenData.volume1h || 'Unknown'}
• 📈 24h Volume: ${tokenData.volume24h || 'Unknown'}

🔍 **Trench Analysis:**
• 📝 Ticker: ${trenchData.ticker || 'Unknown'}
• 📦 Total Bundles: ${trenchData.holdingBundles || '0'} (Holding) / ${trenchData.totalBundles || 'Unknown'} (Total)
• 💰 Total SOL Spent: ${trenchData.totalSolSpent?.toFixed(2) || 'Unknown'} SOL
• 📈 Current Held Percentage: ${trenchData.holdingPercentage?.toFixed(4) || 'Unknown'}%
• 🔗 Bonded: ${trenchData.bonded ? 'Yes' : 'No'}

🔗 **Trading Links:**
• [BullX](https://neo.bullx.io/terminal?chainId=1399811149&address=${tokenMint})
• [Axiom](https://axiom.trade/t/${tokenMint})
• [GMGN](https://gmgn.ai/sol/token/${tokenMint})
• [Photon](https://photon-sol.tinyastro.io/en/r/@Strobe/${tokenMint})
• [Dexscreener](https://dexscreener.com/solana/${tokenMint})
• [Birdeye](https://birdeye.so/token/${tokenMint}?chain=solana)

⚡ **Quick Links:**
• 💱 [Trade on Raydium](https://raydium.io/swap/?inputCurrency=sol&outputCurrency=${tokenMint})
• 📊 [View Chart](https://dexscreener.com/solana/${tokenMint})

⚠️ *Always DYOR (Do Your Own Research)*
                `,
                footer: {
                    text: `🕒 Time: ${getEasternTime()} EST`
                }
            }]
        };

        const startDiscordPost = performance.now();
        await channel.send(message);
        metrics.discordPost = performance.now() - startDiscordPost;

        metrics.total = performance.now() - startTotal;
        console.log(`\n📊 Discord Alert Performance:
• Total Time: ${metrics.total.toFixed(2)}ms
• Data Fetch: ${metrics.tokenData.toFixed(2)}ms
• Discord Post: ${metrics.discordPost.toFixed(2)}ms
✅ Message sent successfully`);

    } catch (error) {
        metrics.total = performance.now() - startTotal;
        console.error('❌ Failed to send Discord message:', error);
    }
}

// export async function sendTokenAlert(tokenMint: string, connection: Connection) {
//     const metrics = {
//         tokenData: 0,
//         trenchData: 0,
//         discordPost: 0,
//         total: 0
//     };

//     const startTotal = performance.now();

//     if (!channel) {
//         console.log('❌ Cannot send message - channel not found');
//         return;
//     }

//     console.log('🔄 Attempting to send message for token:', tokenMint);

//     try {
//         // Fetch token data with timing
//         const startTokenData = performance.now();
//         const tokenData = await fetchTokenData(tokenMint);
//         metrics.tokenData = performance.now() - startTokenData;
//         console.log(`⏱️ Token data fetched in ${metrics.tokenData.toFixed(2)}ms`);

//         // Fetch trench data with timing
//         const startTrenchData = performance.now();
//         const trenchData = await fetchTrenchData(tokenMint);
//         metrics.trenchData = performance.now() - startTrenchData;
//         console.log(`⏱️ Trench data fetched in ${metrics.trenchData.toFixed(2)}ms`);

//         const message = {
//             content: '🚀 **NEW TOKEN DETECTED** 🚀',
//             embeds: [{
//                 color: 0x00FF00,
//                 description: `
// 💎 **Token Address:** \`${tokenMint}\`

// 📊 **Token Info:**
// • 💵 Price: ${tokenData.price || 'Unknown'}
// • 💰 Market Cap: ${tokenData.marketCap || 'Unknown'}
// • 💧 Liquidity: ${tokenData.liquidity || 'Unknown'}
// • 📈 1h Volume: ${tokenData.volume1h || 'Unknown'}
// • 📈 24h Volume: ${tokenData.volume24h || 'Unknown'}

// 🔍 **Trench Analysis:**
// • 📝 Ticker: ${trenchData.ticker || 'Unknown'}
// • 📦 Total Bundles: ${trenchData.holdingBundles || '0'} (Holding) / ${trenchData.totalBundles || 'Unknown'} (Total)
// • 💰 Total SOL Spent: ${trenchData.totalSolSpent?.toFixed(2) || 'Unknown'} SOL
// • 📈 Current Held Percentage: ${trenchData.holdingPercentage?.toFixed(4) || 'Unknown'}%
// • 🔗 Bonded: ${trenchData.bonded ? 'Yes' : 'No'}

// 🔗 **Trading Links:**
// • [BullX](https://neo.bullx.io/terminal?chainId=1399811149&address=${tokenMint})
// • [Axiom](https://axiom.trade/t/${tokenMint})
// • [GMGN](https://gmgn.ai/sol/token/${tokenMint})
// • [Photon](https://photon-sol.com/token/${tokenMint})
// • [Dexscreener](https://dexscreener.com/solana/${tokenMint})
// • [Birdeye](https://birdeye.so/token/${tokenMint}?chain=solana)

// ⚡ **Quick Links:**
// • 💱 [Trade on Raydium](https://raydium.io/swap/?inputCurrency=sol&outputCurrency=${tokenMint})
// • 📊 [View Chart](https://dexscreener.com/solana/${tokenMint})

// ⚠️ *Always DYOR (Do Your Own Research)*
//                 `,
//                 footer: {
//                     text: `🕒 Time: ${getEasternTime()} EST | ⏱️ Processing: ${(performance.now() - startTotal).toFixed(2)}ms`
//                 }
//             }]
//         };

//         // Send to Discord with timing
//         const startDiscordPost = performance.now();
//         await channel.send(message);
//         metrics.discordPost = performance.now() - startDiscordPost;

//         metrics.total = performance.now() - startTotal;

//         console.log(`\n📊 Discord Alert Performance:
// • Total Time: ${metrics.total.toFixed(2)}ms
// • Token Data Fetch: ${metrics.tokenData.toFixed(2)}ms
// • Trench Data Fetch: ${metrics.trenchData.toFixed(2)}ms
// • Discord Post: ${metrics.discordPost.toFixed(2)}ms
// ${metrics.total > 5000 ? '⚠️ Warning: Alert took longer than 5 seconds!' : '✅ Message sent successfully'}`);

//     } catch (error) {
//         metrics.total = performance.now() - startTotal;
//         console.error(`❌ Failed to send Discord message (${metrics.total.toFixed(2)}ms):`, error);
//     }
// }

// Add message listener

client.on('messageCreate', async (message: Message) => {
    if (message.author.bot) return;

    const solanaAddressRegex = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
    const matches = message.content.match(solanaAddressRegex);

    if (matches) {
        for (const tokenMint of matches) {
            console.log('🔍 Checking token:', tokenMint);
            
            const tokenData = await fetchTokenData(tokenMint);
            const trenchData = await fetchTrenchData(tokenMint);
            
            if (Object.keys(tokenData).length > 0) {
                const response = {
                    content: '🔍 **Token Info Requested (NOT A CALL / DYOR)**',
                    embeds: [{
                        color: 0x3498db,
                        description: `
💎 **Token Address:** \`${tokenMint}\`

📊 **Token Info:**
• 💵 Price: ${tokenData.price || 'Unknown'}
• 💰 Market Cap: ${tokenData.marketCap || 'Unknown'}
• 💧 Liquidity: ${tokenData.liquidity || 'Unknown'}
• 📈 1h Volume: ${tokenData.volume1h || 'Unknown'}
• 📈 24h Volume: ${tokenData.volume24h || 'Unknown'}

🔍 **Trench Analysis:**
• 📝 Ticker: ${trenchData.ticker || 'Unknown'}
• 📦 Total Bundles: ${trenchData.holdingBundles || '0'} (Holding) / ${trenchData.totalBundles || 'Unknown'} (Total)
• 💰 Total SOL Spent: ${trenchData.totalSolSpent?.toFixed(2) || 'Unknown'} SOL
• 📈 Current Held Percentage: ${trenchData.holdingPercentage?.toFixed(4) || 'Unknown'}%
• 🔗 Bonded: ${trenchData.bonded ? 'Yes' : 'No'}

🔗 **Trading Links:**
• [BullX](https://neo.bullx.io/terminal?chainId=1399811149&address=${tokenMint})
• [Axiom](https://axiom.trade/t/${tokenMint})
• [GMGN](https://gmgn.ai/sol/token/${tokenMint})
• [Photon](https://photon-sol.tinyastro.io/en/r/@Strobe/${tokenMint})
• [Dexscreener](https://dexscreener.com/solana/${tokenMint})
• [Birdeye](https://birdeye.so/token/${tokenMint}?chain=solana)

⚡ **Quick Links:**
• 💱 [Trade on Raydium](https://raydium.io/swap/?inputCurrency=sol&outputCurrency=${tokenMint})
• 📊 [View Chart](https://dexscreener.com/solana/${tokenMint})

⚠️ *Always DYOR (Do Your Own Research)*
                        `,
                        footer: {
                            text: `🕒 Time: ${getEasternTime()} EST`
                        }
                    }]
                };

                try {
                    await message.reply(response);
                    console.log('✅ Replied with token info');
                } catch (error) {
                    console.error('❌ Failed to send reply:', error);
                }
            } else {
                await message.reply(`❌ No data found for token: \`${tokenMint}\``);
            }
        }
    }
});

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

client.login(process.env.DISCORD_BOT_TOKEN)
    .then(() => console.log('🔓 Bot logged in successfully'))
    .catch(error => console.error('❌ Failed to log in:', error)); 