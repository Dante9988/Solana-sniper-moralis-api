import { Context, Markup } from 'telegraf';
import { jupiterService } from '../../services/jupiterService';
import { showMainMenu } from '../callbackHandlers';

export async function start(ctx: Context): Promise<void> {
  try {
    const userId = ctx.from?.id.toString();
    const firstName = ctx.from?.first_name || 'there';
    
    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return;
    }

    // Check if user already has a wallet
    const wallet = await jupiterService.getWallet(userId);
    
    // Create a direct access menu with all features
    await showMainMenu(ctx);
    
  } catch (error) {
    console.error('Start command error:', error);
    await ctx.reply('❌ An error occurred while starting the bot.');
  }
}

// Helper function to get formatted balance
async function getFormattedBalance(walletAddress: string): Promise<string> {
  try {
    // This would be replaced with actual balance fetching
    const solBalance = 0.25; // Mock SOL balance
    const usdValue = solBalance * 103; // Mock SOL price of $103
    return `${solBalance.toFixed(2)} SOL ($${usdValue.toFixed(2)} USD)`;
  } catch (error) {
    console.error('Error getting balance:', error);
    return '0.00 SOL ($0.00 USD)';
  }
} 