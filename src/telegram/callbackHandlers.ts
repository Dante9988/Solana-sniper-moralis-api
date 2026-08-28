import { Context, Markup } from 'telegraf';
import { Update } from 'telegraf/typings/core/types/typegram';
import { Scenes } from 'telegraf';
import { showAutoBuyMenu as showAutoBuyMenuFromModule, registerAutoBuyCallbacks } from './menus/autoBuyMenu';
import { jupiterService } from '../services/jupiterService';
import { wallet } from './commands/wallet';
import { buy } from './commands/buy';
import { sell } from './commands/sell';
import { config } from './commands/config';
import { togglePumpSwap } from './commands/togglePumpSwap';
import { service } from './commands/service';
import { pumpSettings } from './commands/pumpSettings';
import { toggleJito } from './commands/toggleJito';
import { getUserPreferredService, SwapService } from './commands/service';
import { showWalletMenu, getFormattedBalance } from './showWalletMenu';

// Define a custom type for context with match property and scene support
type MatchContext = Context<Update> & {
  match: RegExpExecArray;
  scene: Scenes.SceneContextScene<any>;
};

/**
 * Register all callback handlers for the bot
 */
export function registerCallbackHandlers(bot: any): void {
  // Main menu callbacks
  bot.action(/^action:(.+)$/, async (ctx: MatchContext) => {
    const action = ctx.match[1];
    
    switch (action) {
      case 'wallet':
      case 'wallets':
        return await showWalletMenu(ctx);
      case 'buy':
        return await showBuyMenu(ctx);
      case 'positions':
        return await showPositionsMenu(ctx);
      case 'sniper':
        return await showSniperMenu(ctx);
      case 'limits':
        return await showLimitsMenu(ctx);
      case 'autobuy':
        return await showAutoBuyMenuFromModule(ctx);
      case 'settings':
        return await showSettingsMenu(ctx);
      case 'refresh':
        return await showMainMenu(ctx); // Refresh main menu
      default:
        return await ctx.reply('Unknown action');
    }
  });
  
  // Wallet sub-menu callbacks
  bot.action(/^wallet:(.+)$/, async (ctx: MatchContext) => {
    const action = ctx.match[1];
    
    switch (action) {
      case 'create':
        return await ctx.scene.enter('connect_wallet_scene');
      case 'create_init':
        return await ctx.scene.enter('connect_wallet_scene');
      case 'import':
        return await ctx.scene.enter('connect_wallet_scene');
      case 'import_init':
        return await ctx.scene.enter('connect_wallet_scene');
      case 'balance':
        return await handleWalletBalance(ctx);
      case 'list':
        return await handleWalletList(ctx);
      case 'back':
        return await showMainMenu(ctx);
      default:
        return await showWalletMenu(ctx);
    }
  });
  
  // Buy sub-menu callbacks
  bot.action(/^buy:(.+)$/, async (ctx: MatchContext) => {
    const action = ctx.match[1];
    
    switch (action) {
      case 'token':
        return await ctx.reply('Please enter a token address to buy');
      case 'service':
        return await service(ctx);
      case 'back':
        return await showMainMenu(ctx);
      default:
        return await ctx.reply('Unknown buy action');
    }
  });
  
  // Positions sub-menu callbacks
  bot.action(/^positions:(.+)$/, async (ctx: MatchContext) => {
    const action = ctx.match[1];
    
    switch (action) {
      case 'view':
        return await handleViewPositions(ctx);
      case 'back':
        return await showMainMenu(ctx);
      default:
        return await ctx.reply('Unknown positions action');
    }
  });
  
  // Settings sub-menu callbacks
  bot.action(/^settings:(.+)$/, async (ctx: MatchContext) => {
    const action = ctx.match[1];
    
    switch (action) {
      case 'swap':
        return await service(ctx);
      case 'jito':
        return await toggleJito(ctx);
      case 'pumpswap':
        return await togglePumpSwap(ctx);
      case 'config':
        return await config(ctx);
      case 'pumpSettings':
        return await pumpSettings(ctx);
      case 'back':
        return await showMainMenu(ctx);
      case 'menu':
        return await showSettingsMenu(ctx);
      default:
        return await ctx.reply('Unknown settings action');
    }
  });
  
  // Configuration sub-menu callbacks
  bot.action(/^config:(.+)$/, async (ctx: MatchContext) => {
    const action = ctx.match[1];
    const userId = ctx.from?.id.toString();
    
    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return;
    }
    
    switch (action) {
      case 'view':
        const userConfig = await jupiterService.getUserConfig(userId);
        if (!userConfig) {
          await ctx.reply('❌ No configuration found. Please set up your configuration first.');
          return;
        }
        
        await ctx.reply(
          `📊 <b>Your Configuration:</b>\n\n` +
          `Auto Buy: ${userConfig.autoBuy ? '✅' : '❌'}\n` +
          `Auto Sell: ${userConfig.autoSell ? '✅' : '❌'}\n` +
          `Buy Amount: ${userConfig.buyAmount} SOL\n` +
          `Take Profit: ${userConfig.takeProfit}%\n` +
          `Stop Loss: ${userConfig.stopLoss}%`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [
                Markup.button.callback('⚙️ Edit Config', 'config:set_init'),
                Markup.button.callback('⬅️ Back', 'settings:menu')
              ]
            ])
          }
        );
        break;
        
      case 'set_init':
        await ctx.reply(
          '⚙️ <b>Configure Trading Settings</b>\n\n' +
          'Please use the following command to set your configuration:\n\n' +
          '<code>/config set &lt;autobuy&gt; &lt;amount&gt; &lt;takeprofit&gt; &lt;stoploss&gt; &lt;autosell&gt;</code>\n\n' +
          'Example:\n' +
          '<code>/config set true 0.1 50 15 true</code>\n\n' +
          '- <b>autobuy</b>: true/false - Enable automatic buying\n' +
          '- <b>amount</b>: SOL amount to use for buys (e.g. 0.1)\n' +
          '- <b>takeprofit</b>: Percentage for take profit (e.g. 50)\n' +
          '- <b>stoploss</b>: Percentage for stop loss (e.g. 15)\n' +
          '- <b>autosell</b>: true/false - Enable automatic selling',
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('⬅️ Back', 'settings:menu')]
            ])
          }
        );
        break;
        
      case 'toggle_autobuy':
        const currentAutoBuy = await jupiterService.getUserConfig(userId);
        const newAutoBuyValue = !(currentAutoBuy?.autoBuy);
        
        await jupiterService.updateUserConfig(userId, { autoBuy: newAutoBuyValue });
        await ctx.reply(
          `✅ Auto Buy has been ${newAutoBuyValue ? 'enabled' : 'disabled'}.`,
          {
            ...Markup.inlineKeyboard([
              [Markup.button.callback('⬅️ Back to Config', 'settings:config')]
            ])
          }
        );
        break;
        
      case 'toggle_autosell':
        const currentAutoSell = await jupiterService.getUserConfig(userId);
        const newAutoSellValue = !(currentAutoSell?.autoSell);
        
        await jupiterService.updateUserConfig(userId, { autoSell: newAutoSellValue });
        await ctx.reply(
          `✅ Auto Sell has been ${newAutoSellValue ? 'enabled' : 'disabled'}.`,
          {
            ...Markup.inlineKeyboard([
              [Markup.button.callback('⬅️ Back to Config', 'settings:config')]
            ])
          }
        );
        break;
        
      case 'set_amount':
        await ctx.reply(
          '💰 <b>Set Buy Amount</b>\n\n' +
          'Please enter the amount of SOL to use for buys using the following command:\n\n' +
          '<code>/config set_amount &lt;amount&gt;</code>\n\n' +
          'Example: <code>/config set_amount 0.1</code>',
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('⬅️ Back', 'settings:config')]
            ])
          }
        );
        break;
        
      case 'set_limits':
        await ctx.reply(
          '📊 <b>Set Take Profit / Stop Loss</b>\n\n' +
          'Please enter your TP/SL percentages using the following command:\n\n' +
          '<code>/config set_limits &lt;takeprofit&gt; &lt;stoploss&gt;</code>\n\n' +
          'Example: <code>/config set_limits 50 15</code>',
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('⬅️ Back', 'settings:config')]
            ])
          }
        );
        break;
        
      default:
        await config(ctx);
    }
  });
  
  // Sniper sub-menu callbacks
  bot.action(/^sniper:(.+)$/, async (ctx: MatchContext) => {
    const action = ctx.match[1];
    
    switch (action) {
      case 'enable':
        return await handleEnableSniper(ctx);
      case 'disable':
        return await handleDisableSniper(ctx);
      case 'config':
        return await handleSniperConfig(ctx);
      case 'back':
        return await showMainMenu(ctx);
      default:
        return await ctx.reply('Unknown sniper action');
    }
  });
  
  // Limits sub-menu callbacks
  bot.action(/^limits:(.+)$/, async (ctx: MatchContext) => {
    const action = ctx.match[1];
    
    switch (action) {
      case 'set':
        return await handleSetLimits(ctx);
      case 'view':
        return await handleViewLimits(ctx);
      case 'back':
        return await showMainMenu(ctx);
      default:
        return await ctx.reply('Unknown limits action');
    }
  });
  
  // Auto Buy sub-menu callbacks
  bot.action(/^autobuy:(.+)$/, async (ctx: MatchContext) => {
    const action = ctx.match[1];
    
    switch (action) {
      case 'enable':
        return await handleEnableAutoBuy(ctx);
      case 'disable':
        return await handleDisableAutoBuy(ctx);
      case 'config':
        return await handleAutoBuyConfig(ctx);
      case 'back':
        return await showMainMenu(ctx);
      default:
        return await ctx.reply('Unknown auto buy action');
    }
  });

  // Add new wallet-related callback handlers
  bot.action(/^wallet:create_init$/, async (ctx: MatchContext) => {
    await ctx.scene.enter('connect_wallet_scene');
  });

  bot.action(/^wallet:import_init$/, async (ctx: MatchContext) => {
    await ctx.scene.enter('connect_wallet_scene');
  });

  bot.action(/^wallet:change_default$/, async (ctx: MatchContext) => {
    const userId = ctx.from?.id.toString();
    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return;
    }
    
    const wallets = await jupiterService.getAllWallets(userId);
    
    if (!wallets || wallets.length < 2) {
      await ctx.reply('You need at least two wallets to change the default.');
      return;
    }
    
    const buttons = wallets.map((wallet, index) => 
      Markup.button.callback(
        `${wallet.name || `Wallet ${index + 1}`}`, 
        `wallet:set_default:${wallet.id}`
      )
    );
    
    // Create rows with 2 buttons per row
    const rows = [];
    for (let i = 0; i < buttons.length; i += 2) {
      rows.push(buttons.slice(i, i + 2));
    }
    
    // Add back button
    rows.push([Markup.button.callback('⬅️ Back', 'wallet:list')]);
    
    await ctx.reply(
      '🔄 <b>Select Default Wallet</b>\n\n' +
      'Choose which wallet you want to set as default:',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(rows)
      }
    );
  });

  bot.action(/^wallet:set_default:(.+)$/, async (ctx: MatchContext) => {
    const walletId = ctx.match[1];
    const userId = ctx.from?.id.toString();
    
    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return;
    }
    
    try {
      await jupiterService.setDefaultWallet(userId, walletId);
      await ctx.reply('✅ Default wallet has been updated!');
      await handleWalletList(ctx);
    } catch (error) {
      console.error('Error setting default wallet:', error);
      await ctx.reply('❌ Failed to update default wallet.');
    }
  });

  bot.action(/^wallet:rename_init$/, async (ctx: MatchContext) => {
    const userId = ctx.from?.id.toString();
    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return;
    }
    
    const wallets = await jupiterService.getAllWallets(userId);
    
    if (!wallets || wallets.length === 0) {
      await ctx.reply('You need at least one wallet to rename.');
      return;
    }
    
    const buttons = wallets.map((wallet, index) => 
      Markup.button.callback(
        `${wallet.name || `Wallet ${index + 1}`}`, 
        `wallet:rename_select:${wallet.id}`
      )
    );
    
    // Create rows with 2 buttons per row
    const rows = [];
    for (let i = 0; i < buttons.length; i += 2) {
      rows.push(buttons.slice(i, i + 2));
    }
    
    // Add back button
    rows.push([Markup.button.callback('⬅️ Back', 'wallet:list')]);
    
    await ctx.reply(
      '✏️ <b>Rename Wallet</b>\n\n' +
      'Select which wallet you want to rename:',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(rows)
      }
    );
  });

  bot.action(/^wallet:rename_select:(.+)$/, async (ctx: MatchContext) => {
    const walletId = ctx.match[1];
    await ctx.scene.enter('rename_wallet_scene', { walletId });
  });

  bot.action(/^wallet:delete_init$/, async (ctx: MatchContext) => {
    const userId = ctx.from?.id.toString();
    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return;
    }
    
    const wallets = await jupiterService.getAllWallets(userId);
    
    if (!wallets || wallets.length === 0) {
      await ctx.reply('You need at least one wallet to delete.');
      return;
    }
    
    const buttons = wallets.map((wallet, index) => 
      Markup.button.callback(
        `${wallet.name || `Wallet ${index + 1}`}`, 
        `wallet:delete_confirm:${wallet.id}`
      )
    );
    
    // Create rows with 2 buttons per row
    const rows = [];
    for (let i = 0; i < buttons.length; i += 2) {
      rows.push(buttons.slice(i, i + 2));
    }
    
    // Add back button
    rows.push([Markup.button.callback('⬅️ Back', 'wallet:list')]);
    
    await ctx.reply(
      '❌ <b>Delete Wallet</b>\n\n' +
      '⚠️ <b>WARNING:</b> This action cannot be undone!\n\n' +
      'Select which wallet you want to delete:',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(rows)
      }
    );
  });

  bot.action(/^wallet:delete_confirm:(.+)$/, async (ctx: MatchContext) => {
    const walletId = ctx.match[1];
    
    await ctx.reply(
      '❌ <b>Delete Wallet Confirmation</b>\n\n' +
      '⚠️ Are you absolutely sure you want to delete this wallet? This action cannot be undone!\n\n' +
      'Make sure you have backed up your private keys before proceeding.',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Yes, Delete Wallet', `wallet:delete_final:${walletId}`),
            Markup.button.callback('❌ No, Cancel', 'wallet:list')
          ]
        ])
      }
    );
  });

  bot.action(/^wallet:delete_final:(.+)$/, async (ctx: MatchContext) => {
    const walletId = ctx.match[1];
    const userId = ctx.from?.id.toString();
    
    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return;
    }
    
    try {
      await jupiterService.deleteWallet(userId, walletId);
      await ctx.reply('✅ Wallet has been deleted successfully!');
      await handleWalletList(ctx);
    } catch (error) {
      console.error('Error deleting wallet:', error);
      await ctx.reply('❌ Failed to delete wallet.');
    }
  });

  // This bot never generates, imports, or stores a private key — there is
  // nothing to export. Kept as a single explanatory handler so the old
  // "Export Private Key" button (still shown in some menus) doesn't dead-end.
  bot.action(/^wallet:export_init$/, async (ctx: MatchContext) => {
    await ctx.reply(
      '🔒 <b>Nothing to export</b>\n\n' +
      'This bot never generates, imports, or stores your private key — it never had one to begin with. ' +
      'Every trade is signed in your own wallet app.',
      { parse_mode: 'HTML' }
    );
  });

  // Non-custodial: funds are never held by this bot, so there is nothing to
  // withdraw. Kept as a single explanatory handler for the same reason as
  // wallet:export_init above.
  bot.action(/^wallet:withdraw_init$/, async (ctx: MatchContext) => {
    await ctx.reply(
      '🔒 <b>Nothing to withdraw</b>\n\n' +
      'This bot never custodies funds — your SOL and tokens stay in your own wallet at all times. ' +
      'Use your wallet app directly to move funds.',
      { parse_mode: 'HTML' }
    );
  });

  // Add these direct handler methods
  
  /**
   * Direct handler for sniper menu
   */
  bot.action(/^sniper:menu$/, async (ctx: MatchContext) => {
    await showSniperMenu(ctx);
  });
  
  /**
   * Direct handler for auto buy menu
   */
  bot.action(/^autobuy:menu$/, async (ctx: MatchContext) => {
    await showAutoBuyMenuFromModule(ctx);
  });
  
  /**
   * Direct handler for limits menu
   */
  bot.action(/^limits:menu$/, async (ctx: MatchContext) => {
    await showLimitsMenu(ctx);
  });
  
  /**
   * Direct handler for settings menu
   */
  bot.action(/^settings:menu$/, async (ctx: MatchContext) => {
    await showSettingsMenu(ctx);
  });

  // Register auto buy callbacks
  registerAutoBuyCallbacks(bot);
}

