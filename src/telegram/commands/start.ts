import { Context } from 'telegraf';
import { sniperooService } from '../../services/sniperooService';

export async function start(ctx: Context): Promise<void> {
  try {
    const userId = ctx.from?.id.toString();
    const firstName = ctx.from?.first_name || 'there';
    
    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return;
    }

    // Check if user already has a wallet
    const wallet = await sniperooService.getWallet(userId);
    
    const welcomeMessage = `
🚀 *Welcome to the Solana Sniper Bot, ${firstName}!* 🚀

This bot helps you trade Solana tokens quickly and efficiently. Here's what you can do:

📝 *Commands:*
• /wallet create <name> - Create a new wallet
• /wallet import <private_key> - Import an existing wallet
• /buy <token_address> - Buy a token
• /sell <token_address> <percentage> - Sell a token
• /config view - View your trading configuration
• /config set <autobuy> <amount> <takeprofit> <stoploss> <autosell> - Set your configuration
• /togglepumpswap - Toggle PumpSwap notifications

${wallet ? '✅ You already have a wallet set up!' : '⚠️ Please set up a wallet first using /wallet create or /wallet import.'}

📊 *Need help?*
Just type any command to get started, or add "help" after a command for more details.
`;

    await ctx.reply(welcomeMessage, { parse_mode: 'Markdown' });
    
  } catch (error) {
    console.error('Start command error:', error);
    await ctx.reply('❌ An error occurred while processing your request.');
  }
} 