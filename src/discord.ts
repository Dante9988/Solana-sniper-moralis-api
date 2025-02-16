import { Client, TextChannel, Message, GatewayIntentBits } from 'discord.js';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

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
    volume?: string;
    pair?: string;
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

async function fetchTokenData(tokenMint: string): Promise<TokenData> {
    try {
        const response = await axios.get(
            `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`
        );

        const pair = response.data?.pairs?.[0];
        if (pair) {
            return {
                price: formatPrice(pair.priceUsd),
                marketCap: pair.fdv ? `$${Number(pair.fdv).toLocaleString()}` : 'Unknown',
                liquidity: pair.liquidity?.usd ? `$${Number(pair.liquidity.usd).toLocaleString()}` : 'Unknown',
                volume: pair.volume?.h24 ? `$${Number(pair.volume.h24).toLocaleString()}` : 'Unknown',
                pair: pair.pairAddress || 'Unknown'
            };
        }
        
        return {};
    } catch (error) {
        console.error('Error fetching token data:', error);
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

export async function sendTokenAlert(tokenMint: string) {
    if (!channel) {
        console.log('❌ Cannot send message - channel not found');
        return;
    }

    console.log('🔄 Attempting to send message for token:', tokenMint);

    const tokenData = await fetchTokenData(tokenMint);
    const trenchData = await fetchTrenchData(tokenMint);

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
• 📈 24h Volume: ${tokenData.volume || 'Unknown'}

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
• [Photon](https://photon-sol.com/token/${tokenMint})
• [Dexscreener](https://dexscreener.com/solana/${tokenMint})
• [Birdeye](https://birdeye.so/token/${tokenMint}?chain=solana)

⚡ **Quick Links:**
• 💱 [Trade on Raydium](https://raydium.io/swap/?inputCurrency=sol&outputCurrency=${tokenMint})
• 📊 [View Chart](https://dexscreener.com/solana/${tokenMint})

⚠️ *Always DYOR (Do Your Own Research)*
            `,
            footer: {
                text: '🕒 Time: ' + new Date().toLocaleString()
            }
        }]
    };

    try {
        await channel.send(message);
        console.log('✅ Message sent successfully');
    } catch (error) {
        console.error('❌ Failed to send Discord message:', error);
    }
}

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
• 📈 24h Volume: ${tokenData.volume || 'Unknown'}

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
• [Photon](https://photon-sol.com/token/${tokenMint})
• [Dexscreener](https://dexscreener.com/solana/${tokenMint})
• [Birdeye](https://birdeye.so/token/${tokenMint}?chain=solana)

⚡ **Quick Links:**
• 💱 [Trade on Raydium](https://raydium.io/swap/?inputCurrency=sol&outputCurrency=${tokenMint})
• 📊 [View Chart](https://dexscreener.com/solana/${tokenMint})

⚠️ *Always DYOR (Do Your Own Research)*
                        `,
                        footer: {
                            text: '🕒 Time: ' + new Date().toLocaleString()
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

client.login(process.env.DISCORD_BOT_TOKEN)
    .then(() => console.log('🔓 Bot logged in successfully'))
    .catch(error => console.error('❌ Failed to log in:', error)); 