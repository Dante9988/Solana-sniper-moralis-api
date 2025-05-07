import { createCanvas, loadImage } from 'canvas';
import { Client, TextChannel, EmbedBuilder, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { Telegraf } from 'telegraf';
import { PrismaClient } from '@prisma/client';
import path from 'path';
import axios from 'axios';
import { getTokenMarketData } from './tokenDataService';
import { getTopPerformingTokens } from './tokenTrackingService';
import { getChannelConfig } from '../telegram/commands/toggleChannel';

const prisma = new PrismaClient();
const BACKGROUND_IMAGE = './src/services/purple.png';

/**
 * Interface for a token with performance metrics
 */
interface TopToken {
  tokenAddress: string;
  tokenName: string;
  tokenSymbol: string;
  initialMarketCap: number;
  currentMarketCap: number;
  growthPercentage: number;
  alertTimestamp: Date;
  checkTimestamp: Date | null;
}

/**
 * Main function to generate and send the daily top tokens report
 */
export async function generateDailyTopTokensReport(
  discordClient: Client,
  telegramBot: any,
  limit: number = 5
): Promise<void> {
  try {
    console.log(`🏆 Starting to generate daily top tokens report with limit: ${limit}`);
    
    // Fetch top performing tokens
    const topTokens = await getTopPerformingTokens(limit);
    
    if (!topTokens || topTokens.length === 0) {
      console.log('No top performing tokens found');
      return;
    }
    
    console.log(`Found ${topTokens.length} top performing tokens`);
    
    // Generate image with top tokens
    const reportImage = await createTopTokensImage(topTokens);
    
    // Send to Discord
    await sendDiscordTopTokensReport(discordClient, topTokens, reportImage);
    
    // Send to Telegram
    await sendTelegramTopTokensReport(telegramBot, topTokens, reportImage);
    
    console.log('✅ Daily top tokens report successfully sent to Discord and Telegram');
  } catch (error) {
    console.error('Error generating daily top tokens report:', error);
  }
}

/**
 * Creates an image visualizing the top performing tokens
 */
async function createTopTokensImage(tokens: TopToken[]): Promise<Buffer> {
  try {
    console.log('Creating top tokens image for', tokens.length, 'tokens');
    
    // Set up canvas
    const canvas = createCanvas(1200, 675);
    const ctx = canvas.getContext('2d');
    
    // Create a gradient background - dark purple to black
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, '#1a0b2e');
    gradient.addColorStop(1, '#000000');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Add subtle checkered pattern overlay
    ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
    const gridSize = 20;
    for (let i = 0; i < canvas.width; i += gridSize) {
      for (let j = 0; j < canvas.height; j += gridSize) {
        // Create a square pattern
        if ((i + j) % (gridSize * 2) === 0) {
          ctx.fillRect(i, j, gridSize, gridSize);
        }
      }
    }
    
    // Add title
    ctx.shadowColor = 'rgba(255, 100, 255, 0.7)';
    ctx.shadowBlur = 15;
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 52px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('Top results today for Strobe community', canvas.width / 2, 80);
    ctx.shadowBlur = 0;
    
    // Add date
    const today = new Date();
    ctx.font = '24px Arial';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.fillText(
      today.toLocaleDateString('en-US', { 
        weekday: 'long', 
        month: 'long', 
        day: 'numeric',
        year: 'numeric'
      }), 
      canvas.width / 2, 
      120
    );
    
    // Calculate card dimensions and positions
    const startY = 150;
    const cardHeight = 80;
    const cardSpacing = 20;
    const maxCards = Math.min(tokens.length, 5); // Display up to 5 cards
    
    // Track the position of the last card for footer positioning
    let lastCardBottomY = 0;
    
    // Loop through tokens and create individual cards for each
    for (let i = 0; i < maxCards; i++) {
      const token = tokens[i];
      const y = startY + (i * (cardHeight + cardSpacing));
      
      // Update the position of the last card
      lastCardBottomY = y + cardHeight;
      
      // Draw main card container with dark background
      const cardWidth = canvas.width - 100;
      const cardX = 50;
      
      // Card background
      ctx.fillStyle = 'rgba(20, 20, 30, 0.7)';
      // Rounded rectangle for card
      ctx.beginPath();
      const cornerRadius = 10;
      ctx.moveTo(cardX + cornerRadius, y);
      ctx.lineTo(cardX + cardWidth - cornerRadius, y);
      ctx.quadraticCurveTo(cardX + cardWidth, y, cardX + cardWidth, y + cornerRadius);
      ctx.lineTo(cardX + cardWidth, y + cardHeight - cornerRadius);
      ctx.quadraticCurveTo(cardX + cardWidth, y + cardHeight, cardX + cardWidth - cornerRadius, y + cardHeight);
      ctx.lineTo(cardX + cornerRadius, y + cardHeight);
      ctx.quadraticCurveTo(cardX, y + cardHeight, cardX, y + cardHeight - cornerRadius);
      ctx.lineTo(cardX, y + cornerRadius);
      ctx.quadraticCurveTo(cardX, y, cardX + cornerRadius, y);
      ctx.closePath();
      ctx.fill();
      
      // Add subtle border
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
      ctx.lineWidth = 1;
      ctx.stroke();
      
      // Draw rank and token name
      ctx.font = 'bold 32px Arial';
      ctx.fillStyle = '#FFFFFF';
      ctx.textAlign = 'left';
      ctx.fillText(`${i + 1}. $${token.tokenSymbol}`, cardX + 20, y + cardHeight/2 + 10);
      
      // Draw market cap information
      const mcX = cardX + 300;
      ctx.font = '24px Arial';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
      ctx.textAlign = 'center';
      ctx.fillText(`$${formatNumber(token.initialMarketCap)} → $${formatNumber(token.currentMarketCap)}`, mcX + 160, y + cardHeight/2 + 10);
      
      // Growth percentage in green card on the right
      const growthCardWidth = 150;
      const growthCardHeight = cardHeight * 0.9;
      const growthCardX = cardX + cardWidth - growthCardWidth - 20;
      const growthCardY = y + (cardHeight - growthCardHeight) / 2;
      
      // Draw growth percentage card with green gradient
      const growthGradient = ctx.createLinearGradient(
        growthCardX, 
        growthCardY, 
        growthCardX + growthCardWidth, 
        growthCardY
      );
      growthGradient.addColorStop(0, '#00a854'); // Darker green
      growthGradient.addColorStop(1, '#52c41a'); // Lighter green
      
      // Draw the green rounded rectangle for percentage
      ctx.beginPath();
      const growthRadius = 8;
      ctx.moveTo(growthCardX + growthRadius, growthCardY);
      ctx.lineTo(growthCardX + growthCardWidth - growthRadius, growthCardY);
      ctx.quadraticCurveTo(growthCardX + growthCardWidth, growthCardY, growthCardX + growthCardWidth, growthCardY + growthRadius);
      ctx.lineTo(growthCardX + growthCardWidth, growthCardY + growthCardHeight - growthRadius);
      ctx.quadraticCurveTo(growthCardX + growthCardWidth, growthCardY + growthCardHeight, growthCardX + growthCardWidth - growthRadius, growthCardY + growthCardHeight);
      ctx.lineTo(growthCardX + growthRadius, growthCardY + growthCardHeight);
      ctx.quadraticCurveTo(growthCardX, growthCardY + growthCardHeight, growthCardX, growthCardY + growthCardHeight - growthRadius);
      ctx.lineTo(growthCardX, growthCardY + growthRadius);
      ctx.quadraticCurveTo(growthCardX, growthCardY, growthCardX + growthRadius, growthCardY);
      ctx.closePath();
      
      ctx.fillStyle = growthGradient;
      ctx.fill();
      
      // Draw growth percentage on top of the green card
      ctx.font = 'bold 30px Arial';
      ctx.fillStyle = '#FFFFFF';
      ctx.textAlign = 'center';
      ctx.fillText(`+${token.growthPercentage.toFixed(2)}%`, growthCardX + growthCardWidth/2, growthCardY + growthCardHeight/2 + 10);
    }
    
    // Add "Powered by Moralis" text directly under the last card
    ctx.font = '20px Arial';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.textAlign = 'left';
    // Position it under the last token card with proper spacing
    ctx.fillText('Powered by Moralis', 70, lastCardBottomY + 35);
    
    // Add STROBE branding on the bottom-right
    ctx.shadowColor = 'rgba(255, 255, 255, 0.5)';
    ctx.shadowBlur = 15;
    ctx.font = 'bold 44px Arial';
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'right';
    // Position it at the same height as "Powered by Moralis"
    ctx.fillText('STROBE', canvas.width - 70, lastCardBottomY + 35);
    ctx.shadowBlur = 0;
    
    return canvas.toBuffer('image/png');
  } catch (error) {
    console.error('Error creating top tokens image:', error);
    throw error;
  }
}

