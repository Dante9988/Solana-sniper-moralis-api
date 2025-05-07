import { Telegraf } from 'telegraf';
import { getChannelConfig } from './commands/toggleChannel';
import { PrismaClient } from '@prisma/client';
import { jupiterService } from '../services/jupiterService';

const prisma = new PrismaClient();

/**
 * Send a token alert to the configured Telegram channel and private chats, respecting user and channel preferences
 */
export async function sendTokenAlert(
  bot: Telegraf,
  tokenAddress: string,
  tokenName: string,
  tokenSymbol: string,
  liquidityInSol: number,
  buyLink: string,
  isMigrationToken: boolean = false,
  marketCap?: string,
  volume24h?: string,
  bundles?: string,
  percentage?: string,
  solSpent?: string,
  securityStatus: string = "PASSED"
): Promise<void> {
  try {
    console.log(`📱 TELEGRAM/alerts: Starting token alert process for ${tokenAddress}`);
    
    // Check if the bot parameter is valid
    if (!bot) {
      console.error('📱 TELEGRAM/alerts: ❌ Bot object is null or undefined');
      return;
    }
    
    // Check if telegram.sendMessage exists
    if (!bot.telegram || typeof bot.telegram.sendMessage !== 'function') {
      console.error('📱 TELEGRAM/alerts: ❌ bot.telegram.sendMessage is not a function');
      return;
    }
    
    // Check if this is a Pump.fun token, just like Discord's implementation
    const isPumpToken = tokenAddress.toLowerCase().endsWith('pump');
    
    // Only proceed if this is a Pump.fun token
    if (!isPumpToken) {
      console.log(`📱 TELEGRAM/alerts: ⏭️ Skipping Telegram alert for non-Pump.fun token: ${tokenAddress}`);
      return;
    }
    
    console.log(`📱 TELEGRAM/alerts: Sending Telegram alert for Pump.fun token: ${tokenAddress}`);
    console.log(`📱 TELEGRAM/alerts: Is migration token: ${isMigrationToken}`);

    // Format liquidity
    const formattedLiquidity = liquidityInSol >= 1000 
      ? `${(liquidityInSol / 1000).toFixed(2)}K` 
      : liquidityInSol.toFixed(2);

    // Build alert message
    const alertMessage = `
🚀 *New Token Launch Detected: ${tokenSymbol}*

*Token*: \`${tokenAddress}\`

📊 *Market Analysis*
💰 Market Cap: ${marketCap || 'Unknown'}
💧 Liquidity: ${formattedLiquidity} SOL
📈 24H Volume: ${volume24h || 'Unknown'}

🎯 *Quick Stats*
📦 Bundles: ${bundles || 'Unknown'}
📊 Percentage: ${percentage || 'Unknown'}
💵 SOL Spent: ${solSpent || 'Unknown'}
🛡️ Security: ✅ ${securityStatus}

⚠️ *DYOR - Trade at your own risk*

${isPumpToken ? '*Type*: 📊 Pump.fun Token' : ''}
${isMigrationToken ? '🔄 *This appears to be a migration token!*' : ''}

🔗 *Actions:*
• /buy ${tokenAddress} - Buy with your configured settings
• ${buyLink}
`;

    // 1. Send to channel if enabled
    const channelConfig = getChannelConfig();
    console.log(`📱 TELEGRAM/alerts: Channel config:`, channelConfig);
    
    if (channelConfig.channelId && channelConfig.enabled) {
      try {
        console.log(`📱 TELEGRAM/alerts: Attempting to send to channel: ${channelConfig.channelId}`);
        await bot.telegram.sendMessage(channelConfig.channelId, alertMessage, {
          parse_mode: 'Markdown',
          disable_web_page_preview: true
        } as any);
        console.log(`📱 TELEGRAM/alerts: ✅ Alert successfully sent to channel ${channelConfig.channelId} for token ${tokenAddress}`);
      } catch (error) {
        console.error(`📱 TELEGRAM/alerts: ❌ Error sending alert to channel ${channelConfig.channelId}:`, error);
      }
    } else {
      console.log(`📱 TELEGRAM/alerts: ❌ Channel alert not sent: channelId=${channelConfig.channelId}, enabled=${channelConfig.enabled}`);
    }

    // 2. Send to private chats based on user preferences
    // Get all user preferences
    console.log(`📱 TELEGRAM/alerts: Attempting to fetch user preferences from database`);
    const userPrefs = await prisma.userPreference.findMany();
    
    // Log how many users we're checking
    console.log(`📱 TELEGRAM/alerts: Checking ${userPrefs.length} users for Pump.fun token alerts`);
    
    for (const user of userPrefs) {
      try {
        // For Pump.fun tokens, check pumpSwapEnabled
        if (user.pumpSwapEnabled) {
          console.log(`📱 TELEGRAM/alerts: Sending alert to user ${user.userId} who has pumpSwapEnabled=true`);
          await bot.telegram.sendMessage(user.userId, alertMessage, {
            parse_mode: 'Markdown',
            disable_web_page_preview: true
          } as any);
          console.log(`📱 TELEGRAM/alerts: ✅ Alert sent to user ${user.userId} (Pump.fun token)`);
        } else {
          console.log(`📱 TELEGRAM/alerts: ⏭️ User ${user.userId} has pumpSwapEnabled=false, skipping`);
        }
      } catch (error) {
        console.error(`📱 TELEGRAM/alerts: ❌ Error sending alert to user ${user.userId}:`, error);
      }
    }
    
    console.log(`📱 TELEGRAM/alerts: ✅ Completed sending alerts for token ${tokenAddress}`);
  } catch (error) {
    console.error(`📱 TELEGRAM/alerts: 💥 Error in sendTokenAlert function:`, error);
  }
}

