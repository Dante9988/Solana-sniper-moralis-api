import { Context, Markup } from 'telegraf';
import { sniperooService, UserConfig } from '../../services/sniperooService';

export async function config(ctx: Context): Promise<void> {
  try {
    const message = ctx.message;
    const userId = ctx.from?.id.toString();

    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return;
    }
    
    // If no arguments provided, show modern menu instead of text instructions
    if (!message || !('text' in message) || message.text === '/config') {
      await showConfigMenu(ctx);
      return;
    }
    
    const args = message.text.split(' ');
    if (args.length < 2) {
      await showConfigMenu(ctx);
      return;
    }

    const subcommand = args[1].toLowerCase();

    if (subcommand === 'view') {
      await viewConfig(ctx, userId);
    } else if (subcommand === 'set') {
      if (args.length < 7) {
        await ctx.reply(
          '⚠️ All parameters are required.\n\n' +
          'Usage:\n' +
          '/config set <autobuy> <amount> <takeprofit> <stoploss> <autosell>\n\n' +
          'Example:\n' +
          '/config set true 0.1 50 15 true'
        );
        return;
      }

      const autoBuy = args[2].toLowerCase() === 'true';
      const buyAmount = parseFloat(args[3]);
      const takeProfit = parseFloat(args[4]);
      const stopLoss = parseFloat(args[5]);
      const autoSell = args[6].toLowerCase() === 'true';

      if (isNaN(buyAmount) || isNaN(takeProfit) || isNaN(stopLoss)) {
        await ctx.reply('⚠️ Invalid parameters. Amount, take profit, and stop loss must be numbers.');
        return;
      }

      const configUpdate: Partial<UserConfig> = {
        userId,
        autoBuy,
        autoSell,
        buyAmount,
        takeProfit,
        stopLoss
      };

      const success = await sniperooService.updateUserConfig(userId, configUpdate);

      if (!success) {
        await ctx.reply('❌ Failed to update configuration. Please try again.');
        return;
      }

      await viewConfig(ctx, userId);
    } else {
      await showConfigMenu(ctx);
    }
  } catch (error) {
    console.error('Config command error:', error);
    await ctx.reply('❌ An error occurred while processing your request.');
  }
}

/**
 * Display the modern config menu with buttons
 */
async function showConfigMenu(ctx: Context): Promise<void> {
  const userId = ctx.from?.id.toString();
  if (!userId) return;

  // Get current config to display values
  const config = await sniperooService.getUserConfig(userId);
  
  // Create message based on existing config
  let message = '⚙️ <b>Trading Configuration</b>\n\n';
  
  if (config) {
    message += `Auto Buy: ${config.autoBuy ? '✅' : '❌'}\n`;
    message += `Auto Sell: ${config.autoSell ? '✅' : '❌'}\n`;
    message += `Buy Amount: ${config.buyAmount} SOL\n`;
    message += `Take Profit: ${config.takeProfit}%\n`;
    message += `Stop Loss: ${config.stopLoss}%\n\n`;
  } else {
    message += 'No configuration found. Please set up your trading parameters.\n\n';
  }
  
  message += 'Select an option below:';
  
  // Create modern button menu
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('👁️ View Config', 'config:view'),
      Markup.button.callback('⚙️ Set Config', 'config:set_init')
    ],
    [
      Markup.button.callback(config?.autoBuy ? '❌ Disable Auto Buy' : '✅ Enable Auto Buy', 'config:toggle_autobuy')
    ],
    [
      Markup.button.callback(config?.autoSell ? '❌ Disable Auto Sell' : '✅ Enable Auto Sell', 'config:toggle_autosell')
    ],
    [
      Markup.button.callback('💰 Set Buy Amount', 'config:set_amount'),
      Markup.button.callback('📊 Set TP/SL', 'config:set_limits')
    ],
    [
      Markup.button.callback('⬅️ Back to Main Menu', 'settings:back')
    ]
  ]);
  
  // Send the menu
  await ctx.reply(message, {
    parse_mode: 'HTML',
    ...keyboard
  });
}

/**
 * View the current configuration
 */
async function viewConfig(ctx: Context, userId: string): Promise<void> {
  const config = await sniperooService.getUserConfig(userId);
  
  if (!config) {
    await ctx.reply(
      '❌ No configuration found.\n\n' +
      'Please set up your configuration first.',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('⚙️ Set Configuration', 'config:set_init')]
        ])
      }
    );
    return;
  }

  await ctx.reply(
    `📊 <b>Your Configuration:</b>\n\n` +
    `Auto Buy: ${config.autoBuy ? '✅' : '❌'}\n` +
    `Auto Sell: ${config.autoSell ? '✅' : '❌'}\n` +
    `Buy Amount: ${config.buyAmount} SOL\n` +
    `Take Profit: ${config.takeProfit}%\n` +
    `Stop Loss: ${config.stopLoss}%`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('⚙️ Edit Config', 'config:set_init'),
          Markup.button.callback('⬅️ Back', 'settings:menu')
        ]
      ])
    }
  );
} 