/**
 * Show the main menu
 */
export async function showMainMenu(ctx: Context): Promise<void> {
  try {
    const userId = ctx.from?.id.toString();
    const firstName = ctx.from?.first_name || 'there';
    
    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return;
    }

    // Check if user already has a wallet
    const wallet = await jupiterService.getWallet(userId);
    
    // Create the main message
    const welcomeMessage = `
🪐 <b>Welcome to the Solana Sniper Bot, ${firstName}!</b> 🪐

🚀 <i>The Fastest Solana Token Sniper Bot.</i>

💰 <b>Your Solana Wallets:</b>
${wallet 
  ? `• Primary - ${await getFormattedBalance(wallet.walletAddress)}\n<code>${wallet.walletAddress}</code>` 
  : "• No wallets found. Create one to get started!"
}

💡 <b>Ready to start trading?</b> Send a token address to get started.`;

    // Create a clear, organized menu with buttons - arranged for quick access like Nova
    const keyboard = Markup.inlineKeyboard([
      // Buy/Sell Row
      [
        Markup.button.callback('💼 Wallets', 'wallet:list'),
        Markup.button.callback('📊 Positions', 'positions:view')
      ],
      // Wallets/Positions Row
      [
        Markup.button.callback('🔵 Sniper', 'sniper:menu'),
        Markup.button.callback('⚡ Auto Buy', 'autobuy:menu')
      ],
      // Limits/Settings Row
      [
        Markup.button.callback('📈 Limits', 'limits:menu'),
        Markup.button.callback('⚙️ Settings', 'settings:menu')
      ],
      // Extra Options Row
      [
        Markup.button.callback('🔄 Refresh', 'action:refresh')
      ],
    ]);

    // Send the welcome message with the keyboard
    await ctx.reply(welcomeMessage, {
      parse_mode: 'HTML',
      ...keyboard
    });
    
    // Add these handler methods for direct access
    
    // Resources message
    const resourcesMessage = `
📋 <b>Resources:</b>
📖 <a href="https://t.me/SolanaSniper">Guide</a>
🐦 <a href="https://twitter.com/SolanaSniper">Twitter</a>
🔧 <a href="https://t.me/SolanaSniper">Support Channel</a>`;

    await ctx.reply(resourcesMessage, { 
      parse_mode: 'HTML'
    });
  } catch (error) {
    console.error('Show main menu error:', error);
    await ctx.reply('❌ An error occurred while showing the menu.');
  }
}

