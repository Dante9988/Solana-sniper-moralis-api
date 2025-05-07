import { Context } from 'telegraf';
import { getChannelConfig } from './toggleChannel';
import { sendTokenAlert, sendPnlReport } from '../alerts';
import { telegramBot } from '../telegramBot';

export async function testChannel(ctx: Context): Promise<void> {
  try {
    const userId = ctx.from?.id.toString();
    
    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return;
    }
    
    // Check channel config
    const channelConfig = getChannelConfig();
    
    if (!channelConfig.channelId || !channelConfig.enabled) {
      await ctx.reply(
        '❌ Channel not configured. Please use /getchannelid first to configure your channel.'
      );
      return;
    }
    
    await ctx.reply(`🔄 Sending test alerts to channel ID: ${channelConfig.channelId}...`);
    
    // Create synthetic message templates
    await ctx.reply(`Sending test alerts to your channel ID: ${channelConfig.channelId}`);
    
    // Send raw messages directly to the channel as a simpler approach
    // Regular token alert
    await ctx.telegram.sendMessage(
      channelConfig.channelId,
      `
🚨 *NEW TOKEN DETECTED* 🚨

*Token*: Wrapped SOL (WSOL)
*Address*: \`So11111111111111111111111111111111111111112\`
*Liquidity*: 1.5K SOL

🔗 *Actions:*
• /buy So11111111111111111111111111111111111111112 - Buy with your configured settings
• https://jup.ag/swap/SOL-WSOL
      `,
      { 
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      } as any
    );
    
    // PNL report
    await ctx.telegram.sendMessage(
      channelConfig.channelId,
      `
🟢 *PNL UPDATE: WSOL* 🟢

*Token*: Wrapped SOL (WSOL)
*Address*: \`So11111111111111111111111111111111111111112\`
*Current Price*: 0.02300000 SOL
*PNL*: +0.250 SOL (+25.00%)

🔗 *Actions:*
• /sell So11111111111111111111111111111111111111112 100 - Sell all tokens
• https://birdeye.so/token/So11111111111111111111111111111111111111112?chain=solana - View on Birdeye
      `,
      { 
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      } as any
    );
    
    // Migration token alert
    await ctx.telegram.sendMessage(
      channelConfig.channelId,
      `
🚨 *MIGRATION TOKEN DETECTED* 🚨

*Token*: USD Coin (USDC)
*Address*: \`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v\`
*Liquidity*: 5.00K SOL
*Type*: 📊 Pump.fun Migration

This token has been migrated from the Pump.fun bonding curve to Raydium!

🔗 *Actions:*
• /buy EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v - Buy with your configured settings
• https://jup.ag/swap/SOL-USDC
      `,
      { 
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      } as any
    );
    
    await ctx.reply('✅ Test alerts sent successfully to your channel!');
  } catch (error: any) {
    console.error('Test channel error:', error);
    await ctx.reply(`❌ An error occurred: ${error.message}`);
  }
} 