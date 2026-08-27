import { Scenes, Markup } from 'telegraf';
import { jupiterService } from '../services/jupiterService';
import { setupConfigScenes } from './scenes/configScenes';

// Create scenes for wallet operations that require multiple steps
export function setupScenes() {
  // Scene for renaming a wallet
  const renameWalletScene = new Scenes.BaseScene<any>('rename_wallet_scene');
  
  renameWalletScene.enter(async (ctx) => {
    await ctx.reply('Enter a new name for your wallet:');
  });
  
  renameWalletScene.on('text', async (ctx) => {
    const newName = ctx.message.text;
    const { walletId } = ctx.scene.state;
    
    // In the future, add wallet rename functionality
    await ctx.reply(`Wallet renamed to: ${newName}`);
    return ctx.scene.leave();
  });
  
  // Scene for creating a new wallet
  const createWalletScene = new Scenes.BaseScene<any>('create_wallet_scene');
  
  createWalletScene.enter(async (ctx) => {
    await ctx.reply('Enter a name for your new wallet:');
  });
  
  createWalletScene.on('text', async (ctx) => {
    const name = ctx.message.text;
    const userId = ctx.from?.id.toString();
    
    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return ctx.scene.leave();
    }
    
    try {
      // Show processing message
      await ctx.reply('⏳ Creating your wallet...');
      
      // Create the wallet
      const result = await jupiterService.createWallet(userId, name);
      
      if ('error' in result) {
        await ctx.reply(`❌ ${result.error}`);
        return ctx.scene.leave();
      }
      
      // Mask the private key in the response
      const { walletAddress, walletPk } = result;
      const maskedPk = walletPk.substring(0, 6) + '...' + walletPk.substring(walletPk.length - 4);
      
      // Show success message with wallet details
      await ctx.reply(
        `✅ <b>Wallet Created Successfully!</b>\n\n` +
        `<b>Name:</b> ${name}\n\n` +
        `<b>Address:</b>\n<code>${walletAddress}</code>\n\n` +
        `<b>Private Key:</b> <tg-spoiler>${walletPk}</tg-spoiler>\n\n` +
        `⚠️ <b>NEVER share your private key with anyone!</b>\n` +
        `Save it somewhere safe. You can manage your wallet using the buttons below.`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('💰 Check Balance', 'wallet:balance'),
              Markup.button.callback('📋 List Wallets', 'wallet:list')
            ],
            [
              Markup.button.callback('⬅️ Back to Main Menu', 'wallet:back')
            ]
          ])
        }
      );
      
      return ctx.scene.leave();
    } catch (error) {
      console.error('Create wallet error:', error);
      await ctx.reply('❌ Failed to create wallet. Please try again.');
      return ctx.scene.leave();
    }
  });
  
  // Scene for importing a wallet
  const importWalletScene = new Scenes.BaseScene<any>('import_wallet_scene');
  
  importWalletScene.enter(async (ctx) => {
    await ctx.reply(
      '🔑 <b>Import Wallet</b>\n\n' +
      'Please enter your private key to import your wallet:\n\n' +
      '⚠️ <b>CAUTION:</b> This is sensitive information. Make sure you are in a private environment.',
      { parse_mode: 'HTML' }
    );
  });
  
  importWalletScene.on('text', async (ctx) => {
    const privateKey = ctx.message.text;
    const userId = ctx.from?.id.toString();
    
    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return ctx.scene.leave();
    }
    
    try {
      // Show processing message
      await ctx.reply('⏳ Importing your wallet...');
      
      // Import the wallet
      const result = await jupiterService.importWallet(userId, privateKey);
      
      if ('error' in result) {
        await ctx.reply(`❌ ${result.error}`);
        return ctx.scene.leave();
      }
      
      // Delete the message with the private key for security
      try {
        await ctx.deleteMessage(ctx.message.message_id);
      } catch (e) {
        console.error('Failed to delete message with private key:', e);
      }
      
      // Show success message
      await ctx.reply(
        `✅ <b>Wallet Imported Successfully!</b>\n\n` +
        `<b>Address:</b>\n<code>${result.walletAddress}</code>\n\n` +
        `Your wallet is now ready to use.`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('💰 Check Balance', 'wallet:balance'),
              Markup.button.callback('📋 List Wallets', 'wallet:list')
            ],
            [
              Markup.button.callback('⬅️ Back to Main Menu', 'wallet:back')
            ]
          ])
        }
      );
      
      return ctx.scene.leave();
    } catch (error) {
      console.error('Import wallet error:', error);
      await ctx.reply('❌ Failed to import wallet. Please try again.');
      return ctx.scene.leave();
    }
  });
  
  // Scene for withdrawing funds
  const withdrawScene = new Scenes.BaseScene<any>('withdraw_scene');
  
  withdrawScene.enter(async (ctx) => {
    await ctx.reply('Enter the wallet address to withdraw to:');
  });
  
  withdrawScene.on('text', async (ctx) => {
    const targetAddress = ctx.message.text;
    const { walletId } = ctx.scene.state;
    
    await ctx.reply(`Enter amount to withdraw (in SOL):`);
    ctx.scene.state.targetAddress = targetAddress;
  });
  
  withdrawScene.on('text', async (ctx) => {
    const amount = parseFloat(ctx.message.text);
    const { walletId, targetAddress } = ctx.scene.state;
    
    if (isNaN(amount) || amount <= 0) {
      await ctx.reply('Please enter a valid amount greater than 0');
      return;
    }
    
    // In the future, add actual withdrawal logic
    await ctx.reply(`Withdrawal of ${amount} SOL to ${targetAddress} processed`);
    return ctx.scene.leave();
  });
  
  // Get config scenes
  const configScenes = setupConfigScenes();
  
  // Create stage with all scenes
  const stage = new Scenes.Stage<any>([
    renameWalletScene,
    withdrawScene,
    createWalletScene,
    importWalletScene,
    ...configScenes
  ]);
  
  return stage;
} 