/**
 * Show the buy menu
 */
export async function showBuyMenu(ctx: Context): Promise<void> {
  try {
    const userId = ctx.from?.id.toString();
    
    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return;
    }

    // Get user's preferred service
    const preferredService = getUserPreferredService(userId);
    
    // Create the buy menu message
    const buyMessage = `
📊 <b>Buy Tokens</b>

Current service: <b>${preferredService === SwapService.JUPITER ? 'Jupiter' : 'Pump.fun'}</b>

Enter a token address or select an option below:`;

    // Create buy menu buttons
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('🔄 Enter Token Address', 'buy:token')
      ],
      [
        Markup.button.callback('🔄 Change Service', 'buy:service')
      ],
      [
        Markup.button.callback('⬅️ Back to Main Menu', 'buy:back')
      ]
    ]);

    // Send the buy menu
    await ctx.reply(buyMessage, {
      parse_mode: 'HTML',
      ...keyboard
    });
  } catch (error) {
    console.error('Show buy menu error:', error);
    await ctx.reply('❌ An error occurred while showing the buy menu.');
  }
}

/**
 * Show the positions menu
 */
export async function showPositionsMenu(ctx: Context): Promise<void> {
  try {
    const userId = ctx.from?.id.toString();
    
    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return;
    }
    
    // Create the positions menu message
    const positionsMessage = `
📋 <b>Your Positions</b>

View your current token holdings and transactions:`;

    // Create positions menu buttons
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('📋 View Positions', 'positions:view')
      ],
      [
        Markup.button.callback('⬅️ Back to Main Menu', 'positions:back')
      ]
    ]);

    // Send the positions menu
    await ctx.reply(positionsMessage, {
      parse_mode: 'HTML',
      ...keyboard
    });
  } catch (error) {
    console.error('Show positions menu error:', error);
    await ctx.reply('❌ An error occurred while showing the positions menu.');
  }
}

