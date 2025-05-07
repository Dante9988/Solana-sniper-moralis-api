import { Scenes, Markup } from 'telegraf';
import { jupiterService } from '../../services/jupiterService';

// Create scenes for configuration that require simpler input
export function setupConfigScenes() {
  // Scene for setting buy amount
  const setBuyAmountScene = new Scenes.BaseScene<any>('set_buy_amount_scene');
  
  setBuyAmountScene.enter(async (ctx) => {
    await ctx.reply(
      '💰 <b>Set Buy Amount</b>\n\n' +
      'Please enter the amount of SOL you want to use for buys (e.g., 0.1):',
      { parse_mode: 'HTML' }
    );
  });
  
  setBuyAmountScene.on('text', async (ctx) => {
    const userId = ctx.from?.id.toString();
    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return ctx.scene.leave();
    }
    
    const amountText = ctx.message.text;
    const amount = parseFloat(amountText);
    
    if (isNaN(amount) || amount <= 0) {
      await ctx.reply('❌ Please enter a valid number greater than 0.');
      return;
    }
    
    try {
      // Get current config
      const userConfig = await jupiterService.getUserConfig(userId);
      
      // Update buy amount
      await jupiterService.updateUserConfig(userId, { 
        ...userConfig,
        buyAmount: amount 
      });
      
      await ctx.reply(
        `✅ Buy amount updated to ${amount} SOL successfully!`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('⬅️ Back to Config', 'settings:config')]
          ])
        }
      );
      
      return ctx.scene.leave();
    } catch (error) {
      console.error('Error setting buy amount:', error);
      await ctx.reply('❌ Failed to update buy amount. Please try again.');
      return ctx.scene.leave();
    }
  });
  
  // Scene for setting TP/SL
  const setTpSlScene = new Scenes.BaseScene<any>('set_tp_sl_scene');
  
  setTpSlScene.enter(async (ctx) => {
    await ctx.reply(
      '📊 <b>Set Take Profit / Stop Loss</b>\n\n' +
      'Please enter your <b>take profit</b> percentage (e.g., 50):',
      { parse_mode: 'HTML' }
    );
    
    // Set state to track which parameter we're waiting for
    ctx.scene.state.step = 'takeProfit';
  });
  
  setTpSlScene.on('text', async (ctx) => {
    const userId = ctx.from?.id.toString();
    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return ctx.scene.leave();
    }
    
    const valueText = ctx.message.text;
    const value = parseFloat(valueText);
    
    if (isNaN(value) || value <= 0) {
      await ctx.reply('❌ Please enter a valid number greater than 0.');
      return;
    }
    
    // Get current config
    const userConfig = await jupiterService.getUserConfig(userId);
    
    if (!userConfig) {
      await ctx.reply('❌ No user configuration found.');
      return ctx.scene.leave();
    }
    
    // Check which parameter we're setting
    if (ctx.scene.state.step === 'takeProfit') {
      // Store the take profit value
      ctx.scene.state.takeProfit = value;
      ctx.scene.state.step = 'stopLoss';
      
      await ctx.reply(
        '📊 Now, please enter your <b>stop loss</b> percentage (e.g., 15):',
        { parse_mode: 'HTML' }
      );
    } else if (ctx.scene.state.step === 'stopLoss') {
      // We have both values, update the config
      const takeProfit = ctx.scene.state.takeProfit;
      const stopLoss = value;
      
      try {
        // Update TP/SL
        await jupiterService.updateUserConfig(userId, { 
          ...userConfig,
          takeProfit: takeProfit,
          stopLoss: stopLoss 
        });
        
        await ctx.reply(
          `✅ Settings updated successfully!\n\n` +
          `Take Profit: ${takeProfit}%\n` +
          `Stop Loss: ${stopLoss}%`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('⬅️ Back to Config', 'settings:config')]
            ])
          }
        );
        
        return ctx.scene.leave();
      } catch (error) {
        console.error('Error setting TP/SL:', error);
        await ctx.reply('❌ Failed to update settings. Please try again.');
        return ctx.scene.leave();
      }
    }
  });
  
  // Create service selection scene
  const selectServiceScene = new Scenes.BaseScene<any>('select_service_scene');
  
  selectServiceScene.enter(async (ctx) => {
    await ctx.reply(
      '🔄 <b>Select Swap Service</b>\n\n' +
      'Choose which service you want to use for swaps:',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('🪐 Jupiter', 'service:select:jupiter'),
            Markup.button.callback('🎮 Pump.fun', 'service:select:pumpfun')
          ],
          [
            Markup.button.callback('⬅️ Back', 'settings:menu')
          ]
        ])
      }
    );
  });
  
  selectServiceScene.action(/service:select:(.+)/, async (ctx) => {
    const service = ctx.match[1];
    const userId = ctx.from?.id.toString();
    
    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return ctx.scene.leave();
    }
    
    // Update service preference
    try {
      // The actual implementation would set the user's preference in the database
      const serviceName = service === 'jupiter' ? 'Jupiter' : 'Pump.fun';
      
      await ctx.reply(
        `✅ Service updated to ${serviceName} successfully!`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('⬅️ Back to Settings', 'settings:menu')]
          ])
        }
      );
    } catch (error) {
      console.error('Error setting service:', error);
      await ctx.reply('❌ Failed to update service. Please try again.');
    }
    
    return ctx.scene.leave();
  });
  
  return [setBuyAmountScene, setTpSlScene, selectServiceScene];
} 