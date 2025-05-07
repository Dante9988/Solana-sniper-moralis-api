import { Context, Markup } from 'telegraf';
import { jupiterService } from '../../services/jupiterService';

/**
 * Show the auto buy menu with profit presets
 */
export async function showAutoBuyMenu(ctx: Context): Promise<void> {
  try {
    const userId = ctx.from?.id.toString();
    
    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return;
    }
    
    // Get user config to check if auto buy is enabled
    const userConfig = await jupiterService.getUserConfig(userId);
    const autoBuyEnabled = userConfig?.autoBuy || false;
    
    // Get user's profit/loss settings
    const takeProfit = userConfig?.takeProfit || 50;
    const stopLoss = userConfig?.stopLoss || 25;
    
    // Create the auto buy menu message
    const autoBuyMessage = `
🤖 <b>Auto Buy Settings</b>

Status: ${autoBuyEnabled ? '✅ <b>Enabled</b>' : '❌ <b>Disabled</b>'}

When auto buy is enabled, the bot will automatically buy detected tokens.

<b>Current Settings:</b>
📈 Take Profit: <b>${takeProfit}%</b>
📉 Stop Loss: <b>${stopLoss}%</b>
💰 Buy Amount: <b>${userConfig?.buyAmount || 0.1} SOL</b>
🔄 Auto Sell: <b>${userConfig?.autoSell ? 'Enabled' : 'Disabled'}</b>

Configure automatic token buying:`;

    // Create auto buy menu buttons with presets
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback(autoBuyEnabled ? '❌ Disable Auto Buy' : '✅ Enable Auto Buy', 
          autoBuyEnabled ? 'autobuy:disable' : 'autobuy:enable'),
      ],
      [
        Markup.button.callback('💰 Set Buy Amount', 'autobuy:set_amount'),
        Markup.button.callback(userConfig?.autoSell ? '🔄 Disable Auto Sell' : '🔄 Enable Auto Sell', 
          userConfig?.autoSell ? 'autobuy:disable_autosell' : 'autobuy:enable_autosell')
      ],
      [
        Markup.button.callback('📈 Take Profit Presets', 'autobuy:tp_presets'),
        Markup.button.callback('📉 Stop Loss Presets', 'autobuy:sl_presets')
      ],
      [
        Markup.button.callback('⬅️ Back to Main Menu', 'action:refresh')
      ]
    ]);

    // Send the auto buy menu
    await ctx.reply(autoBuyMessage, {
      parse_mode: 'HTML',
      ...keyboard
    });
  } catch (error) {
    console.error('Show auto buy menu error:', error);
    await ctx.reply('❌ An error occurred while showing the auto buy menu.');
  }
}

/**
 * Show take profit presets menu
 */
export async function showTakeProfitMenu(ctx: Context): Promise<void> {
  try {
    const userId = ctx.from?.id.toString();
    
    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return;
    }
    
    // Get current settings
    const userConfig = await jupiterService.getUserConfig(userId);
    const currentTP = userConfig?.takeProfit || 50;
    
    const message = `
📈 <b>Take Profit Presets</b>

Current setting: <b>${currentTP}%</b>

Select a preset or use the command /config takeprofit <value> to set a custom value:`;
    
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('25%', 'autobuy:set_tp:25'),
        Markup.button.callback('50%', 'autobuy:set_tp:50'),
        Markup.button.callback('100%', 'autobuy:set_tp:100')
      ],
      [
        Markup.button.callback('150%', 'autobuy:set_tp:150'),
        Markup.button.callback('200%', 'autobuy:set_tp:200'),
        Markup.button.callback('500%', 'autobuy:set_tp:500')
      ],
      [
        Markup.button.callback('⬅️ Back to Auto Buy', 'autobuy:menu')
      ]
    ]);
    
    await ctx.reply(message, {
      parse_mode: 'HTML',
      ...keyboard
    });
  } catch (error) {
    console.error('Show take profit menu error:', error);
    await ctx.reply('❌ An error occurred.');
  }
}

/**
 * Show stop loss presets menu
 */
export async function showStopLossMenu(ctx: Context): Promise<void> {
  try {
    const userId = ctx.from?.id.toString();
    
    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return;
    }
    
    // Get current settings
    const userConfig = await jupiterService.getUserConfig(userId);
    const currentSL = userConfig?.stopLoss || 25;
    
    const message = `
📉 <b>Stop Loss Presets</b>

Current setting: <b>${currentSL}%</b>

Select a preset or use the command /config stoploss <value> to set a custom value:`;
    
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('10%', 'autobuy:set_sl:10'),
        Markup.button.callback('15%', 'autobuy:set_sl:15'),
        Markup.button.callback('25%', 'autobuy:set_sl:25')
      ],
      [
        Markup.button.callback('33%', 'autobuy:set_sl:33'),
        Markup.button.callback('50%', 'autobuy:set_sl:50'),
        Markup.button.callback('75%', 'autobuy:set_sl:75')
      ],
      [
        Markup.button.callback('⬅️ Back to Auto Buy', 'autobuy:menu')
      ]
    ]);
    
    await ctx.reply(message, {
      parse_mode: 'HTML',
      ...keyboard
    });
  } catch (error) {
    console.error('Show stop loss menu error:', error);
    await ctx.reply('❌ An error occurred.');
  }
}

