import { Context } from 'telegraf';
import { sniperooService } from '../../services/sniperooService';

export async function buy(ctx: Context): Promise<void> {
  try {
    // Get the token address from command arguments
    const args = ctx.message?.text?.split(' ');
    if (!args || args.length < 2) {
      await ctx.reply('⚠️ Token address is required.\nUsage: /buy <token_address>');
      return;
    }

    const tokenAddress = args[1].trim();
    const userId = ctx.from?.id.toString();

    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return;
    }

    const success = await sniperooService.buyToken(
      tokenAddress,
      userId
    );

    if (success) {
      const config = await sniperooService.getUserConfig(userId);
      if (!config) {
        await ctx.reply('❌ Failed to get user configuration.');
        return;
      }

      await ctx.reply(
        `✅ Buy order placed successfully!\n\n` +
        `Token: \`${tokenAddress}\`\n` +
        `Amount: ${config.buyAmount} SOL\n` +
        `Auto-sell: ${config.autoSell ? 'Enabled' : 'Disabled'}\n` +
        `Take Profit: ${config.takeProfit}%\n` +
        `Stop Loss: ${config.stopLoss}%`,
        { parse_mode: 'Markdown' }
      );
    } else {
      await ctx.reply('❌ Failed to place buy order. Please try again.');
    }
  } catch (error) {
    console.error('Buy command error:', error);
    await ctx.reply('❌ An error occurred while processing your request.');
  }
} 