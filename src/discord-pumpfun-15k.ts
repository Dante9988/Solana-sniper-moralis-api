import { Connection, PublicKey } from "@solana/web3.js";
import WebSocket from "ws";
import axios from "axios";
import dotenv from "dotenv";
import { PUMP_FUN_PROGRAM } from "./constants";
import { PrismaClient } from '@prisma/client';
import { fetchTokenMintFromTx } from "./transactions";
import { Client, GatewayIntentBits, TextChannel, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

dotenv.config();
const prisma = new PrismaClient();

const RPC_ENDPOINT = process.env.RPC_ENDPOINT_15K || "";
const connection = new Connection(RPC_ENDPOINT, "confirmed");

// Initialize Discord client
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
let channel: TextChannel | null = null;

client.once('ready', () => {
    console.log('🤖 Pump.fun 15k Discord bot is ready!');
    const channelId = process.env.PUMPFUN_15K_DISCORD_CHANNEL_ID;
    console.log('Channel ID from env:', channelId);
    
    if (channelId) {
        channel = client.channels.cache.get(channelId) as TextChannel;
        if (channel) {
            console.log('✅ Successfully connected to channel:', channel.name);
        } else {
            console.log('❌ Could not find channel with ID:', channelId);
        }
    } else {
        console.log('❌ No channel ID found in .env file');
    }
});

client.login(process.env.DISCORD_BOT_TOKEN);

function createProgressBar(percent: number): string {
    // Convert percent (e.g., 0.44%) to a 0-1 range
    const normalized = percent / 100;

    // Calculate the number of filled blocks in a 20-block bar
    const totalBlocks = 20;
    const filled = Math.round(normalized * totalBlocks); // Use round for better distribution
    const empty = totalBlocks - filled;

    return '█'.repeat(filled) + '░'.repeat(empty) + ` ${percent.toFixed(2)}%`;
}

// Store new token in DB
async function storeNewToken(tokenMint: string) {
    try {
        await prisma.pumpFunToken.create({
            data: {
                mint: tokenMint,
                createdAt: new Date(),
                alerted: false
            }
        });
        console.log(`📝 Stored new token: ${tokenMint}`);
    } catch (error) {
        console.error("❌ Failed to store token:", error);
    }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchWithRetry(url: string, maxRetries = 5): Promise<any> {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await axios.get(url);
            return response.data;
        } catch (error: any) {
            if (error.response?.status === 429) {
                console.log(`Rate limited (attempt ${i + 1}/${maxRetries}), waiting 10 seconds...`);
                await sleep(10000); // Wait 10 seconds
                continue;
            }
            throw error;
        }
    }
    throw new Error(`Failed after ${maxRetries} retries`);
}

// Add rate limit handling utility
async function processWithRateLimit<T>(items: T[], processFn: (item: T) => Promise<void>, delayMs = 2000) {
    for (const item of items) {
        try {
            await processFn(item);
            // Add delay between requests
            await sleep(delayMs);
        } catch (error: any) {
            if (error.response?.status === 429) {
                console.log('Rate limit hit, waiting 10 seconds...');
                await sleep(10000); // Wait longer on rate limit
                try {
                    await processFn(item); // Retry once
                } catch (retryError) {
                    console.error(`Failed retry for item:`, retryError);
                }
            } else {
                console.error(`Error processing item:`, error);
            }
        }
    }
}

// Check market caps of tracked tokens
async function checkTokenMarketCaps() {
    try {
        // Get tokens in smaller batches
        const batchSize = 5;
        const tokens = await prisma.pumpFunToken.findMany({
            where: { alerted: false },
            take: batchSize // Process only 5 tokens at a time
        });

        await processWithRateLimit(tokens, async (token: { mint: string }) => {
            const tokenData = await fetchWithRetry(`https://frontend-api-v3.pump.fun/coins/${token.mint}`);
            const marketCap = Number(tokenData.usd_market_cap);

            if (marketCap >= 15000) {
                await sendPumpFunAlert(token.mint);
                await prisma.pumpFunToken.update({
                    where: { mint: token.mint },
                    data: { alerted: true }
                });
                console.log(`✅ Marked token ${token.mint} as alerted`);
            }
        });

    } catch (error) {
        console.error("❌ Error checking market caps:", error);
    }
}

// WebSocket for new token creation
const GEYSER_RPC = process.env.GEYSER_RPC || "";
if (!GEYSER_RPC) throw new Error("Missing Geyser RPC!");

const ws = new WebSocket(GEYSER_RPC);

ws.on("open", () => {
    console.log("🚀 Listening for new Pump.fun tokens...");
    ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "logsSubscribe",
        params: [
            { mentions: [PUMP_FUN_PROGRAM] },
            { commitment: "processed" }
        ]
    }));
});

ws.on("message", async (data) => {
    try {
        const message = JSON.parse(data.toString("utf8"));

        if (message.result !== undefined) {
            console.log("✅ Subscribed to Pump.fun!");
            return;
        }

        const logs = message.params?.result?.value?.logs;
        if (!logs || !logs.some((log: string) => log.includes("Program log: Instruction: InitializeMint2"))) {
            return;
        }

        const signature = message.params.result.value.signature;
        const txData = await fetchTokenMintFromTx(signature, connection);
        
        if (txData?.tokenMint) {
            await storeNewToken(txData.tokenMint);
        }

    } catch (error) {
        console.error("💥 Error processing message:", error);
    }
});

