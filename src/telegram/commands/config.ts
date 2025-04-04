import { Context } from 'telegraf';
import { sniperooService, UserConfig } from '../../services/sniperooService';

export async function config(ctx: Context): Promise<void> {
  try {
    const args = ctx.message?.text?.split(' ');
    if (!args || args.length < 2) {
      await ctx.reply(
        '⚠️ Subcommand required.\n\n' +
        'Usage:\n' +
        '/config view - View your current configuration\n' +
        '/config set <autobuy> <amount> <takeprofit> <stoploss> <autosell> - Set your configuration\n\n' +
        'Example:\n' +
        '/config set true 0.1 50 15 true'
      );
      return;
    }

    const subcommand = args[1].toLowerCase();
    const userId = ctx.from?.id.toString();

    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return;
    }

    if (subcommand === 'view') {
      const config = await sniperooService.getUserConfig(userId);
      if (!config) {
        await ctx.reply('No configuration found. Use `/config set` to configure your settings.');
        return;
      }

      await ctx.reply(
        `📊 Your Configuration:\n\n` +
        `Auto Buy: ${config.autoBuy ? '✅' : '❌'}\n` +
        `Auto Sell: ${config.autoSell ? '✅' : '❌'}\n` +
        `Buy Amount: ${config.buyAmount} SOL\n` +
        `Take Profit: ${config.takeProfit}%\n` +
        `Stop Loss: ${config.stopLoss}%`,
        { parse_mode: 'Markdown' }
      );
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

      const config = await sniperooService.getUserConfig(userId);
      if (!config) {
        await ctx.reply('❌ Failed to retrieve updated configuration. Please try again.');
        return;
      }

      await ctx.reply(
        `✅ Configuration updated successfully!\n\n` +
        `Auto Buy: ${config.autoBuy ? '✅' : '❌'}\n` +
        `Auto Sell: ${config.autoSell ? '✅' : '❌'}\n` +
        `Buy Amount: ${config.buyAmount} SOL\n` +
        `Take Profit: ${config.takeProfit}%\n` +
        `Stop Loss: ${config.stopLoss}%`,
        { parse_mode: 'Markdown' }
      );
    } else {
      await ctx.reply(
        '⚠️ Invalid subcommand.\n\n' +
        'Available commands:\n' +
        '/config view - View your current configuration\n' +
        '/config set <autobuy> <amount> <takeprofit> <stoploss> <autosell> - Set your configuration'
      );
    }
  } catch (error) {
    console.error('Config command error:', error);
    await ctx.reply('❌ An error occurred while processing your request.');
  }
} 