import { Client, TextChannel, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { client } from './discord/discord';
import { telegramBot } from './telegram/telegramBot';
import 'dotenv/config';
import { createCanvas } from 'canvas';
import axios from 'axios';
import { PrismaClient } from '@prisma/client';
import { createPnLImage } from './services/pnlImage';

// Initialize Prisma client
const prisma = new PrismaClient();

// Helper function to get SOL price
async function getSolPrice(): Promise<number> {
  try {
    const response = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
      { timeout: 5000 }
    );
    
    if (response.data && response.data.solana && response.data.solana.usd) {
      console.log(`Current SOL price: $${response.data.solana.usd}`);
      return response.data.solana.usd;
    }
    
    // Fallback to a reasonable default if API fails
    console.warn('Could not get SOL price from CoinGecko, using fallback price');
    return 170; // Default fallback price
  } catch (error) {
    console.error('Error fetching SOL price:', error);
    return 170;
  }
}

/**
 * Resolve a token's observed market cap.
 *
 * This function used to fabricate a 7.5x (650%) gain whenever `currentMarketCap` was
 * missing, and the caller then turned that invented number into a PnL percentage, a
 * shareable PnL card and a Discord/Telegram post. A token nobody had priced would be
 * broadcast as a 650% winner.
 *
 * Missing market data now yields no market cap, which the caller treats as "skip". It
 * must never produce a PnL, a multiple, a callout, a card, a notification, or AI
 * evidence. Returning zeros is the contract the caller already checks for.
 */
async function checkTokenPriceHistory(token: any): Promise<{
  highestPrice: number;
  highestMarketCap: number;
  timestamp: number | null;
}> {
  try {
    console.log(`Resolving observed market cap for ${token.tokenAddress}...`);

    if (token.currentMarketCap && token.currentMarketCap > 0) {
      return {
        highestPrice: token.currentPrice || 0,
        highestMarketCap: token.currentMarketCap,
        timestamp: Date.now() / 1000
      };
    }

    // No observed market cap. Do not estimate, extrapolate or simulate one.
    console.log(
      `No observed market cap for ${token.tokenAddress} — skipping. PnL is never derived from estimated data.`
    );
    return { highestPrice: 0, highestMarketCap: 0, timestamp: null };
  } catch (error) {
    console.error('Error resolving market cap:', error);
    return { highestPrice: 0, highestMarketCap: 0, timestamp: null };
  }
}

// Create PNL image function

// Helper function to draw rounded rectangles
function roundedRect(ctx: any, x: number, y: number, width: number, height: number, radius: number) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
  ctx.fill();
}

/**
 * This function fetches the last token from the database and sends a PNL alert
 */
async function sendPnLTest() {
  try {
    console.log('🔍 Starting PNL check test with latest token from DB...');

    // Fetch the most recent token from the database
    const latestToken = await prisma.tokenAlert.findFirst({
      orderBy: {
        alertTimestamp: 'desc'
      }
    });

    if (!latestToken) {
      console.error('❌ No tokens found in database');
      process.exit(1);
    }

    console.log(`📊 Using latest token from database: ${latestToken.tokenAddress} (${latestToken.tokenSymbol || 'Unknown Symbol'})`);

    // Get the price history data
    const priceData = await checkTokenPriceHistory(latestToken);
    
    if (priceData.highestMarketCap === 0) {
      console.error(`❌ No price data found for ${latestToken.tokenAddress}`);
      process.exit(1);
    }

    // Calculate PnL percentage based on market caps (same logic as in checkTokenPnL)
    const pnlPercentage = ((priceData.highestMarketCap - latestToken.initialMarketCap) / latestToken.initialMarketCap) * 100;

    console.log(`
    Token PNL Details:
    • Address: ${latestToken.tokenAddress}
    • Symbol: ${latestToken.tokenSymbol || 'Unknown'}
    • Initial MC: $${latestToken.initialMarketCap.toLocaleString()}
    • Highest MC: $${priceData.highestMarketCap.toLocaleString()}
    • PnL: ${pnlPercentage.toFixed(2)}%
    `);

    // Calculate profit in SOL (same as in checkTokenPnL)
    const initialSolInvestment = 1.000;
    const returnedSol = initialSolInvestment + (initialSolInvestment * (pnlPercentage / 100));
    
    // Create the PNL image
    console.log('🖼️ Generating PnL image...');
    const pnlImage = await createPnLImage({
      pnlPercentage: pnlPercentage,
      tokenSymbol: latestToken.tokenSymbol || 'TOKEN',
      initialMarketCap: latestToken.initialMarketCap,
      currentMarketCap: priceData.highestMarketCap,
      initialSol: initialSolInvestment,
      returnedSol
    });
    console.log('✅ PnL image generated successfully');

    // Send to Discord
    await sendDiscordPnLTest(pnlImage, latestToken.tokenAddress, latestToken.tokenSymbol || 'TOKEN', pnlPercentage);
    
    // Send to Telegram
    await sendTelegramPnLTest(pnlImage, latestToken.tokenAddress, latestToken.tokenSymbol || 'TOKEN', pnlPercentage);
    
    console.log('✨ PnL test completed successfully');

    // Close Prisma connection
    await prisma.$disconnect();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error in PnL test:', error);
    // Ensure Prisma connection is closed
    await prisma.$disconnect();
    process.exit(1);
  }
}

