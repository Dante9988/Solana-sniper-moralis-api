import { Context, Markup } from 'telegraf';
import { jupiterService } from '../services/jupiterService';
import { getUserPreferredService, SwapService } from './commands/service';

/**
 * Show the buy menu
 */
export async function showBuyMenu(ctx: Context): Promise<void> {
  try {
    const userId = ctx.from?.id.toString();
    
    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return;
    }

    // Get user's preferred service
    const preferredService = getUserPreferredService(userId);
    
    // Create the buy menu message
    const buyMessage = `
📊 <b>Buy Tokens</b>

Current service: <b>${preferredService === SwapService.JUPITER ? 'Jupiter' : 'Pump.fun'}</b>

Enter a token address or select an option below:`;

    // Create buy menu buttons
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('🔄 Enter Token Address', 'buy:token')
      ],
      [
        Markup.button.callback('🔄 Change Service', 'buy:service')
      ],
      [
        Markup.button.callback('⬅️ Back to Main Menu', 'buy:back')
      ]
    ]);

    // Send the buy menu
    await ctx.reply(buyMessage, {
      parse_mode: 'HTML',
      ...keyboard
    });
  } catch (error) {
    console.error('Show buy menu error:', error);
    await ctx.reply('❌ An error occurred while showing the buy menu.');
  }
} 