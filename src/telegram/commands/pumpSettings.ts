import { Context } from 'telegraf';
import { PumpSwapService, TransactionSpeed, SlippagePreset } from '../../services/pumpswapService';

// Create instance of PumpSwapService
const pumpSwapService = new PumpSwapService();

export async function pumpSettings(ctx: Context): Promise<void> {
  try {
    const userId = ctx.from?.id.toString();
    
    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return;
    }

    // Check if user has a wallet
    const wallet = await pumpSwapService.getWallet(userId);
    if (!wallet) {
      await ctx.reply('❌ You need to create or import a wallet first.\nUse /wallet create <name> or /wallet import <private_key>');
      return;
    }

    // Parse command arguments
    const message = ctx.message;
    if (!message || !('text' in message)) {
      await ctx.reply('❌ Invalid command format. Try /pumpsettings help for usage information.');
      return;
    }

    const args = message.text.split(' ').slice(1);
    
    // If no arguments, show current settings
    if (args.length === 0 || args[0] === 'show') {
      const settings = await pumpSwapService.getUserSettings(userId);
      
      await ctx.reply(
        `🔧 <b>Your Pump.fun Settings</b>\n\n` +
        `⚡️ Speed: <b>${settings.speed}</b>\n` +
        `🔄 Slippage: <b>${settings.slippageBps / 100}%</b>\n` +
        `🛡️ Jito MEV Protection: <b>${settings.useJito ? 'Enabled' : 'Disabled'}</b>\n` +
        `💰 Jito Tip: <b>${settings.jitoTipLamports / 1e9} SOL</b>`,
        { parse_mode: 'HTML' }
      );
      return;
    }
    
    // Help command
    if (args[0] === 'help') {
      await ctx.reply(
        `📚 <b>Pump.fun Settings Help</b>\n\n` +
        `Available commands:\n\n` +
        `/pumpsettings show - Display current settings\n` +
        `/pumpsettings speed <fast|turbo|ultra> - Set transaction speed\n` +
        `/pumpsettings slippage <0.5|1|4|custom> - Set slippage tolerance\n` +
        `/pumpsettings jito <on|off> - Toggle Jito MEV protection\n` +
        `/pumpsettings tip <amount> - Set Jito tip amount in SOL`,
        { parse_mode: 'HTML' }
      );
      return;
    }
    
    // Update speed
    if (args[0] === 'speed' && args.length > 1) {
      const speed = args[1].toLowerCase();
      
      if (!['fast', 'turbo', 'ultra'].includes(speed)) {
        await ctx.reply('❌ Invalid speed setting. Choose from: fast, turbo, ultra');
        return;
      }
      
      await pumpSwapService.updateUserSettings(userId, {
        speed: speed as TransactionSpeed
      });
      
      await ctx.reply(`✅ Transaction speed updated to <b>${speed}</b>`, { parse_mode: 'HTML' });
      return;
    }
    
    // Update slippage
    if (args[0] === 'slippage' && args.length > 1) {
      let slippageBps: number;
      
      switch (args[1]) {
        case '0.5':
          slippageBps = SlippagePreset.LOW;
          break;
        case '1':
          slippageBps = SlippagePreset.MEDIUM;
          break;
        case '4':
          slippageBps = SlippagePreset.HIGH;
          break;
        default:
          // Try to parse custom value
          try {
            const customValue = parseFloat(args[1]);
            if (isNaN(customValue) || customValue <= 0 || customValue > 50) {
              await ctx.reply('❌ Invalid slippage value. Must be between 0.1 and 50');
              return;
            }
            slippageBps = Math.floor(customValue * 100);
          } catch (e) {
            await ctx.reply('❌ Invalid slippage value. Try 0.5, 1, 4, or a custom percentage');
            return;
          }
      }
      
      await pumpSwapService.updateUserSettings(userId, { slippageBps });
      
      await ctx.reply(`✅ Slippage tolerance updated to <b>${slippageBps / 100}%</b>`, { parse_mode: 'HTML' });
      return;
    }
    
    // Toggle Jito
    if (args[0] === 'jito' && args.length > 1) {
      const useJito = args[1].toLowerCase() === 'on';
      
      await pumpSwapService.updateUserSettings(userId, { useJito });
      
      await ctx.reply(
        `✅ Jito MEV protection is now ${useJito ? '<b>enabled</b>' : '<b>disabled</b>'}!\n\n` +
        `${useJito 
          ? '🛡️ Your transactions will now use Jito for faster execution and MEV protection.' 
          : '⚠️ Your transactions will now use standard execution without MEV protection.'}`,
        { parse_mode: 'HTML' }
      );
      return;
    }
    
    // Set Jito tip
    if (args[0] === 'tip' && args.length > 1) {
      try {
        const tipAmount = parseFloat(args[1]);
        if (isNaN(tipAmount) || tipAmount < 0 || tipAmount > 1) {
          await ctx.reply('❌ Invalid tip amount. Must be between 0 and 1 SOL');
          return;
        }
        
        const jitoTipLamports = Math.floor(tipAmount * 1e9);
        await pumpSwapService.updateUserSettings(userId, { jitoTipLamports });
        
        await ctx.reply(`✅ Jito tip amount updated to <b>${tipAmount} SOL</b>`, { parse_mode: 'HTML' });
      } catch (e) {
        await ctx.reply('❌ Invalid tip amount. Please enter a valid number');
      }
      return;
    }
    
    // Unknown command
    await ctx.reply('❌ Unknown setting. Try /pumpsettings help for usage information.');
    
  } catch (error) {
    console.error('Pump settings command error:', error);
    await ctx.reply('❌ An error occurred while updating settings.');
  }
} 