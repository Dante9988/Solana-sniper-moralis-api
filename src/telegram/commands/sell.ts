import { Context } from 'telegraf';
import { jupiterService } from '../../services/jupiterService';
import { PumpSwapService } from '../../services/pumpswapService';
import { getUserPreferredService, SwapService } from './service';
import { showSellMenu } from '../showSellMenu';

// Create instance of PumpSwapService
const pumpSwapService = new PumpSwapService();

export async function sell(ctx: Context): Promise<void> {
  try {
    const userId = ctx.from?.id.toString();
    
    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return;
    }

    // Get message text
    const message = ctx.message;
    if (!message || !('text' in message)) {
      await showSellMenu(ctx);
      return;
    }

    // Parse command arguments
    const args = message.text.split(' ').slice(1);
    
    // Check if token address and percentage are provided
    if (args.length === 0) {
      await showSellMenu(ctx);
      return;
    }
    
    if (args.length < 2) {
      await ctx.reply('❌ Please provide both token address and percentage. Usage: /sell <token_address> <percentage>');
      return;
    }
    
    const tokenAddress = args[0];
    const percentageStr = args[1];
    
    // Check if the token address is valid
    if (!tokenAddress.match(/^[A-Za-z0-9]{32,44}$/)) {
      await ctx.reply('❌ Invalid token address format. Please provide a valid Solana token address.');
      return;
    }
    
    // Parse the percentage
    const percentage = parseInt(percentageStr);
    if (isNaN(percentage) || percentage <= 0 || percentage > 100) {
      await ctx.reply('❌ Percentage must be a number between 1 and 100.');
      return;
    }
    
    // Check which service the user prefers
    const preferredService = getUserPreferredService(userId);
    
    // Send "processing" message
    const processingMsg = await ctx.reply(
      `⏳ Processing your sell order for token: \n<code>${tokenAddress}</code>\nPercentage: ${percentage}%`,
      { parse_mode: 'HTML' }
    );
    
    // Sell token using the preferred service
    let result;
    
    if (preferredService === SwapService.JUPITER) {
      // Use Jupiter service
      result = await jupiterService.sellToken(tokenAddress, percentage, userId);
    } else {
      // Use Pump.fun service
      result = await pumpSwapService.sellToken(tokenAddress, percentage, userId);
    }
    
    // Handle the result
    if (result.success && result.txId) {
      // Format transaction ID for display (truncate if needed)
      const txIdDisplay = result.txId.length > 15 
        ? `${result.txId.substring(0, 8)}...${result.txId.substring(result.txId.length - 8)}`
        : result.txId;
        
      // Create Solscan transaction link
      const txLink = `https://solscan.io/tx/${result.txId}`;
      
      await ctx.reply(
        `✅ <b>Sale successful!</b>\n\n` +
        `🔗 <a href="${txLink}">View transaction details</a>\n\n` +
        `🔄 Service: <b>${preferredService === SwapService.JUPITER ? 'Jupiter' : 'Pump.fun'}</b>\n\n` +
        `Sold ${percentage}% of your tokens. Use /wallet to check your balance.`,
        { parse_mode: 'HTML' }
      );
    } else {
      // Handle error case
      const errorMessage = result.error || 'Unknown error occurred';
      
      await ctx.reply(
        `❌ <b>Sale failed</b>\n\n` +
        `Error: ${errorMessage}\n\n` +
        `Please check that the token address is correct and try again.`,
        { parse_mode: 'HTML' }
      );
    }
    
  } catch (error) {
    console.error('Sell command error:', error);
    await ctx.reply('❌ An error occurred while processing your request.');
  }
} 