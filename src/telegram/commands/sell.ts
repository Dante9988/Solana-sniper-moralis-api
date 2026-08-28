import { Context } from 'telegraf';
import { createSellIntent, SolanaPayConfigError } from '../../services/solanaPayService';
import { renderQrPng } from '../../services/qrCode';
import { showSellMenu } from '../showSellMenu';
import { isTelegramAdmin, NOT_ADMIN_MESSAGE } from '../adminGuard';

const TOKEN_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function sell(ctx: Context): Promise<void> {
  try {
    const userId = ctx.from?.id.toString();

    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return;
    }

    if (!isTelegramAdmin(userId)) {
      await ctx.reply(NOT_ADMIN_MESSAGE);
      return;
    }

    const message = ctx.message;
    if (!message || !('text' in message)) {
      await showSellMenu(ctx);
      return;
    }

    const args = message.text.split(' ').slice(1);
    if (args.length === 0) {
      await showSellMenu(ctx);
      return;
    }

    if (args.length < 2) {
      await ctx.reply('❌ Please provide both token address and percentage. Usage: /sell <token_address> <percentage>');
      return;
    }

    const tokenAddress = args[0];
    if (!TOKEN_ADDRESS_RE.test(tokenAddress)) {
      await ctx.reply('❌ Invalid token address format. Please provide a valid Solana token address.');
      return;
    }

    const percentage = parseInt(args[1], 10);
    if (isNaN(percentage) || percentage <= 0 || percentage > 100) {
      await ctx.reply('❌ Percentage must be a number between 1 and 100.');
      return;
    }

    await sendSellPayLink(ctx, tokenAddress, percentage);
  } catch (error) {
    console.error('Sell command error:', error);
    await ctx.reply('❌ An error occurred while processing your request.');
  }
}

export async function sendSellPayLink(ctx: Context, tokenAddress: string, percentage: number): Promise<void> {
  try {
    const { url } = createSellIntent(tokenAddress, percentage);
    const qr = await renderQrPng(url);

    await ctx.replyWithPhoto(
      { source: qr },
      {
        caption:
          `💱 <b>Sell ${percentage}% of</b>\n<code>${tokenAddress}</code>\n\n` +
          `Open this link in your Solana wallet (Phantom, Solflare, …) or scan the QR code to review and approve — ` +
          `this bot never sees or holds your private key, and the sell amount is computed from your wallet's real on-chain balance at approval time.\n\n` +
          `<a href="${url}">${url}</a>`,
        parse_mode: 'HTML',
      }
    );
  } catch (error) {
    if (error instanceof SolanaPayConfigError) {
      console.error('Solana Pay config error:', error.message);
      await ctx.reply('❌ This bot is not configured to accept trades right now (missing SOLANA_PAY_BASE_URL). Contact the operator.');
      return;
    }
    console.error('Error creating sell pay link:', error);
    await ctx.reply(`❌ ${error instanceof Error ? error.message : 'Failed to create a sell request.'}`);
  }
}