/**
 * Send a PNL report for a specific token
 */
export async function sendPnlReport(
  bot: Telegraf,
  userId: string, 
  tokenAddress: string,
  tokenName: string,
  tokenSymbol: string,
  pnl: number,
  pnlPercentage: number,
  currentPrice: number
): Promise<void> {
  try {
    // Format PNL message
    const pnlEmoji = pnl >= 0 ? '🟢' : '🔴';
    const pnlSign = pnl >= 0 ? '+' : '';
    
    const alertMessage = `
${pnlEmoji} *PNL UPDATE: ${tokenSymbol}* ${pnlEmoji}

*Token*: ${tokenName} (${tokenSymbol})
*Address*: \`${tokenAddress}\`
*Current Price*: ${currentPrice.toFixed(8)} SOL
*PNL*: ${pnlSign}${pnl.toFixed(3)} SOL (${pnlSign}${pnlPercentage.toFixed(2)}%)

🔗 *Actions:*
• /sell ${tokenAddress} 100 - Sell all tokens
• https://birdeye.so/token/${tokenAddress}?chain=solana - View on Birdeye
`;

    // Send message to user
    await bot.telegram.sendMessage(userId, alertMessage, { 
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    } as any);
    
    // Get channel config from both env vars and in-memory storage
    const channelConfig = getChannelConfig();
    
    console.log(channelConfig);

    console.log("===========================")
    console.log(channelConfig.channelId);
    console.log(channelConfig.enabled);
    console.log("===========================")
    // Send to channel if configured
    if (channelConfig.channelId && channelConfig.enabled) {
      try {
        await bot.telegram.sendMessage(channelConfig.channelId, alertMessage, {
          parse_mode: 'Markdown',
          disable_web_page_preview: true
        } as any);
        console.log(`PNL alert sent to channel ${channelConfig.channelId}`);
      } catch (error) {
        console.error(`Error sending PNL alert to channel ${channelConfig.channelId}:`, error);
      }
    }
  } catch (error) {
    console.error(`Error sending PNL report to user ${userId}:`, error);
  }
} 