import { Context } from 'telegraf';
import { jupiterService } from '../../services/jupiterService';
import { createBuyIntent, SolanaPayConfigError } from '../../services/solanaPayService';
import { renderQrPng } from '../../services/qrCode';
import { showBuyMenu } from '../showBuyMenu';
import { isTelegramAdmin, NOT_ADMIN_MESSAGE } from '../adminGuard';

const TOKEN_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function buy(ctx: Context): Promise<void> {
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
      await showBuyMenu(ctx);
      return;
    }

    const args = message.text.split(' ').slice(1);
    if (args.length === 0) {
      await showBuyMenu(ctx);
      return;
    }

    const tokenAddress = args[0];
    if (!TOKEN_ADDRESS_RE.test(tokenAddress)) {
      await ctx.reply('❌ Invalid token address format. Please provide a valid Solana token address.');
      return;
    }

    // Optional amount override; falls back to the user's configured default buy amount.
    let solAmount: number;
    if (args[1]) {
      solAmount = Number(args[1]);
      if (!Number.isFinite(solAmount) || solAmount <= 0) {
        await ctx.reply('❌ Amount must be a positive number of SOL.');
        return;
      }
    } else {
      const userConfig = await jupiterService.getUserConfig(userId);
      if (!userConfig) {
        await ctx.reply('❌ No user configuration found. Please set up your configuration first using /config, or run /buy <mint> <sol_amount>.');
        return;
      }
      solAmount = userConfig.buyAmount;
    }

    await sendBuyPayLink(ctx, tokenAddress, solAmount);
  } catch (error) {
    console.error('Buy command error:', error);
    await ctx.reply('❌ An error occurred while processing your request.');
  }
}

export async function sendBuyPayLink(ctx: Context, tokenAddress: string, solAmount: number): Promise<void> {
  try {
    const { url } = createBuyIntent(tokenAddress, solAmount);
    const qr = await renderQrPng(url);

    await ctx.replyWithPhoto(
      { source: qr },
      {
        caption:
          `💰 <b>Buy ${solAmount} SOL of</b>\n<code>${tokenAddress}</code>\n\n` +
          `Open this link in your Solana wallet (Phantom, Solflare, …) or scan the QR code to review and approve — ` +
          `this bot never sees or holds your private key, and nothing is sent unless you approve it in your own wallet.\n\n` +
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
    console.error('Error creating buy pay link:', error);
    await ctx.reply(`❌ ${error instanceof Error ? error.message : 'Failed to create a buy request.'}`);
  }
}