/**
 * Show the sniper menu
 */
export async function showSniperMenu(ctx: Context): Promise<void> {
  try {
    const userId = ctx.from?.id.toString();
    
    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return;
    }
    
    // Get user config to check if sniper is enabled
    const userConfig = await jupiterService.getUserConfig(userId);
    const sniperEnabled = userConfig?.autoBuy || false;
    
    // Create the sniper menu message
    const sniperMessage = `
🎯 <b>Token Sniper</b>

Status: ${sniperEnabled ? '✅ <b>Enabled</b>' : '❌ <b>Disabled</b>'}

Configure automatic token sniping:`;

    // Create sniper menu buttons
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('✅ Enable Sniper', 'sniper:enable'),
        Markup.button.callback('❌ Disable Sniper', 'sniper:disable')
      ],
      [
        Markup.button.callback('⚙️ Configure Sniper', 'sniper:config')
      ],
      [
        Markup.button.callback('⬅️ Back to Main Menu', 'sniper:back')
      ]
    ]);

    // Send the sniper menu
    await ctx.reply(sniperMessage, {
      parse_mode: 'HTML',
      ...keyboard
    });
  } catch (error) {
    console.error('Show sniper menu error:', error);
    await ctx.reply('❌ An error occurred while showing the sniper menu.');
  }
}

