import { Context } from 'telegraf';
import { jupiterService } from '../../services/jupiterService';
import { PumpSwapService } from '../../services/pumpswapService';
import { getUserPreferredService, SwapService } from './service';
import { showBuyMenu } from '../showBuyMenu';

// Create instance of PumpSwapService
const pumpSwapService = new PumpSwapService();

export async function buy(ctx: Context): Promise<void> {
  try {
    const userId = ctx.from?.id.toString();
    
    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return;
    }

    // Get message text
    const message = ctx.message;
    if (!message || !('text' in message)) {
      await showBuyMenu(ctx);
      return;
    }

    // Parse command arguments
    const args = message.text.split(' ').slice(1);
    
    // Check if token address is provided
    if (args.length === 0) {
      await showBuyMenu(ctx);
      return;
    }
    
    const tokenAddress = args[0];
    
    // Check if the token address is valid
    if (!tokenAddress.match(/^[A-Za-z0-9]{32,44}$/)) {
      await ctx.reply('❌ Invalid token address format. Please provide a valid Solana token address.');
      return;
    }
    
    // Get user config for buy amount
    const userConfig = await jupiterService.getUserConfig(userId);
    if (!userConfig) {
      await ctx.reply('❌ No user configuration found. Please set up your configuration first using /config.');
      return;
    }
    
    // Check which service the user prefers
    const preferredService = getUserPreferredService(userId);
    
    // Send "processing" message
    const processingMsg = await ctx.reply(
      `⏳ Processing your buy order for token: \n<code>${tokenAddress}</code>\nAmount: ${userConfig.buyAmount} SOL`,
      { parse_mode: 'HTML' }
    );
    
    // Buy token using the preferred service
    let result;
    
    if (preferredService === SwapService.JUPITER) {
      // Use Jupiter service
      result = await jupiterService.buyToken(tokenAddress, userId);
    } else {
      // Use Pump.fun service
      result = await pumpSwapService.buyToken(tokenAddress, userId);
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
        `✅ <b>Purchase successful!</b>\n\n` +
        `🔗 <a href="${txLink}">View transaction details</a>\n\n` +
        `🔄 Service: <b>${preferredService === SwapService.JUPITER ? 'Jupiter' : 'Pump.fun'}</b>\n\n` +
        `Swap completed successfully. Use /wallet to check your balance.`,
        { 
          parse_mode: 'HTML',
          disable_web_page_preview: true 
        } as any
      );
    } else {
      // Handle error case
      const errorMessage = result.error || 'Unknown error occurred';
      
      await ctx.reply(
        `❌ <b>Purchase failed</b>\n\n` +
        `Error: ${errorMessage}\n\n` +
        `Please check that the token address is correct and try again.`,
        { parse_mode: 'HTML' }
      );
    }
    
  } catch (error) {
    console.error('Buy command error:', error);
    await ctx.reply('❌ An error occurred while processing your request.');
  }
} 