/**
 * Handle auto buy menu callbacks
 */
export function registerAutoBuyCallbacks(bot: any): void {
  // Enable auto buy
  bot.action('autobuy:enable', async (ctx: any) => {
    try {
      const userId = ctx.from?.id.toString();
      
      if (!userId) {
        await ctx.reply('❌ Failed to identify user.');
        return;
      }
      
      await jupiterService.updateUserConfig(userId, { autoBuy: true });
      await ctx.reply('✅ Auto Buy has been enabled!');
      
      // Show the updated auto buy menu
      await showAutoBuyMenu(ctx);
    } catch (error) {
      console.error('Handle enable auto buy error:', error);
      await ctx.reply('❌ An error occurred while enabling auto buy.');
    }
  });
  
  // Disable auto buy
  bot.action('autobuy:disable', async (ctx: any) => {
    try {
      const userId = ctx.from?.id.toString();
      
      if (!userId) {
        await ctx.reply('❌ Failed to identify user.');
        return;
      }
      
      await jupiterService.updateUserConfig(userId, { autoBuy: false });
      await ctx.reply('❌ Auto Buy has been disabled!');
      
      // Show the updated auto buy menu
      await showAutoBuyMenu(ctx);
    } catch (error) {
      console.error('Handle disable auto buy error:', error);
      await ctx.reply('❌ An error occurred while disabling auto buy.');
    }
  });
  
  // Enable auto sell
  bot.action('autobuy:enable_autosell', async (ctx: any) => {
    try {
      const userId = ctx.from?.id.toString();
      
      if (!userId) {
        await ctx.reply('❌ Failed to identify user.');
        return;
      }
      
      await jupiterService.updateUserConfig(userId, { autoSell: true });
      await ctx.reply('✅ Auto Sell has been enabled!');
      
      // Show the updated auto buy menu
      await showAutoBuyMenu(ctx);
    } catch (error) {
      console.error('Handle enable auto sell error:', error);
      await ctx.reply('❌ An error occurred while enabling auto sell.');
    }
  });
  
  // Disable auto sell
  bot.action('autobuy:disable_autosell', async (ctx: any) => {
    try {
      const userId = ctx.from?.id.toString();
      
      if (!userId) {
        await ctx.reply('❌ Failed to identify user.');
        return;
      }
      
      await jupiterService.updateUserConfig(userId, { autoSell: false });
      await ctx.reply('❌ Auto Sell has been disabled!');
      
      // Show the updated auto buy menu
      await showAutoBuyMenu(ctx);
    } catch (error) {
      console.error('Handle disable auto sell error:', error);
      await ctx.reply('❌ An error occurred while disabling auto sell.');
    }
  });
  
  // Show take profit presets
  bot.action('autobuy:tp_presets', async (ctx: any) => {
    await showTakeProfitMenu(ctx);
  });
  
  // Show stop loss presets
  bot.action('autobuy:sl_presets', async (ctx: any) => {
    await showStopLossMenu(ctx);
  });
  
  // Set buy amount
  bot.action('autobuy:set_amount', async (ctx: any) => {
    await ctx.reply(
      '💰 <b>Set Buy Amount</b>\n\n' +
      'Please enter the amount of SOL to use for auto buys with the command:\n\n' +
      '<code>/config buyamount X</code>\n\n' +
      'Where X is the amount in SOL (e.g. 0.1, 0.5, 1, etc.)',
      { parse_mode: 'HTML' }
    );
  });
  
  // Set take profit presets
  bot.action(/^autobuy:set_tp:(\d+)$/, async (ctx: any) => {
    try {
      const userId = ctx.from?.id.toString();
      const value = parseInt(ctx.match[1]);
      
      if (!userId) {
        await ctx.reply('❌ Failed to identify user.');
        return;
      }
      
      await jupiterService.updateUserConfig(userId, { takeProfit: value });
      await ctx.reply(`✅ Take Profit set to ${value}%!`);
      
      // Show the updated take profit menu
      await showTakeProfitMenu(ctx);
    } catch (error) {
      console.error('Handle set take profit error:', error);
      await ctx.reply('❌ An error occurred while setting take profit.');
    }
  });
  
  // Set stop loss presets
  bot.action(/^autobuy:set_sl:(\d+)$/, async (ctx: any) => {
    try {
      const userId = ctx.from?.id.toString();
      const value = parseInt(ctx.match[1]);
      
      if (!userId) {
        await ctx.reply('❌ Failed to identify user.');
        return;
      }
      
      await jupiterService.updateUserConfig(userId, { stopLoss: value });
      await ctx.reply(`✅ Stop Loss set to ${value}%!`);
      
      // Show the updated stop loss menu
      await showStopLossMenu(ctx);
    } catch (error) {
      console.error('Handle set stop loss error:', error);
      await ctx.reply('❌ An error occurred while setting stop loss.');
    }
  });
  
  // Back to auto buy menu
  bot.action('autobuy:menu', async (ctx: any) => {
    await showAutoBuyMenu(ctx);
  });
} 