/**
 * Show the limits menu
 */
export async function showLimitsMenu(ctx: Context): Promise<void> {
  try {
    const userId = ctx.from?.id.toString();
    
    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return;
    }
    
    // Create the limits menu message
    const limitsMessage = `
📚 <b>Trading Limits</b>

Configure your trading limits:`;

    // Create limits menu buttons
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('⚙️ Set Limits', 'limits:set')
      ],
      [
        Markup.button.callback('📋 View Limits', 'limits:view')
      ],
      [
        Markup.button.callback('⬅️ Back to Main Menu', 'limits:back')
      ]
    ]);

    // Send the limits menu
    await ctx.reply(limitsMessage, {
      parse_mode: 'HTML',
      ...keyboard
    });
  } catch (error) {
    console.error('Show limits menu error:', error);
    await ctx.reply('❌ An error occurred while showing the limits menu.');
  }
}

/**
 * Show the auto buy menu
 */
export async function showAutoBuyMenu(ctx: Context): Promise<void> {
  try {
    const userId = ctx.from?.id.toString();
    
    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return;
    }
    
    // Get user config to check if auto buy is enabled
    const userConfig = await jupiterService.getUserConfig(userId);
    const autoBuyEnabled = userConfig?.autoBuy || false;
    
    // Create the auto buy menu message
    const autoBuyMessage = `
🤖 <b>Auto Buy</b>

Status: ${autoBuyEnabled ? '✅ <b>Enabled</b>' : '❌ <b>Disabled</b>'}

Configure automatic token buying:`;

    // Create auto buy menu buttons
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('✅ Enable Auto Buy', 'autobuy:enable'),
        Markup.button.callback('❌ Disable Auto Buy', 'autobuy:disable')
      ],
      [
        Markup.button.callback('⚙️ Configure Auto Buy', 'autobuy:config')
      ],
      [
        Markup.button.callback('⬅️ Back to Main Menu', 'autobuy:back')
      ]
    ]);

    // Send the auto buy menu
    await ctx.reply(autoBuyMessage, {
      parse_mode: 'HTML',
      ...keyboard
    });
  } catch (error) {
    console.error('Show auto buy menu error:', error);
    await ctx.reply('❌ An error occurred while showing the auto buy menu.');
  }
}