/**
 * Sends the top tokens report to a Discord channel
 */
async function sendDiscordTopTokensReport(
  discordClient: Client, 
  tokens: TopToken[],
  reportImage: Buffer
): Promise<void> {
  try {
    console.log('Sending top tokens report to Discord...');
    
    // Try to get the channel ID from environment variables
    const channelId = process.env.DISCORD_TOP_TOKENS_CHANNEL_ID || process.env.DISCORD_CHANNEL_ID;
    
    if (!channelId) {
      console.error('⚠️ No Discord channel configured for top tokens reports. Please set DISCORD_TOP_TOKENS_CHANNEL_ID in your .env file.');
      console.log('Checking for any fallback channels...');
      
      // Try to find a general or test channel as fallback
      const possibleChannelIds = [
        process.env.DISCORD_CHANNEL_ID,
        process.env.PNL_DISCORD_CHANNEL_ID,
        process.env.DISCORD_PNL_SUMMARY_CHANNEL_ID
      ];
      
      // Find first available channel
      for (const id of possibleChannelIds) {
        if (id) {
          console.log(`Using fallback channel ${id}`);
          const fallbackChannel = discordClient.channels.cache.get(id) as TextChannel;
          if (fallbackChannel) {
            await sendTopTokensToChannel(fallbackChannel, tokens, reportImage);
            console.log(`✅ Discord top tokens report sent to fallback channel ${id}`);
            return;
          }
        }
      }
      
      console.error('❌ No suitable Discord channels found. Top tokens report will only be sent to Telegram.');
      return;
    }
    
    const channel = discordClient.channels.cache.get(channelId) as TextChannel;
    
    if (!channel) {
      console.error(`Discord channel with ID ${channelId} not found`);
      return;
    }
    
    await sendTopTokensToChannel(channel, tokens, reportImage);
    console.log('✅ Discord top tokens report sent successfully');
  } catch (error) {
    console.error('Error sending Discord top tokens report:', error);
  }
}

