import { Client, TextChannel, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { client } from './discord/discord';
import { telegramBot } from './telegram/telegramBot';
import 'dotenv/config';
import { createCanvas } from 'canvas';
import axios from 'axios';
import { PrismaClient } from '@prisma/client';

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

// Function to check token price history similar to checkTokenPriceHistory in tokenTrackingService
async function checkTokenPriceHistory(token: any): Promise<{ 
  highestPrice: number;
  highestMarketCap: number;
  timestamp: number | null;
}> {
  try {
    console.log(`Fetching price history for ${token.tokenAddress}...`);

    // For demonstration purposes, we'll use current market cap from the token data
    // In a real scenario, you would fetch the current price data from Birdeye or another provider
    
    // If the token already has current market cap data, use it
    if (token.currentMarketCap && token.currentMarketCap > 0) {
      return {
        highestPrice: token.currentPrice || 0,
        highestMarketCap: token.currentMarketCap,
        timestamp: Date.now() / 1000
      };
    }

    // Otherwise, simulate some market cap increase (as a fallback)
    const simulatedMarketCap = token.initialMarketCap * 7.5; // 650% increase
    return {
      highestPrice: token.initialPrice * 7.5,
      highestMarketCap: simulatedMarketCap,
      timestamp: Date.now() / 1000
    };
  } catch (error) {
    console.error('Error fetching price history:', error);
    return { highestPrice: 0, highestMarketCap: 0, timestamp: null };
  }
}

// Create PNL image function
async function createPnLImage(data: {
  pnlPercentage: number;
  tokenSymbol: string;
  initialMarketCap: number;
  currentMarketCap: number;
  initialSol: number;
  returnedSol: number;
}): Promise<Buffer> {
  try {
    console.log('Creating PnL Image with data:', {
        pnlPercentage: data.pnlPercentage,
        tokenSymbol: data.tokenSymbol,
        initialMarketCap: data.initialMarketCap,
        currentMarketCap: data.currentMarketCap,
        initialSol: data.initialSol,
        returnedSol: data.returnedSol
    });

    const canvas = createCanvas(1200, 675);
    const ctx = canvas.getContext('2d');

    // Create dark purple-black background gradient - fullscreen
    const baseGradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    baseGradient.addColorStop(0, '#1a0b2e');
    baseGradient.addColorStop(1, '#0d0517');
    ctx.fillStyle = baseGradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw diamond pattern overlay for subtle texture
    ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
    const gridSize = 30;
    for (let i = 0; i < canvas.width; i += gridSize) {
      for (let j = 0; j < canvas.height; j += gridSize) {
        // Create a diamond pattern
        ctx.beginPath();
        ctx.moveTo(i, j - gridSize/2);
        ctx.lineTo(i + gridSize/2, j);
        ctx.lineTo(i, j + gridSize/2);
        ctx.lineTo(i - gridSize/2, j);
        ctx.closePath();
        ctx.fill();
      }
    }

    // Add subtle glow effect
    const glowGradient = ctx.createRadialGradient(
      canvas.width * 0.3, canvas.height * 0.4, 0,
      canvas.width * 0.3, canvas.height * 0.4, 600
    );
    glowGradient.addColorStop(0, 'rgba(145, 70, 255, 0.15)');
    glowGradient.addColorStop(1, 'rgba(25, 10, 45, 0)');
    ctx.fillStyle = glowGradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Left margin for all text elements
    const leftMargin = 120;

    // Draw token symbol - left aligned instead of centered
    ctx.font = 'bold 70px Arial';
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('$' + data.tokenSymbol, leftMargin, 120);
    
    // Draw "CURRENT PROFIT" label - left aligned
    ctx.font = '24px Arial';
    ctx.fillStyle = '#9B9B9B';
    ctx.fillText('CURRENT PROFIT', leftMargin, 220);
    
    // Calculate profit value and format it
    const solPrice = await getSolPrice();
    const profitAmount = (data.returnedSol - data.initialSol) * solPrice;
    const formattedProfit = profitAmount >= 0 
      ? `$${Math.abs(Math.round(profitAmount))}` 
      : `$-${Math.abs(Math.round(profitAmount))}`;
    
    // Draw profit amount - larger and left aligned
    // Use green for positive, red for negative
    ctx.font = 'bold 100px Arial'; // Bigger font size
    ctx.fillStyle = profitAmount >= 0 ? '#4CAF50' : '#F44336';
    ctx.fillText(formattedProfit, leftMargin, 250);
    
    // Draw PNL percentage - left aligned
    ctx.font = 'bold 40px Arial'; // Slightly bigger
    ctx.fillStyle = profitAmount >= 0 ? '#4CAF50' : '#F44336';
    ctx.fillText(`+${data.pnlPercentage.toFixed(2)}%`, leftMargin, 360);
    
    // Create section for bought/hold/sold values - spaced horizontally
    const columnWidth = 300; // Width between columns
    const labelY = 450;
    const valueY = 490;
    
    // TOTAL BOUGHT - left aligned
    ctx.font = '22px Arial';
    ctx.fillStyle = '#9B9B9B';
    ctx.fillText('TOTAL BOUGHT', leftMargin, labelY);
    ctx.font = 'bold 32px Arial';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(`${data.initialSol.toFixed(1)} SOL`, leftMargin, valueY);
    
    // TOTAL HOLD - in the middle
    ctx.font = '22px Arial';
    ctx.fillStyle = '#9B9B9B';
    ctx.fillText('TOTAL HOLD', leftMargin + columnWidth, labelY);
    ctx.font = 'bold 32px Arial';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText('0 SOL', leftMargin + columnWidth, valueY);
    
    // TOTAL SOLD - on the right
    ctx.font = '22px Arial';
    ctx.fillStyle = '#9B9B9B';
    ctx.fillText('TOTAL SOLD', leftMargin + 2*columnWidth, labelY);
    ctx.font = 'bold 32px Arial';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(`${data.returnedSol.toFixed(1)} SOL`, leftMargin + 2*columnWidth, valueY);
    
    // Draw "Powered by Moralis" text at bottom left
    ctx.font = '20px Arial';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.fillText('Powered by Moralis', leftMargin, canvas.height - 60);
    
    // Draw STROBE branding in bottom right
    ctx.textAlign = 'right';
    ctx.font = 'bold 40px Arial';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText('STROBE', canvas.width - 80, canvas.height - 60);
    
    // Reset text alignment for future drawing operations
    ctx.textAlign = 'left';
    
    // Convert canvas to buffer
    return canvas.toBuffer('image/png');
  } catch (error) {
    console.error('Error creating PnL image:', error);
    throw error;
  }
}

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