/**
 * Sends the PNL image to Discord
 */
async function sendDiscordPnLTest(
  pnlImage: Buffer, 
  tokenAddress: string, 
  tokenSymbol: string, 
  pnlPercentage: number
) {
  try {
    console.log('🎮 DISCORD: Sending PNL test...');
    
    // Get PNL channel from environment variables
    const pnlChannelId = process.env.PNL_DISCORD_CHANNEL_ID;
    if (!pnlChannelId) {
      console.error('❌ DISCORD: PNL_DISCORD_CHANNEL_ID not set in environment variables');
      return;
    }
    
    // Ensure Discord client is ready
    if (!client.isReady()) {
      console.log('⏳ DISCORD: Waiting for client to be ready...');
      await new Promise<void>((resolve) => {
        const readyHandler = () => {
          client.removeListener('ready', readyHandler);
          resolve();
        };
        client.on('ready', readyHandler);
        
        // If client is already ready, resolve immediately
        if (client.isReady()) {
          resolve();
        }
        
        // Timeout after 10 seconds
        setTimeout(() => {
          console.error('❌ DISCORD: Client failed to become ready in time');
          resolve();
        }, 10000);
      });
    }
    
    // Get the channel
    const channel = await client.channels.fetch(pnlChannelId);
    if (!channel) {
      console.error(`❌ DISCORD: Channel with ID ${pnlChannelId} not found`);
      return;
    }
    
    // Check if it's a text channel and send the image
    if (channel instanceof TextChannel) {
      // Create embed with modern design
      const embed = new EmbedBuilder()
        .setColor('#9B59B6')
        .setImage('attachment://pnl-background.png')
        .setDescription(`:rocket: **PNL ALERT: $${tokenSymbol}** - Growth: **+${pnlPercentage.toFixed(2)}%**\n\n:link: Contract: \`${tokenAddress}\`\n\n[Trade Now](https://birdeye.so/token/${tokenAddress}?chain=solana)`)
        .setFooter({ 
          text: `Referral Code: ${tokenAddress.slice(0, 6)}` 
        });

      // Send message with embed
      await channel.send({ 
        files: [{
          attachment: pnlImage,
          name: 'pnl-background.png'
        }],
        embeds: [embed]
      });
      
      console.log('✅ DISCORD: PNL test image sent successfully');
    } else {
      console.error(`❌ DISCORD: Channel with ID ${pnlChannelId} is not a text channel`);
    }
  } catch (error) {
    console.error('❌ DISCORD: Error sending PNL test to Discord:', error);
  }
}

/**
 * Sends the PNL image to Telegram
 */
async function sendTelegramPnLTest(
  pnlImage: Buffer, 
  tokenAddress: string, 
  tokenSymbol: string, 
  pnlPercentage: number
) {
  try {
    console.log('📱 TELEGRAM: Sending PNL test...');
    
    // Make sure Telegram bot is initialized
    if (!(telegramBot as any).isInitialized) {
      console.log('📱 TELEGRAM: Bot not initialized, initializing now...');
      await telegramBot.initialize();
    }
    
    // Get channel config from Telegram module
    const { getChannelConfig } = await import('./telegram/commands/toggleChannel');
    const channelConfig = getChannelConfig();
    
    if (!channelConfig.channelId || !channelConfig.enabled) {
      console.error('❌ TELEGRAM: Channel not configured or not enabled');
      return;
    }
    
    // Send PNL image
    await telegramBot.sendPnLAlertWithImage(
      channelConfig.channelId,
      tokenAddress,
      tokenSymbol,
      pnlPercentage,
      pnlImage
    );
    
    console.log('✅ TELEGRAM: PNL test image sent successfully to channel', channelConfig.channelId);
  } catch (error) {
    console.error('❌ TELEGRAM: Error sending PNL test to Telegram:', error);
  }
}

// Run the PNL test
console.log('🚀 Starting PNL UI verification test with real data');
sendPnLTest(); 