// Extract the channel sending logic to a separate function for reuse
async function sendTopTokensToChannel(
  channel: TextChannel,
  tokens: TopToken[],
  reportImage: Buffer
): Promise<void> {
  // Create main embed with the image
  const mainEmbed = new EmbedBuilder()
    .setColor('#9B59B6')
    .setTitle('🏆 Top results today for Strobe community')
    .setImage('attachment://top-tokens.png')
    .setTimestamp()
    .setFooter({ 
      text: 'STROBE | Powered by Moralis',
      iconURL: 'https://moralis.io/wp-content/uploads/2021/06/cropped-Moralis-Favicon-Glass.png'
    });
    
  // Send the message with image
  await channel.send({
    embeds: [mainEmbed],
    files: [{
      attachment: reportImage,
      name: 'top-tokens.png'
    }]
  });
  
  // Create a detailed embed with links and buttons for each token
  const detailsEmbed = new EmbedBuilder()
    .setColor('#9B59B6')
    .setDescription(createDetailsText(tokens));
    
  // Create buttons for common actions
  const row = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder()
        .setLabel('Pump.fun')
        .setStyle(ButtonStyle.Link)
        .setURL('https://pump.fun')
        .setEmoji('🌊'),
      new ButtonBuilder()
        .setLabel('Birdeye')
        .setStyle(ButtonStyle.Link)
        .setURL('https://birdeye.so/tokens/solana')
        .setEmoji('🦅'),
      new ButtonBuilder()
        .setLabel('Raydium')
        .setStyle(ButtonStyle.Link)
        .setURL('https://raydium.io/swap')
        .setEmoji('🔄')
    );
    
  await channel.send({ 
    embeds: [detailsEmbed],
    components: [row]
  });
}

/**
 * Create formatted details text for Discord embed
 */
function createDetailsText(tokens: TopToken[]): string {
  let detailsText = '**📊 Detailed Performance**\n━━━━━━━━━━━━━━━━━━━━━━\n\n';
  
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const growthPercent = token.growthPercentage.toFixed(2);
    
    // Add emojis based on growth percentage
    let performanceEmoji = '🚀';
    if (token.growthPercentage >= 500) performanceEmoji = '🚀🚀🚀';
    else if (token.growthPercentage >= 300) performanceEmoji = '🚀🚀';
    
    detailsText += `${performanceEmoji} **${i + 1}. $${token.tokenSymbol}** (\`${token.tokenAddress.slice(0, 6)}..${token.tokenAddress.slice(-4)}\`)\n`;
    detailsText += `• **Growth:** +${growthPercent}%\n`;
    detailsText += `• **Market Cap:** $${formatNumber(token.initialMarketCap)} → $${formatNumber(token.currentMarketCap)}\n`;
    detailsText += `• [View on Birdeye](https://birdeye.so/token/${token.tokenAddress}?chain=solana)\n\n`;
  }
  
  return detailsText;
}

