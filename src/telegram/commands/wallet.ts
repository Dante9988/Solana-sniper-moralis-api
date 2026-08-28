import { Context } from 'telegraf';
import { jupiterService } from '../../services/jupiterService';
import { showWalletMenu } from '../showWalletMenu';
import { isTelegramAdmin, NOT_ADMIN_MESSAGE } from '../adminGuard';

export async function wallet(ctx: Context): Promise<void> {
  try {
    const userId = ctx.from?.id.toString();

    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return;
    }

    const message = ctx.message;
    if (!message || !('text' in message)) {
      await showWalletMenu(ctx);
      return;
    }

    const args = message.text.split(' ').slice(1);
    if (args.length === 0) {
      await showWalletMenu(ctx);
      return;
    }

    const subcommand = args[0].toLowerCase();

    switch (subcommand) {
      case 'connect':
        await handleConnectWallet(ctx, args.slice(1));
        break;
      case 'disconnect':
        await handleDisconnectWallet(ctx);
        break;
      default:
        await showWalletMenu(ctx);
    }
  } catch (error) {
    console.error('Wallet command error:', error);
    await ctx.reply('❌ An error occurred while processing your request.');
  }
}

async function handleConnectWallet(ctx: Context, args: string[]): Promise<void> {
  const userId = ctx.from?.id.toString();
  if (!userId) {
    await ctx.reply('❌ Failed to identify user.');
    return;
  }

  if (!isTelegramAdmin(userId)) {
    await ctx.reply(NOT_ADMIN_MESSAGE);
    return;
  }

  if (args.length === 0) {
    await ctx.reply(
      '❌ Please provide your wallet\'s public address (never a private key).\n\n' +
      'Usage: /wallet connect <public_address>'
    );
    return;
  }

  const result = await jupiterService.connectWallet(userId, args[0]);
  if ('error' in result) {
    await ctx.reply(`❌ ${result.error}`);
    return;
  }

  await ctx.reply(
    `✅ Wallet connected.\n\n` +
    `Address: <code>${result.walletAddress}</code>\n\n` +
    `This only lets the bot show your balance/positions and pre-fill trade amounts — it never grants signing access. ` +
    `Every /buy or /sell still requires you to approve the transaction yourself in your own wallet app.`,
    { parse_mode: 'HTML' }
  );

  await showWalletMenu(ctx);
}

async function handleDisconnectWallet(ctx: Context): Promise<void> {
  const userId = ctx.from?.id.toString();
  if (!userId) {
    await ctx.reply('❌ Failed to identify user.');
    return;
  }

  if (!isTelegramAdmin(userId)) {
    await ctx.reply(NOT_ADMIN_MESSAGE);
    return;
  }

  await jupiterService.disconnectWallet(userId);
  await ctx.reply('✅ Wallet disconnected. This only forgot your public address — the bot never held signing access to begin with.');
}