// Check market caps every 2 seconds
const CHECK_INTERVAL = 20000;
setInterval(checkTokenMarketCaps, CHECK_INTERVAL);

// Initial market cap check
checkTokenMarketCaps();

async function getBondingCurveData(tokenMint: string) {
    try {
        const [bondingCurvePDA] = PublicKey.findProgramAddressSync(
            [
                Buffer.from("bonding-curve"),
                new PublicKey(tokenMint).toBuffer()
            ],
            new PublicKey(PUMP_FUN_PROGRAM)
        );

        const bondingCurveAccount = await connection.getAccountInfo(bondingCurvePDA);
        
        if (!bondingCurveAccount) {
            throw new Error("Bonding curve account not found");
        }

        // Parse account data based on the IDL structure
        const virtualTokenReserves = bondingCurveAccount.data.readBigUInt64LE(8);
        const virtualSolReserves = bondingCurveAccount.data.readBigUInt64LE(16);
        const realTokenReserves = bondingCurveAccount.data.readBigUInt64LE(24);
        const realSolReserves = bondingCurveAccount.data.readBigUInt64LE(32);
        const tokenTotalSupply = bondingCurveAccount.data.readBigUInt64LE(40);
        const complete = bondingCurveAccount.data.readUInt8(48) === 1;

        return {
            virtualTokenReserves: Number(virtualTokenReserves),
            virtualSolReserves: Number(virtualSolReserves),
            realTokenReserves: Number(realTokenReserves),
            realSolReserves: Number(realSolReserves),
            tokenTotalSupply: Number(tokenTotalSupply),
            complete
        };
    } catch (error) {
        console.error("Error fetching bonding curve data:", error);
        return null;
    }
}

// Update the sendPumpFunAlert function to use on-chain data
async function sendPumpFunAlert(tokenMint: string) {
    try {
        // Check if token has already been alerted
        const existingToken = await prisma.pumpFunToken.findUnique({
            where: { mint: tokenMint }
        });

        if (existingToken?.alerted) {
            console.log(`⏭️ Token ${tokenMint} already alerted, skipping...`);
            return;
        }

        const tokenData = await fetchWithRetry(`https://frontend-api-v3.pump.fun/coins/${tokenMint}`);
        const token = tokenData;

        // Get on-chain bonding curve data
        const bondingCurveData = await getBondingCurveData(tokenMint);
        
        let bondingPercent = 0;
        if (bondingCurveData) {
            // Cap at 100%
            bondingPercent = Math.min(bondingCurveData.virtualTokenReserves / bondingCurveData.tokenTotalSupply, 1);
        } else {
            // Cap at 100%
            bondingPercent = Math.min(Number(token.virtual_token_reserves) / Number(token.total_supply), 1);
        }

        const progressBar = createProgressBar(bondingPercent);

        const message = {
            content: '🎯 **NEW PUMP.FUN TOKEN IN 15K RANGE** 🎯',
            embeds: [{
                color: 0x00FF00,
                title: `💎 New Token Alert: ${token.symbol}`,
                description: `
\`\`\`
Token: ${tokenMint}
Creator: ${token.creator}
\`\`\`

${token.description ? `📝 **Description:** ${token.description}` : '📝 **Description:** No description found'}

📊 **Token Metrics**
💵 Price: $${token.price || '0.000000'}
💰 Market Cap: $${token.usd_market_cap.toFixed(2)}
💧 Liquidity: $${token.liquidity || '0.00'}
📈 Total Supply: ${token.total_supply}

⚡ **Bonding Curve**
${progressBar}

🔒 Bonding Complete: ${token.complete ? 'Yes ✅' : 'No ❌'}

${token.website ? `🌐 **Website:** ${token.website}\n` : ''}${token.twitter ? `🐦 **Twitter:** ${token.twitter}\n` : ''}${token.telegram ? `💬 **Telegram:** ${token.telegram}` : ''}`,
                thumbnail: {
                    url: token.image_uri || 'https://pump.fun/logo.png'
                },
                footer: {
                    text: `🌟 Created at ${new Date(token.created_timestamp).toLocaleString('en-US', {
                        timeZone: 'America/New_York',
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                        hour12: true
                    })} EST • 🕒 Detected at ${new Date().toLocaleString('en-US', {
                        timeZone: 'America/New_York',
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                        hour12: true
                    })} EST`,
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

        // Send to Discord
        if (!channel) {
            throw new Error('Discord channel not found');
        }
        await channel.send(message);
        console.log(`✅ 15K Range Alert sent for token: ${tokenMint}`);

        // After successful alert, update the alerted status
        await prisma.pumpFunToken.update({
            where: { mint: tokenMint },
            data: { alerted: true }
        });
        
        console.log(`✅ Alert sent and marked token ${tokenMint} as alerted`);

    } catch (error) {
        console.error('❌ Failed to send Discord message:', error);
    }
}

// Add this function
async function cleanupOldTokens() {
    try {
        const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
        
        const deletedCount = await prisma.pumpFunToken.deleteMany({
            where: {
                createdAt: {
                    lt: thirtyMinutesAgo
                }
            }
        });
        
        if (deletedCount.count > 0) {
            console.log(`🧹 Cleaned up ${deletedCount.count} tokens older than 30 minutes`);
        }
    } catch (error) {
        console.error('❌ Error cleaning up old tokens:', error);
    }
}

// Add this after client initialization
// Run cleanup every 5 minutes
setInterval(cleanupOldTokens, 5 * 60 * 1000);

// Run initial cleanup on startup
cleanupOldTokens();