/**
 * Sends the top tokens report to a Telegram channel
 */
async function sendTelegramTopTokensReport(
  telegramBot: any,
  tokens: TopToken[],
  reportImage: Buffer
): Promise<void> {
  try {
    console.log('Sending top tokens report to Telegram...');
    
    // Determine if we should send to test channel or main channel
    const channelConfig = getChannelConfig();
    const testChannelId = process.env.TELEGRAM_TEST_CHANNEL_ID;
    
    if (!channelConfig.channelId && !testChannelId) {
      console.error('No Telegram channel configured');
      return;
    }
    
    const targetChannelId = channelConfig.enabled 
      ? channelConfig.channelId 
      : testChannelId;
    
    if (!targetChannelId) {
      console.error('No enabled Telegram channel found');
      return;
    }
    
    // Create a more compact, well-formatted message text for use as caption
    const today = new Date().toLocaleDateString('en-US', { 
      weekday: 'long', 
      month: 'long', 
      day: 'numeric',
      year: 'numeric'
    });
    
    // Compact heading
    let messageText = `🏆 *Top results today for Strobe community - ${today}*\n\n`;
    
    // Show tokens in a more compact format that works well as a caption
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      messageText += `*${i + 1}. $${token.tokenSymbol}* (+${token.growthPercentage.toFixed(2)}%)\n`;
      messageText += `MC: $${formatNumber(token.initialMarketCap)} → $${formatNumber(token.currentMarketCap)}\n`;
      messageText += `[🔍](https://birdeye.so/token/${token.tokenAddress}?chain=solana)\n\n`;
    }
    
    // Add footer with branding
    messageText += `\n*Powered by STROBE* | Data from Moralis`;
    
    // Use the dedicated method for sending top calls reports
    if (telegramBot && typeof telegramBot.sendTopCallsReport === 'function') {
      await telegramBot.sendTopCallsReport(
        targetChannelId,
        reportImage,
        messageText
      );
      console.log(`✅ Telegram top tokens report sent successfully to channel ${targetChannelId}`);
    } else {
      console.error('Telegram bot not available or sendTopCallsReport method not found');
    }
  } catch (error) {
    console.error('Error sending Telegram top tokens report:', error);
  }
}

/**
 * Helper function to format numbers with K/M/B suffixes
 */
function formatNumber(value: number): string {
  if (value >= 1_000_000_000) {
    return (value / 1_000_000_000).toFixed(2) + 'B';
  } else if (value >= 1_000_000) {
    return (value / 1_000_000).toFixed(2) + 'M';
  } else if (value >= 1_000) {
    return (value / 1_000).toFixed(2) + 'K';
  } else {
    return value.toFixed(2);
  }
}

/**
 * Function to manually trigger the top tokens report
 */
export async function triggerTopTokensReport(
  discordClient: Client,
  telegramBot: any,
  limit: number = 5
): Promise<void> {
  console.log('🔄 Manually triggering top tokens report...');
  try {
    // Check if Discord client is ready
    if (!discordClient.isReady()) {
      console.log('Waiting for Discord client to be ready...');
      await new Promise(resolve => {
        const checkReady = () => {
          if (discordClient.isReady()) {
            resolve(true);
          } else {
            setTimeout(checkReady, 500);
          }
        };
        checkReady();
      });
    }

    // Get channel IDs for reporting status
    const discordChannelId = process.env.DISCORD_TOP_TOKENS_CHANNEL_ID || 
                             process.env.DISCORD_CHANNEL_ID ||
                             process.env.PNL_DISCORD_CHANNEL_ID;
    
    const telegramChannelId = process.env.TELEGRAM_CHANNEL_ID || 
                              process.env.TELEGRAM_TEST_CHANNEL_ID;
    
    // Generate the report
    await generateDailyTopTokensReport(discordClient, telegramBot, limit);
    
    // Provide detailed completion status
    console.log(`
    ✅ Top tokens report triggered successfully:
    • Discord channel: ${discordChannelId || 'Not configured'}
    • Telegram channel: ${telegramChannelId || 'Not configured'}
    • Number of tokens: ${limit}
    `);
  } catch (error) {
    console.error('❌ Failed to trigger top tokens report:', error);
  }
}

/**
 * Function to generate custom time range token report (from yesterday 12 AM EST until execution time)
 */
