import { Context } from 'telegraf';
import { sniperooService } from '../../services/sniperooService';

export async function sell(ctx: Context): Promise<void> {
  try {
    // Get the token address and percentage from command arguments
    const args = ctx.message?.text?.split(' ');
    if (!args || args.length < 3) {
      await ctx.reply('⚠️ Token address and percentage are required.\nUsage: /sell <token_address> <percentage>');
      return;
    }

    const tokenAddress = args[1].trim();
    const percentage = parseFloat(args[2].trim());
    const userId = ctx.from?.id.toString();

    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return;
    }

    if (isNaN(percentage) || percentage < 1 || percentage > 100) {
      await ctx.reply('⚠️ Percentage must be between 1 and 100.');
      return;
    }

    const success = await sniperooService.sellToken(
      tokenAddress,
      percentage,
      userId
    );

    if (success) {
      await ctx.reply(
        `✅ Sell order placed successfully!\n\nToken: \`${tokenAddress}\`\nPercentage: ${percentage}%`,
        { parse_mode: 'Markdown' }
      );
    } else {
      await ctx.reply('❌ Failed to place sell order. Please try again.');
    }
  } catch (error) {
    console.error('Sell command error:', error);
    await ctx.reply('❌ An error occurred while processing your request.');
  }
} 