/**
 * Show the settings menu
 */
export async function showSettingsMenu(ctx: Context): Promise<void> {
  try {
    const userId = ctx.from?.id.toString();
    
    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return;
    }
    
    // Create the settings menu message
    const settingsMessage = `
⚙️ <b>Bot Settings</b>

Configure your bot settings:`;

    // Create settings menu buttons
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('🔄 Swap Service', 'settings:swap'),
        Markup.button.callback('🛡️ Jito Protection', 'settings:jito')
      ],
      [
        Markup.button.callback('📢 PumpSwap Alerts', 'settings:pumpswap'),
        Markup.button.callback('⚙️ Trading Config', 'settings:config')
      ],
      [
        Markup.button.callback('⚡ Pump.fun Settings', 'settings:pumpSettings')
      ],
      [
        Markup.button.callback('⬅️ Back to Main Menu', 'settings:back')
      ]
    ]);

    // Send the settings menu
    await ctx.reply(settingsMessage, {
      parse_mode: 'HTML',
      ...keyboard
    });
  } catch (error) {
    console.error('Show settings menu error:', error);
    await ctx.reply('❌ An error occurred while showing the settings menu.');
  }
}

// Helper functions for callback handlers

async function handleWalletBalance(ctx: Context): Promise<void> {
  try {
    const userId = ctx.from?.id.toString();
    
    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return;
    }
    
    const userWallet = await jupiterService.getWallet(userId);
    
    if (!userWallet) {
      await ctx.reply('❌ No wallet found. Please create or import a wallet first.');
      return;
    }
    
    const formattedBalance = await getFormattedBalance(userWallet.walletAddress);
    
    await ctx.reply(
      `💰 <b>Wallet Balance</b>\n\n${formattedBalance}\n<code>${userWallet.walletAddress}</code>`,
      { parse_mode: 'HTML' }
    );
  } catch (error) {
    console.error('Handle wallet balance error:', error);
    await ctx.reply('❌ An error occurred while checking your balance.');
  }
}

