import { Telegraf } from 'telegraf';
import { PrismaClient } from '@prisma/client';
import { sniperooService } from '../services/sniperooService';

// Create a Prisma client instance
const prisma = new PrismaClient();

/**
 * Send a token alert to a specific user
 */
export async function sendTokenAlert(
  bot: Telegraf,
  userId: string,
  tokenAddress: string,
  tokenName: string,
  tokenSymbol: string,
  liquidityInSol: number,
  buyLink: string
): Promise<void> {
  try {
    // Check if user has PumpSwap notifications enabled
    const userPreference = await prisma.userPreference.findUnique({
      where: { userId }
    });

    // If preference isn't found or PumpSwap is disabled, don't send
    if (!userPreference || !userPreference.pumpSwapEnabled) {
      return;
    }

    // Get user's config to see if they have auto-buy enabled
    const userConfig = await sniperooService.getUserConfig(userId);
    if (!userConfig) {
      console.warn(`No config found for user ${userId}, skipping alert`);
      return;
    }

    // Format liquidity
    const formattedLiquidity = liquidityInSol >= 1000 
      ? `${(liquidityInSol / 1000).toFixed(2)}K` 
      : liquidityInSol.toFixed(2);

    // Create alert message
    const alertMessage = `
🚨 *NEW TOKEN DETECTED* 🚨

*Token*: ${tokenName} (${tokenSymbol})
*Address*: \`${tokenAddress}\`
*Liquidity*: ${formattedLiquidity} SOL

${userConfig.autoBuy ? '✅ Auto-buy has been triggered!' : ''}

🔗 *Actions:*
• /buy ${tokenAddress} - Buy with your configured settings
• ${buyLink}
`;

    // Send message to user
    await bot.telegram.sendMessage(userId, alertMessage, { 
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    });

    // If auto-buy is enabled, execute the purchase
    if (userConfig.autoBuy) {
      await sniperooService.buyToken(tokenAddress, userId);
    }
  } catch (error) {
    console.error(`Error sending token alert to user ${userId}:`, error);
  }
} 