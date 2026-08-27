import { Context } from 'telegraf';

// Service types 
export enum SwapService {
  JUPITER = 'jupiter',
  PUMPFUN = 'pumpfun'
}

// In-memory store for user preferences - should be replaced with database storage
const userServicePreferences: Record<string, SwapService> = {};

export async function service(ctx: Context): Promise<void> {
  try {
    const userId = ctx.from?.id.toString();
    
    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return;
    }

    // Parse command arguments
    const message = ctx.message;
    if (!message || !('text' in message)) {
      await ctx.reply('❌ Invalid command format. Try /service help for usage information.');
      return;
    }

    const args = message.text.split(' ').slice(1);
    
    // If no arguments or "get", show current service
    if (args.length === 0 || args[0] === 'get') {
      const currentService = userServicePreferences[userId] || SwapService.JUPITER;
      
      await ctx.reply(
        `🔄 <b>Your Current Swap Service</b>\n\n` +
        `You are currently using: <b>${currentService === SwapService.JUPITER ? 'Jupiter' : 'Pump.fun'}</b>\n\n` +
        `<b>Jupiter:</b> Best for limit orders, more reliable price discovery\n` +
        `<b>Pump.fun:</b> Direct AMM access, potentially faster for market orders`,
        { parse_mode: 'HTML' }
      );
      return;
    }
    
    // Help command
    if (args[0] === 'help') {
      await ctx.reply(
        `📚 <b>Swap Service Help</b>\n\n` +
        `Available commands:\n\n` +
        `/service get - Show current service\n` +
        `/service jupiter - Use Jupiter for swaps\n` +
        `/service pumpfun - Use Pump.fun for swaps\n\n` +
        `<b>Usage Tips:</b>\n` +
        `• Jupiter is recommended for limit orders and more reliable price discovery\n` +
        `• Pump.fun offers direct AMM access and may be faster for market orders`,
        { parse_mode: 'HTML' }
      );
      return;
    }
    
    // Set service
    if (args[0] === 'jupiter' || args[0] === 'pumpfun') {
      const service = args[0] as SwapService;
      userServicePreferences[userId] = service;
      
      await ctx.reply(
        `✅ Swap service set to <b>${service === SwapService.JUPITER ? 'Jupiter' : 'Pump.fun'}</b>\n\n` +
        `${service === SwapService.JUPITER 
          ? '🚀 You will now use Jupiter for all swaps. This includes Jito MEV protection features.' 
          : '⚡️ You will now use Pump.fun direct AMM for all swaps. Configure your settings with /pumpsettings'}`,
        { parse_mode: 'HTML' }
      );
      return;
    }
    
    // Unknown command
    await ctx.reply('❌ Unknown service. Choose either "jupiter" or "pumpfun".');
    
  } catch (error) {
    console.error('Service command error:', error);
    await ctx.reply('❌ An error occurred while processing your request.');
  }
}

/**
 * Get the user's preferred swap service
 */
export function getUserPreferredService(userId: string): SwapService {
  return userServicePreferences[userId] || SwapService.JUPITER;
} 