import { Context } from 'telegraf';
import { sniperooService, isWalletData } from '../../services/sniperooService';

export async function wallet(ctx: Context): Promise<void> {
  try {
    const args = ctx.message?.text?.split(' ');
    if (!args || args.length < 2) {
      await ctx.reply(
        '⚠️ Subcommand required.\n\n' +
        'Usage:\n' +
        '/wallet create <name> - Create a new wallet\n' +
        '/wallet import <private_key> - Import an existing wallet'
      );
      return;
    }

    const subcommand = args[1].toLowerCase();
    const userId = ctx.from?.id.toString();

    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return;
    }

    if (subcommand === 'create') {
      if (args.length < 3) {
        await ctx.reply('⚠️ Wallet name is required.\nUsage: /wallet create <name>');
        return;
      }

      const name = args[2];
      const result = await sniperooService.createWallet(userId, name);
      
      if (isWalletData(result)) {
        // Send private key in a separate message that can be deleted by the user
        await ctx.reply(
          `✅ Wallet "${name}" created successfully!\n\n` +
          `🔑 Public Key: \`${result.walletAddress}\`\n\n` +
          `⚠️ I'll send your private key in the next message. Please save it securely and delete the message afterwards.`,
          { parse_mode: 'Markdown' }
        );
        
        // Send private key as a separate message
        await ctx.reply(
          `🔐 Private Key: \`${result.walletPk}\`\n\n` +
          `⚠️ PLEASE READ CAREFULLY:\n` +
          `• Never share your private key with anyone\n` +
          `• Store these details securely offline\n` +
          `• This is the ONLY time you'll see the private key\n` +
          `• Anyone with your private key can access your funds`,
          { parse_mode: 'Markdown' }
        );
      } else {
        await ctx.reply(`❌ ${result.error}`);
      }
    } else if (subcommand === 'import') {
      if (args.length < 3) {
        await ctx.reply('⚠️ Private key is required.\nUsage: /wallet import <private_key>');
        return;
      }

      const privateKey = args[2];
      const result = await sniperooService.importWallet(userId, privateKey);
      
      if (isWalletData(result)) {
        await ctx.reply(
          `✅ Wallet imported successfully!\n\nPublic Key: \`${result.walletAddress}\``,
          { parse_mode: 'Markdown' }
        );
      } else {
        await ctx.reply(`❌ ${result.error}\nPlease try again or contact support if the issue persists.`);
      }
    } else {
      await ctx.reply(
        '⚠️ Invalid subcommand.\n\n' +
        'Available commands:\n' +
        '/wallet create <name> - Create a new wallet\n' +
        '/wallet import <private_key> - Import an existing wallet'
      );
    }
  } catch (error) {
    console.error('Wallet command error:', error);
    const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred';
    await ctx.reply(`❌ Error: ${errorMessage}\nPlease try again or contact support if the issue persists.`);
  }
} 