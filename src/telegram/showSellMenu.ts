import { Context, Markup } from 'telegraf';
import { jupiterService } from '../services/jupiterService';
import { getUserPreferredService, SwapService } from './commands/service';

/**
 * Show the sell menu
 */
export async function showSellMenu(ctx: Context): Promise<void> {
  try {
    const userId = ctx.from?.id.toString();
    
    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return;
    }

    // Check if user has a wallet
    const wallet = await jupiterService.getWallet(userId);
    
    if (!wallet) {
      await ctx.reply(
        '❌ You need to create a wallet first before you can sell tokens.\n\n' +
        'Use /wallet to create or import a wallet.',
        { parse_mode: 'HTML' }
      );
      return;
    }
    
    // Get user's preferred service
    const preferredService = getUserPreferredService(userId);
    
    // Create the sell menu message
    const sellMessage = `
💱 <b>Sell Tokens</b>

Current service: <b>${preferredService === SwapService.JUPITER ? 'Jupiter' : 'Pump.fun'}</b>

To sell tokens, use the command:
<code>/sell &lt;token_address&gt; &lt;percentage&gt;</code>

Example: <code>/sell Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr 100</code>

Alternative options:`;

    // Create sell menu buttons
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('🔄 Select Tokens', 'sell:select_token'),
        Markup.button.callback('📋 View Positions', 'positions:view')
      ],
      [
        Markup.button.callback('🔄 Change Service', 'buy:service'),
        Markup.button.callback('⚡ Fast Sell (100%)', 'sell:fast_sell')
      ],
      [
        Markup.button.callback('⬅️ Back to Main Menu', 'action:refresh')
      ]
    ]);

    // Send the sell menu
    await ctx.reply(sellMessage, {
      parse_mode: 'HTML',
      ...keyboard
    });
  } catch (error) {
    console.error('Show sell menu error:', error);
    await ctx.reply('❌ An error occurred while showing the sell menu.');
  }
} 