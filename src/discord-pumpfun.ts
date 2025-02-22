import { Client, TextChannel, Message, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import dotenv from 'dotenv';
import axios from 'axios';
import { Connection, PublicKey } from '@solana/web3.js';
import { PUMP_FUN_PROGRAM } from './constants';

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
    console.log('🤖 Pump.fun Discord bot is ready!');
    const channelId = process.env.PUMPFUN_DISCORD_CHANNEL_ID;
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

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchTokenMarketData(mintAddress: string) {
    try {
        // Get bonding curve PDA
        const [bondingCurvePDA] = PublicKey.findProgramAddressSync(
            [
                Buffer.from("bonding-curve"),
                new PublicKey(mintAddress).toBuffer()
            ],
            new PublicKey(PUMP_FUN_PROGRAM)
        );

        // Fetch raw account data
        const accountInfo = await connection.getAccountInfo(bondingCurvePDA);
        if (!accountInfo) {
            console.log("❌ No bonding curve account found.");
            return null;
        }

        // First 8 bytes are discriminator, skip them when deserializing
        const bondingCurveData = {
            virtualTokenReserves: accountInfo.data.readBigUInt64LE(8),
            virtualSolReserves: accountInfo.data.readBigUInt64LE(16),
            realTokenReserves: accountInfo.data.readBigUInt64LE(24),
            realSolReserves: accountInfo.data.readBigUInt64LE(32),
            tokenTotalSupply: accountInfo.data.readBigUInt64LE(40),
            complete: accountInfo.data.readUInt8(48) === 1
        };

        // Get SOL price for USD calculations
        const solPrice = await getSolPrice();

        // Calculate liquidity in SOL
        const solLiquidity = Number(bondingCurveData.realSolReserves) / 1e9;
        
        // Calculate liquidity in USD
        const liquidityUSD = solLiquidity * solPrice;

        // Calculate virtual price from reserves
        const virtualPrice = Number(bondingCurveData.virtualSolReserves) / 
                           Number(bondingCurveData.virtualTokenReserves);
        
        // Calculate market cap
        const totalSupply = Number(bondingCurveData.tokenTotalSupply);
        const marketCapUSD = (totalSupply * virtualPrice * solPrice) / 1e9;

        return {
            marketCap: marketCapUSD.toFixed(2),
            totalSupply: totalSupply,
            liquidityUSD: liquidityUSD.toFixed(2),
            priceUSD: ((virtualPrice * solPrice) / 1e9).toFixed(6),
            complete: bondingCurveData.complete
        };
    } catch (error) {
        console.error("❌ Error fetching market data:", error);
        return null;
    }
}

async function getSolPrice(): Promise<number> {
    try {
        const response = await axios.get('https://frontend-api-v3.pump.fun/sol-price');
        return Number(response.data.solPrice);
    } catch (error) {
        console.error('Error fetching SOL price from Pump.fun:', error);
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

function createProgressBar(percent: number): string {
    const filled = '█';
    const empty = '░';
    const totalBars = 20;
    const filledBars = Math.round(percent * totalBars);
    const emptyBars = totalBars - filledBars;
    return filled.repeat(filledBars) + empty.repeat(emptyBars);
}

export async function sendPumpFunAlert(tokenMint: string) {
    if (!channel) {
        console.error('❌ Cannot send message - channel not found');
        return;
    }

    console.log('🔄 Attempting to send Pump.fun alert for token:', tokenMint);

    try {
        // Maximum number of retries
        const MAX_RETRIES = 5;
        let retryCount = 0;
        let marketData = null;

        while (retryCount < MAX_RETRIES) {
            // Add delay between attempts (increasing delay with each retry)
            const delay = 2000 * (retryCount + 1); // 2s, 4s, 6s, 8s, 10s
            await new Promise(resolve => setTimeout(resolve, delay));
            
            console.log(`Attempt ${retryCount + 1}/${MAX_RETRIES} to fetch market data...`);
            marketData = await fetchTokenMarketData(tokenMint);

            // Check if we have all required data
            if (marketData && 
                marketData.priceUSD && 
                marketData.marketCap && 
                marketData.liquidityUSD && 
                marketData.totalSupply) {
                break;
            }

            retryCount++;
            console.log('⏳ Waiting for bonding curve to initialize...');
        }

        // If we still don't have market data after all retries, don't send the alert
        if (!marketData || 
            !marketData.priceUSD || 
            !marketData.marketCap || 
            !marketData.liquidityUSD || 
            !marketData.totalSupply) {
            console.log('❌ Failed to get market data after all retries. Skipping alert.');
            return;
        }

        // Fetch token metadata
        const tokenMetadata = await axios.get(`https://frontend-api-v3.pump.fun/coins/${tokenMint}`);
        const tokenData = tokenMetadata.data;

        // Calculate bonding curve percentage based on market cap
        const marketCapThreshold = 85000; // $85k threshold
        const currentMarketCap = Number(tokenData.usd_market_cap);
        const maxBondingPercent = currentMarketCap >= marketCapThreshold ? 1 : 0.5; // 100% if above threshold, 50% if below

        // Calculate actual bonding percentage from virtual reserves
        const actualBondingPercent = Number(tokenData.virtual_sol_reserves) / 
                                   Number(tokenData.virtual_token_reserves);
        const bondingPercent = Math.min(actualBondingPercent, maxBondingPercent);

        const progressBar = createProgressBar(bondingPercent);
        const devBuyAmount = Number(tokenData.virtual_sol_reserves) / 1e9; // Convert lamports to SOL

        const message = {
            content: '🎯 **NEW PUMP.FUN TOKEN DETECTED** 🎯',
            embeds: [{
                title: `💎 New Token Alert: ${tokenData.symbol}`,
                description: `
\`\`\`
Token: ${tokenMint}
Creator: ${tokenData.creator}
\`\`\`

${tokenData.description ? `📝 **Description:** ${tokenData.description}` : '📝 **Description:** No description found'}

**📊 Token Metrics**
━━━━━━━━━━━━━━━━━━━━━━
💵 **Price:** $${marketData.priceUSD}
💰 **Market Cap:** $${marketData.marketCap}
💧 **Liquidity:** $${marketData.liquidityUSD}
📈 **Total Supply:** ${marketData.totalSupply}

**⚡ Bonding Curve**
${progressBar} ${(bondingPercent * 100).toFixed(2)}%
**Dev Buy:** ${devBuyAmount.toFixed(2)} SOL

🔒 **Bonding Complete:** ${marketData.complete ? 'Yes ✅' : 'No ⏳'}

${tokenData.website ? `🌐 **Website:** ${tokenData.website}` : ''}
${tokenData.twitter ? `🐦 **Twitter:** ${tokenData.twitter}` : ''}
${tokenData.telegram ? `📱 **Telegram:** ${tokenData.telegram}` : ''}`,
                thumbnail: {
                    url: tokenData.image_uri && tokenData.image_uri !== '' ? 
                        tokenData.image_uri : 
                        'https://pump.fun/logo.png' // Fallback if image is empty or invalid
                },
                footer: {
                    text: `🌟 Created at ${new Date(tokenData.created_timestamp).toLocaleString('en-US', {
                        timeZone: 'America/New_York',
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                        hour12: true
                    })} EST • 🕒 Detected at ${getEasternTime()} EST`,
                    icon_url: 'https://pump.fun/favicon.ico'
                }
            }],
            components: [
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder()
                        .setLabel('🌊 Pump.fun')
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
                        .setLabel('🌊 Raydium')
                        .setStyle(ButtonStyle.Link)
                        .setURL(`https://raydium.io/swap/?inputCurrency=sol&outputCurrency=${tokenMint}`),
                    new ButtonBuilder()
                        .setLabel('🔍 Dexscreener')
                        .setStyle(ButtonStyle.Link)
                        .setURL(`https://dexscreener.com/solana/${tokenMint}`),
                    new ButtonBuilder()
                        .setLabel('🦅 Birdeye')
                        .setStyle(ButtonStyle.Link)
                        .setURL(`https://birdeye.so/token/${tokenMint}?chain=solana`)
                )
            ]
        };

        // Send alert
        await channel.send(message);
        console.log('✅ Discord alert sent successfully');
        
        // Wait 5 seconds before next alert
        await sleep(5000);

    } catch (error) {
        console.error('❌ Failed to send Discord message:', error);
    }
}

// Add message listener for token lookups
client.on('messageCreate', async (message: Message) => {
    if (message.author.bot) return;

    const solanaAddressRegex = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
    const matches = message.content.match(solanaAddressRegex);

    if (matches) {
        for (const tokenMint of matches) {
            console.log('🔍 Checking Pump.fun token:', tokenMint);
            
            const marketData = await fetchTokenMarketData(tokenMint);
            
            if (marketData) {
                const response = {
                    content: '🔍 **Pump.fun Token Info (NOT A CALL / DYOR)**',
                    embeds: [{
                        color: 0x3498db,
                        description: `
💎 **Token Address:** \`${tokenMint}\`

📊 **Token Info:**
• 💵 Price: $${marketData.priceUSD}
• 💰 Market Cap: $${marketData.marketCap}
• 💧 Liquidity: $${marketData.liquidityUSD}
• 📈 Total Supply: ${marketData.totalSupply}
• 🔒 Bonding Complete: ${marketData.complete ? 'Yes' : 'No'}

🔗 **Trading Links:**
• 🌊 [Pump.fun](https://pump.fun/${tokenMint})
• 👽 [GMGN](https://gmgn.ai/sol/token/${tokenMint})
• 🐂 [BullX](https://neo.bullx.io/terminal?chainId=1399811149&address=${tokenMint})
• ⭐ [Photon](https://photon-sol.tinyastro.io/en/r/@Strobe/${tokenMint})
• 🌌 [Axiom](https://axiom.trade/t/${tokenMint})
• 🌊 [Raydium](https://raydium.io/swap/?inputCurrency=sol&outputCurrency=${tokenMint})
• 🔍 [Dexscreener](https://dexscreener.com/solana/${tokenMint})
• 🦅 [Birdeye](https://birdeye.so/token/${tokenMint}?chain=solana)

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
                await message.reply(`❌ No Pump.fun data found for token: \`${tokenMint}\``);
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