async function handleWalletList(ctx: MatchContext): Promise<void> {
  try {
    const userId = ctx.from?.id.toString();
    
    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return;
    }
    
    // Get all wallets for this user
    const wallets = await jupiterService.getAllWallets(userId);
    
    if (!wallets || wallets.length === 0) {
      await ctx.reply(
        '📋 <b>No wallets found</b>\n\n' +
        'You need to create or import a wallet first.\n\n' +
        'Use the buttons below to manage your wallets:',
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('➕ Create Wallet', 'wallet:create_init'),
              Markup.button.callback('📥 Import Wallet', 'wallet:import_init')
            ],
            [
              Markup.button.callback('⬅️ Back', 'wallet:back')
            ]
          ])
        }
      );
      return;
    }
    
    // Format wallets list message
    let message = '💼 <b>Your Solana Wallets:</b>\n\n';
    
    for (const [index, wallet] of wallets.entries()) {
      const balance = await getFormattedBalance(wallet.walletAddress);
      const isDefault = index === 0 ? ' (Default)' : '';
      
      message += `• <b>${wallet.name || `Wallet ${index + 1}`}${isDefault}</b>\n`;
      message += `${balance}\n`;
      message += `<code>${wallet.walletAddress}</code>\n\n`;
    }
    
    message += 'Select an option below to manage your wallets:';
    
    // Create wallet menu buttons
    await ctx.reply(message, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('➕ Create Wallet', 'wallet:create_init'),
          Markup.button.callback('📥 Import Wallet', 'wallet:import_init')
        ],
        [
          Markup.button.callback('🔄 Change Default', 'wallet:change_default'),
          Markup.button.callback('✏️ Rename Wallet', 'wallet:rename_init')
        ],
        [
          Markup.button.callback('❌ Delete Wallet', 'wallet:delete_init'),
          Markup.button.callback('💸 Withdraw', 'wallet:withdraw_init')
        ],
        [
          Markup.button.callback('🔑 Export Private Key', 'wallet:export_init'),
          Markup.button.callback('🔄 Refresh', 'wallet:list')
        ],
        [
          Markup.button.callback('⬅️ Back to Main Menu', 'wallet:back')
        ]
      ])
    });
  } catch (error) {
    console.error('Handle wallet list error:', error);
    await ctx.reply('❌ An error occurred while listing your wallets.');
  }
}

async function handleViewPositions(ctx: Context): Promise<void> {
  try {
    const userId = ctx.from?.id.toString();
    
    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return;
    }
    
    // Check if user has a wallet
    const wallet = await jupiterService.getWallet(userId);
    if (!wallet) {
      await ctx.reply(
        '❌ You need to create a wallet first before you can view positions.\n\n' +
        'Use /wallet to create or import a wallet.',
        { parse_mode: 'HTML' }
      );
      return;
    }
    
    // Get wallet SOL balance
    const formattedBalance = await getFormattedBalance(wallet.walletAddress);
    
    // Get token positions
    const positions = await jupiterService.getUserTokenPositions(userId);
    
    if (positions.length === 0) {
      await ctx.reply(
        `📋 <b>Your Positions</b>\n\n` +
        `💰 Wallet: <code>${wallet.walletAddress}</code>\n` +
        `${formattedBalance}\n\n` +
        `No tokens found in your wallet. Use /buy to purchase some tokens!`,
        { 
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('💰 Buy Tokens', 'buy:token')],
            [Markup.button.callback('⬅️ Back', 'action:refresh')]
          ])
        }
      );
      return;
    }
    
    // Format positions
    let positionsMessage = `📋 <b>Your Positions</b>\n\n`;
    positionsMessage += `💰 Wallet: <code>${wallet.walletAddress}</code>\n`;
    positionsMessage += `${formattedBalance}\n\n`;
    positionsMessage += `<b>Token Holdings:</b>\n\n`;
    
    for (const position of positions) {
      const pnlText = position.pnl !== undefined 
        ? `${position.pnl >= 0 ? '🟢' : '🔴'} PNL: ${position.pnl.toFixed(2)} SOL (${position.pnlPercentage?.toFixed(2)}%)`
        : '';
      
      positionsMessage += `🪙 <b>${position.tokenSymbol || 'Unknown'}</b> - ${position.tokenName || 'Unknown Token'}\n`;
      positionsMessage += `Balance: ${position.balance.toFixed(6)}\n`;
      positionsMessage += `Address: <code>${position.tokenMint}</code>\n`;
      
      if (pnlText) {
        positionsMessage += `${pnlText}\n`;
      }
      
      positionsMessage += `\n`;
    }
    
    // Add sell buttons
    await ctx.reply(positionsMessage, { 
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('💱 Sell Tokens', 'sell:select_token')],
        [Markup.button.callback('🔄 Refresh', 'positions:view')],
        [Markup.button.callback('⬅️ Back', 'action:refresh')]
      ])
    });
    
  } catch (error) {
    console.error('Handle view positions error:', error);
    await ctx.reply('❌ An error occurred while viewing your positions.');
  }
}

