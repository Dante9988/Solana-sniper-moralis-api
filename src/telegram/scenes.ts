import { Scenes, Markup } from 'telegraf';
import { jupiterService } from '../services/jupiterService';
import { setupConfigScenes } from './scenes/configScenes';
import { isTelegramAdmin, NOT_ADMIN_MESSAGE } from './adminGuard';

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
  
  // Scene for connecting a wallet by its PUBLIC address. Replaces the old
  // create/import scenes, which generated or accepted a PRIVATE key and
  // stored it in Postgres — this bot no longer holds signing authority over
  // any wallet at all (see ARCHITECTURE.md §8), so there is nothing left to
  // create or import, only a public address to remember.
  const connectWalletScene = new Scenes.BaseScene<any>('connect_wallet_scene');

  connectWalletScene.enter(async (ctx) => {
    const userId = ctx.from?.id.toString();
    if (!isTelegramAdmin(userId)) {
      await ctx.reply(NOT_ADMIN_MESSAGE);
      return ctx.scene.leave();
    }
    await ctx.reply(
      '🔗 <b>Connect Wallet</b>\n\n' +
      'Enter your wallet\'s PUBLIC address (never a private key or seed phrase — this bot never asks for one and never stores one):',
      { parse_mode: 'HTML' }
    );
  });

  connectWalletScene.on('text', async (ctx) => {
    const address = ctx.message.text.trim();
    const userId = ctx.from?.id.toString();

    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return ctx.scene.leave();
    }

    try {
      const result = await jupiterService.connectWallet(userId, address);

      if ('error' in result) {
        await ctx.reply(`❌ ${result.error}`);
        return ctx.scene.leave();
      }

      await ctx.reply(
        `✅ <b>Wallet Connected!</b>\n\n` +
        `<b>Address:</b>\n<code>${result.walletAddress}</code>\n\n` +
        `You can now use /buy and /sell — each one hands you a link/QR to approve in your own wallet app.`,
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
      console.error('Connect wallet error:', error);
      await ctx.reply('❌ Failed to connect wallet. Please try again.');
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
    connectWalletScene,
    ...configScenes
  ]);
  
  return stage;
} 