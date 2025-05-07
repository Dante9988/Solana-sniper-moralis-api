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
    
    // Get SOL price (in a real app you'd use an oracle or price feed)
    // For now assuming ~$100 for SOL
    const solPrice = 100; 
    const usdValue = solBalance * solPrice;
    
    return `${solBalance.toFixed(4)} SOL ($${usdValue.toFixed(2)} USD)`;
  } catch (error) {
    console.error('Error getting balance:', error);
    return '0.00 SOL ($0.00 USD)';
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
      walletMessage += `<b>Your Primary Wallet:</b>\n${await getFormattedBalance(userWallet.walletAddress)}\n<code>${userWallet.walletAddress}</code>`;
    } else {
      walletMessage += "<b>No wallets found.</b> Create or import one to get started!";
    }
    
    walletMessage += "\n\nSelect an option below:";

    // Create wallet menu buttons
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('💼 Create Wallet', 'wallet:create_init'),
        Markup.button.callback('🔑 Import Wallet', 'wallet:import_init')
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