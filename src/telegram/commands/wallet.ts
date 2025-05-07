import { Context } from 'telegraf';
import { jupiterService } from '../../services/jupiterService';
import { showWalletMenu } from '../showWalletMenu';

export async function wallet(ctx: Context): Promise<void> {
  try {
    const userId = ctx.from?.id.toString();
    
    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return;
    }

    // Parse command arguments
    const message = ctx.message;
    if (!message || !('text' in message)) {
      await showWalletMenu(ctx);
      return;
    }

    const args = message.text.split(' ').slice(1);
    
    // If no arguments provided, show wallet menu
    if (args.length === 0) {
      await showWalletMenu(ctx);
      return;
    }
    
    // Process wallet commands
    const subcommand = args[0].toLowerCase();
    
    switch (subcommand) {
      case 'create':
        await handleCreateWallet(ctx, args.slice(1));
        break;
      case 'import':
        await handleImportWallet(ctx, args.slice(1));
        break;
      default:
        await showWalletMenu(ctx);
    }
  } catch (error) {
    console.error('Wallet command error:', error);
    await ctx.reply('❌ An error occurred while processing your request.');
  }
}

async function handleCreateWallet(ctx: Context, args: string[]): Promise<void> {
  const userId = ctx.from?.id.toString();
  
  if (!userId) {
    await ctx.reply('❌ Failed to identify user.');
    return;
  }
  
  if (args.length === 0) {
    await ctx.reply('❌ Please provide a name for your wallet. Usage: /wallet create <name>');
    return;
  }
  
  const name = args.join(' ');
  
  try {
    const result = await jupiterService.createWallet(userId, name);
    
    if ('error' in result) {
      await ctx.reply(`❌ ${result.error}`);
      return;
    }
    
    await ctx.reply(
      `✅ Wallet created successfully!\n\n` +
      `Address: <code>${result.walletAddress}</code>\n\n` +
      `Your wallet is now ready to use.`,
      { parse_mode: 'HTML' }
    );
    
    // Show wallet menu with the new wallet
    await showWalletMenu(ctx);
  } catch (error) {
    console.error('Create wallet error:', error);
    await ctx.reply('❌ Failed to create wallet. Please try again.');
  }
}

async function handleImportWallet(ctx: Context, args: string[]): Promise<void> {
  const userId = ctx.from?.id.toString();
  
  if (!userId) {
    await ctx.reply('❌ Failed to identify user.');
    return;
  }
  
  if (args.length === 0) {
    await ctx.reply('❌ Please provide a private key. Usage: /wallet import <private_key>');
    return;
  }
  
  const privateKey = args[0];
  
  try {
    const result = await jupiterService.importWallet(userId, privateKey);
    
    if ('error' in result) {
      await ctx.reply(`❌ ${result.error}`);
      return;
    }
    
    await ctx.reply(
      `✅ Wallet imported successfully!\n\n` +
      `Address: <code>${result.walletAddress}</code>\n\n` +
      `Your wallet is now ready to use.`,
      { parse_mode: 'HTML' }
    );
    
    // Show wallet menu with the imported wallet
    await showWalletMenu(ctx);
  } catch (error) {
    console.error('Import wallet error:', error);
    await ctx.reply('❌ Failed to import wallet. Please try again.');
  }
} 