import { Context, Markup } from 'telegraf';
import { jupiterService } from '../services/jupiterService';
import { Connection, PublicKey } from '@solana/web3.js';

/**
 * Helper function to get formatted balance
 */
export async function getFormattedBalance(walletAddress: string): Promise<string> {
  try {
    // Use environment variable for RPC endpoint
    const connection = new Connection(process.env.RPC_ENDPOINT || process.env.HELIUS_HTTPS_URI || 'https://api.mainnet-beta.solana.com');
    
    // Get actual balance from blockchain
    const publicKey = new PublicKey(walletAddress);
    const balance = await connection.getBalance(publicKey);
    const solBalance = balance / 1e9; // Convert lamports to SOL
    
    // No USD figure. This used to multiply the balance by a hardcoded $100 SOL price and present
    // the result to the user as their portfolio value. There is no trusted historical or live
    // SOL/USD source configured in this repository (see src/candles/usdPricing.ts), and Phase
    // 7E.4.3 §10 is explicit: if the USD price cannot be trusted, the USD figure is unavailable
    // rather than estimated. The SOL balance itself is a real on-chain read and is shown as-is.
    return `${solBalance.toFixed(4)} SOL`;
  } catch (error) {
    console.error('Error getting balance:', error);
    // Never report a zero balance for a failed read — that is a different claim from "unknown".
    return 'balance unavailable';
  }
}

/**
 * Show the wallet management menu with improved button handling
 */
export async function showWalletMenu(ctx: Context): Promise<void> {
  try {
    const userId = ctx.from?.id.toString();
    
    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return;
    }

    // Check if user already has a wallet
    const userWallet = await jupiterService.getWallet(userId);
    const wallets = await jupiterService.getAllWallets(userId);
    const hasWallets = wallets && wallets.length > 0;
    
    // Create the wallet menu message
    let walletMessage = `
💼 <b>Wallet Management</b>

`;

    if (hasWallets && userWallet) {
      walletMessage += `<b>Your Connected Wallet:</b>\n${await getFormattedBalance(userWallet.walletAddress)}\n<code>${userWallet.walletAddress}</code>`;
    } else {
      walletMessage += "<b>No wallet connected.</b> Connect your wallet's public address to get started — never a private key.";
    }

    walletMessage += "\n\nSelect an option below:";

    // Create wallet menu buttons
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('🔗 Connect Wallet', 'wallet:create_init'),
      ],
      [
        Markup.button.callback('💰 Check Balance', 'wallet:balance'),
        Markup.button.callback('📋 List Wallets', 'wallet:list')
      ],
      [
        Markup.button.callback('⬅️ Back to Main Menu', 'wallet:back')
      ]
    ]);

    // Send the wallet menu
    await ctx.reply(walletMessage, {
      parse_mode: 'HTML',
      ...keyboard
    });
  } catch (error) {
    console.error('Show wallet menu error:', error);
    await ctx.reply('❌ An error occurred while showing the wallet menu.');
  }
} 