async function handleEnableSniper(ctx: Context): Promise<void> {
  try {
    const userId = ctx.from?.id.toString();
    
    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return;
    }
    
    await jupiterService.updateUserConfig(userId, { autoBuy: true });
    await ctx.reply('✅ Sniper has been enabled!');
    
    // Show the updated sniper menu
    await showSniperMenu(ctx);
  } catch (error) {
    console.error('Handle enable sniper error:', error);
    await ctx.reply('❌ An error occurred while enabling the sniper.');
  }
}

async function handleDisableSniper(ctx: Context): Promise<void> {
  try {
    const userId = ctx.from?.id.toString();
    
    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return;
    }
    
    await jupiterService.updateUserConfig(userId, { autoBuy: false });
    await ctx.reply('❌ Sniper has been disabled!');
    
    // Show the updated sniper menu
    await showSniperMenu(ctx);
  } catch (error) {
    console.error('Handle disable sniper error:', error);
    await ctx.reply('❌ An error occurred while disabling the sniper.');
  }
}

async function handleSniperConfig(ctx: Context): Promise<void> {
  // Implementation would be added here
  await ctx.reply('⚙️ Please use /config command to configure the sniper settings.');
}

async function handleSetLimits(ctx: Context): Promise<void> {
  // Implementation would be added here
  await ctx.reply('⚙️ Please use /config command to set your trading limits.');
}

async function handleViewLimits(ctx: Context): Promise<void> {
  try {
    const userId = ctx.from?.id.toString();
    
    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return;
    }
    
    const userConfig = await jupiterService.getUserConfig(userId);
    
    if (!userConfig) {
      await ctx.reply('❌ No configuration found. Please set up your configuration first.');
      return;
    }
    
    await ctx.reply(
      `📊 <b>Your Trading Limits</b>\n\n` +
      `💰 Buy Amount: <b>${userConfig.buyAmount} SOL</b>\n` +
      `📈 Take Profit: <b>${userConfig.takeProfit}%</b>\n` +
      `📉 Stop Loss: <b>${userConfig.stopLoss}%</b>\n` +
      `🔄 Auto Sell: <b>${userConfig.autoSell ? 'Enabled' : 'Disabled'}</b>`,
      { parse_mode: 'HTML' }
    );
  } catch (error) {
    console.error('Handle view limits error:', error);
    await ctx.reply('❌ An error occurred while viewing your limits.');
  }
}

// Add this near the Auto Buy sub-menu callbacks
async function handleEnableAutoBuy(ctx: Context): Promise<void> {
  try {
    const userId = ctx.from?.id.toString();
    
    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return;
    }
    
    await jupiterService.updateUserConfig(userId, { autoBuy: true });
    await ctx.reply('✅ Auto Buy has been enabled!');
    
    // Show the updated auto buy menu
    await showAutoBuyMenu(ctx);
  } catch (error) {
    console.error('Handle enable auto buy error:', error);
    await ctx.reply('❌ An error occurred while enabling auto buy.');
  }
}

async function handleDisableAutoBuy(ctx: Context): Promise<void> {
  try {
    const userId = ctx.from?.id.toString();
    
    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return;
    }
    
    await jupiterService.updateUserConfig(userId, { autoBuy: false });
    await ctx.reply('❌ Auto Buy has been disabled!');
    
    // Show the updated auto buy menu
    await showAutoBuyMenu(ctx);
  } catch (error) {
    console.error('Handle disable auto buy error:', error);
    await ctx.reply('❌ An error occurred while disabling auto buy.');
  }
}

async function handleAutoBuyConfig(ctx: Context): Promise<void> {
  // Implementation would be added here
  await ctx.reply('⚙️ Please use /config command to configure auto buy settings.');
}