import { Context } from 'telegraf';
import { jupiterService } from '../../services/jupiterService';

export async function toggleJito(ctx: Context): Promise<void> {
  try {
    const userId = ctx.from?.id.toString();
    
    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return;
    }

    // Check if user has a wallet
    const wallet = await jupiterService.getWallet(userId);
    if (!wallet) {
      await ctx.reply('❌ You need to create or import a wallet first.\nUse /wallet create <name> or /wallet import <private_key>');
      return;
    }

    // Toggle Jito integration
    const jitoEnabled = await jupiterService.toggleJito(userId);
    
    // Send confirmation message
    await ctx.reply(
      `✅ Jito MEV protection is now ${jitoEnabled ? 'enabled' : 'disabled'}!\n\n` +
      `${jitoEnabled 
        ? '🛡️ Your transactions will now use Jito for faster execution and MEV protection.' 
        : '⚠️ Your transactions will now use standard Solana RPC without MEV protection.'}`,
      { parse_mode: 'HTML' }
    );
  } catch (error) {
    console.error('Toggle Jito command error:', error);
    await ctx.reply('❌ An error occurred while processing your request.');
  }
} 