export async function generateCustomTimeRangeReport(
  discordClient: Client,
  telegramBot: any,
  limit: number = 5
): Promise<void> {
  try {
    console.log('🔄 Generating custom time range token report...');
    
    // Get current time in EST
    const now = new Date();
    const estNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    
    // Calculate yesterday 12 AM EST
    const yesterday = new Date(estNow);
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);
    
    // Convert back to UTC for database query
    const yesterdayUTC = new Date(yesterday.toLocaleString('en-US', { timeZone: 'UTC' }));
    
    console.log(`
    📅 Time Range for Report:
    • Start: ${yesterday.toLocaleString()} EST (${yesterdayUTC.toISOString()})
    • End: ${estNow.toLocaleString()} EST (${now.toISOString()})
    • Limit: ${limit} tokens
    `);
    
    // Fetch tokens within this time range
    const topTokens = await getTopPerformingTokensInTimeRange(
      yesterdayUTC,
      now,
      limit
    );
    
    if (!topTokens || topTokens.length === 0) {
      console.log('No top performing tokens found in specified time range');
      return;
    }
    
    console.log(`Found ${topTokens.length} top performing tokens in time range`);
    
    // Generate image with top tokens
    const reportImage = await createTopTokensImage(topTokens);
    
    // Send to Discord
    await sendDiscordTopTokensReport(discordClient, topTokens, reportImage);
    
    // Send to Telegram
    await sendTelegramTopTokensReport(telegramBot, topTokens, reportImage);
    
    console.log('✅ Custom time range token report successfully sent');
  } catch (error) {
    console.error('Error generating custom time range token report:', error);
  }
}

/**
 * Get top performing tokens within a specific time range
 */
export async function getTopPerformingTokensInTimeRange(
  startTime: Date,
  endTime: Date,
  limit: number = 5
): Promise<TopToken[]> {
  try {
    console.log(`🔍 Fetching top ${limit} tokens between ${startTime.toISOString()} and ${endTime.toISOString()}`);
    
    // Fetch tokens alerted within the time range from the database
    // and have been checked for PnL (have a current market cap)
    const tokens = await prisma.tokenAlert.findMany({
      where: {
        alertTimestamp: {
          gte: startTime,
          lte: endTime
        },
        checked: true,
        currentMarketCap: {
          not: null
        }
      },
      orderBy: {
        pnlPercentage: 'desc'
      },
      take: limit
    });
    
    console.log(`Found ${tokens.length} tokens with PnL data in the specified time range`);
    
    // Map to TopToken interface
    return tokens.map(token => ({
      tokenAddress: token.tokenAddress,
      tokenName: token.tokenName || 'Unknown',
      tokenSymbol: token.tokenSymbol || 'Unknown',
      initialMarketCap: token.initialMarketCap,
      currentMarketCap: token.currentMarketCap || token.initialMarketCap,
      growthPercentage: token.pnlPercentage || 0,
      alertTimestamp: token.alertTimestamp,
      checkTimestamp: token.checkTimestamp
    }));
  } catch (error) {
    console.error('Error fetching top tokens in time range:', error);
    return [];
  }
}

/**
 * Schedule the daily top tokens report to run at a specific time
 */
export function scheduleDailyTopTokensReport(
  discordClient: Client,
  telegramBot: any
): void {
  // Check every minute if it's time to send the report
  setInterval(async () => {
    try {
      const now = new Date();
      const estTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
      
      // Run report at 12:00 AM EST (midnight) for the previous day's performance
      const isReportTime = 
        // At midnight (this matches the daily summary time)
        (estTime.getHours() === 0 && estTime.getMinutes() === 0 && estTime.getSeconds() === 0) ||
        // And also at 9:00 AM for better coverage
        (estTime.getHours() === 9 && estTime.getMinutes() === 0 && estTime.getSeconds() === 0);
        
      if (isReportTime) {
        console.log(`🕒 Time to generate daily top tokens report! (EST time: ${estTime.toLocaleString()})`);
        
        // At midnight, daily summary will trigger both reports together
        // This is only used for the 9 AM report or if called independently
        if (estTime.getHours() !== 0) {
          await generateCustomTimeRangeReport(discordClient, telegramBot);
        }
      }
    } catch (error) {
      console.error('Error in scheduled top tokens report:', error);
    }
  }, 1000); // Check every second for precise timing
  
  console.log(`
  🔄 Scheduled daily top tokens report:
  • Report times: 12:00 AM EST (midnight - with daily summary) and 9:00 AM EST
  • Current EST time: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}
  `);
} 