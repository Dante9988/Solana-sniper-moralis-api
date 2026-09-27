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

// A local `getFormattedBalance` used to live here, returning a hardcoded 0.25 SOL at a made-up
// $103/SOL — a fabricated balance AND a fabricated price. Nothing in this file ever called it, so
// it is deleted rather than repointed. The real implementation, which reads the balance on chain and
// reports no USD figure (Phase 7E.4.3 §10), is exported from ../showWalletMenu. 