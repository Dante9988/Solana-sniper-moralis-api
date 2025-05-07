import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import axios from 'axios';
import { PrismaClient, Wallet, UserConfig, WalletTransaction } from '@prisma/client';
import { config } from '../config';
import bs58 from 'bs58';

// Jupiter API endpoints
const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_SWAP_API = 'https://quote-api.jup.ag/v6/swap';

// Database client
const prisma = new PrismaClient();

export interface WalletData {
  userId: string;
  walletAddress: string;
  walletPk: string;
  createdAt?: Date;
}

export interface BuyResult {
  success: boolean;
  txId?: string;
  error?: string;
}

export interface SellResult {
  success: boolean;
  txId?: string;
  error?: string;
}

interface UserPreferences {
  useJito: boolean;
}

export class JupiterService {
  private connection: Connection;
  
  constructor() {
    // Use RPC_ENDPOINT environment variable
    this.connection = new Connection(process.env.RPC_ENDPOINT || process.env.HELIUS_HTTPS_URI || 'https://api.mainnet-beta.solana.com');
  }
  
  /**
   * Create a new wallet for a user
   */
  async createWallet(userId: string, name: string): Promise<WalletData | { error: string }> {
    try {
      // Generate a new Solana keypair
      const keypair = Keypair.generate();
      const walletAddress = keypair.publicKey.toString();
      const walletPk = bs58.encode(keypair.secretKey);
      
      // Store in database
      await prisma.wallet.create({
        data: {
          userId,
          walletAddress,
          walletPk,
          createdAt: new Date()
        }
      });
      
      // Create default config if none exists
      await this.createDefaultConfigIfNeeded(userId);
      
      return {
        userId,
        walletAddress,
        walletPk,
        createdAt: new Date()
      };
    } catch (error) {
      console.error('Error creating wallet:', error);
      return {
        error: 'Failed to create wallet. Please try again.'
      };
    }
  }
  
  /**
   * Import an existing wallet
   */
  async importWallet(userId: string, privateKey: string): Promise<WalletData | { error: string }> {
    try {
      // Validate private key
      if (!privateKey || privateKey.length < 64) {
        return {
          error: 'Invalid private key format'
        };
      }
      
      // Convert private key to keypair
      let secretKey: Uint8Array;
      try {
        secretKey = bs58.decode(privateKey);
        if (secretKey.length !== 64) {
          throw new Error('Invalid key length');
        }
      } catch (e) {
        return {
          error: 'Invalid private key format'
        };
      }
      
      const keypair = Keypair.fromSecretKey(secretKey);
      const walletAddress = keypair.publicKey.toString();
      
      // Store in database
      await prisma.wallet.upsert({
        where: { userId },
        update: {
          walletAddress,
          walletPk: privateKey,
        },
        create: {
          userId,
          walletAddress,
          walletPk: privateKey,
          createdAt: new Date()
        }
      });
      
      // Create default config if none exists
      await this.createDefaultConfigIfNeeded(userId);
      
      return {
        userId,
        walletAddress,
        walletPk: privateKey,
        createdAt: new Date()
      };
    } catch (error) {
      console.error('Error importing wallet:', error);
      return {
        error: 'Failed to import wallet. Please try again.'
      };
    }
  }
  
  /**
   * Get a user's wallet
   */
  async getWallet(userId: string): Promise<Wallet | null> {
    return prisma.wallet.findUnique({
      where: { userId }
    });
  }
  
  /**
   * Get user configuration
   */
  async getUserConfig(userId: string): Promise<UserConfig | null> {
    return prisma.userConfig.findUnique({
      where: { userId }
    });
  }
  
  /**
   * Update user configuration
   */
  async updateUserConfig(userId: string, configData: Partial<UserConfig>): Promise<boolean> {
    try {
      await prisma.userConfig.upsert({
        where: { userId },
        update: {
          autoBuy: configData.autoBuy,
          autoSell: configData.autoSell,
          buyAmount: configData.buyAmount,
          takeProfit: configData.takeProfit,
          stopLoss: configData.stopLoss
        },
        create: {
          userId,
          autoBuy: configData.autoBuy ?? false,
          autoSell: configData.autoSell ?? false,
          buyAmount: configData.buyAmount ?? config.sniperoo.default_buy_amount,
          takeProfit: configData.takeProfit ?? config.sniperoo.default_take_profit,
          stopLoss: configData.stopLoss ?? config.sniperoo.default_stop_loss
        }
      });
      return true;
    } catch (error) {
      console.error('Error updating user config:', error);
      return false;
    }
  }
  
  /**
   * Create default config if it doesn't exist
   */
  private async createDefaultConfigIfNeeded(userId: string): Promise<void> {
    const userConfig = await this.getUserConfig(userId);
    if (!userConfig) {
      await prisma.userConfig.create({
        data: {
          userId,
          autoBuy: false,
          autoSell: config.sniperoo.auto_sell,
          buyAmount: config.sniperoo.default_buy_amount,
          takeProfit: config.sniperoo.default_take_profit,
          stopLoss: config.sniperoo.default_stop_loss
        }
      });
    }
  }
  
  /**
   * Buy a token using Jupiter with optional Jito integration
   */
  async buyToken(tokenAddress: string, userId: string): Promise<BuyResult> {
    try {
      // Get user wallet and config
      const wallet = await this.getWallet(userId);
      if (!wallet) {
        return { success: false, error: 'No wallet found for user' };
      }
      
      const userConfig = await this.getUserConfig(userId);
      if (!userConfig) {
        return { success: false, error: 'No user configuration found' };
      }
      
      // Get user preferences
      const userPrefs = await this.getUserPreferences(userId);
      
      // Check if wallet has enough SOL
      const solBalance = await this.getSolBalance(wallet.walletAddress);
      if (solBalance < userConfig.buyAmount) {
        return { 
          success: false, 
          error: `Insufficient SOL balance. You have ${solBalance.toFixed(4)} SOL but need ${userConfig.buyAmount} SOL.` 
        };
      }
      
      // 1. Get quote from Jupiter
      const quoteResponse = await axios.get(JUPITER_QUOTE_API, {
        params: {
          inputMint: 'So11111111111111111111111111111111111111112', // SOL mint address
          outputMint: tokenAddress,
          amount: Math.floor(userConfig.buyAmount * 1e9), // Convert SOL to lamports
          slippageBps: config.swap.slippageBps
        }
      });
      
      if (!quoteResponse.data) {
        return { success: false, error: 'Failed to get quote from Jupiter' };
      }
      
      // 2. Get swap transaction
      const swapResponse = await axios.post(JUPITER_SWAP_API, {
        quoteResponse: quoteResponse.data,
        userPublicKey: wallet.walletAddress,
        wrapUnwrapSOL: true,
        useJitoTip: userPrefs.useJito
      });
      
      if (!swapResponse.data || !swapResponse.data.swapTransaction) {
        return { success: false, error: 'Failed to generate swap transaction' };
      }
      
      // 3. Deserialize and sign transaction
      const keypair = Keypair.fromSecretKey(bs58.decode(wallet.walletPk));
      const serializedTransaction = swapResponse.data.swapTransaction;
      const transaction = Transaction.from(Buffer.from(serializedTransaction, 'base64'));
      
      // 4. Sign and send transaction
      transaction.partialSign(keypair);
      const txid = await this.connection.sendRawTransaction(transaction.serialize());
      
      // 5. Wait for confirmation
      await this.connection.confirmTransaction(txid);
      
      // 6. Record transaction in database
      await this.recordTransaction(
        wallet.id,
        'BUY',
        tokenAddress,
        quoteResponse.data.outAmount / Math.pow(10, quoteResponse.data.outputDecimals),
        userConfig.buyAmount,
        quoteResponse.data.price,
        txid,
        'COMPLETED'
      );
      
      return { 
        success: true, 
        txId: txid 
      };
      
    } catch (error) {
      console.error('Error buying token:', error);
      let errorMessage = 'Failed to buy token';
      
      if (axios.isAxiosError(error) && error.response?.data?.error) {
        errorMessage = error.response.data.error;
      } else if (error instanceof Error) {
        errorMessage = error.message;
      }
      
      return { 
        success: false, 
        error: errorMessage 
      };
    }
  }
  
  /**
   * Sell a token
   */
  async sellToken(tokenAddress: string, percentage: number, userId: string): Promise<SellResult> {
    try {
      // Get user wallet and config
      const wallet = await this.getWallet(userId);
      if (!wallet) {
        return { success: false, error: 'No wallet found for user' };
      }
      
      // Get user preferences
      const userPrefs = await this.getUserPreferences(userId);
      
      // Get token balance
      const tokenBalance = await this.getTokenBalance(wallet.walletAddress, tokenAddress);
      if (tokenBalance <= 0) {
        return { success: false, error: 'No tokens found in wallet' };
      }
      
      // Calculate amount to sell
      const sellAmount = tokenBalance * (percentage / 100);
      if (sellAmount <= 0) {
        return { success: false, error: 'Invalid sell amount' };
      }
      
      // 1. Get quote from Jupiter for selling
      const quoteResponse = await axios.get(JUPITER_QUOTE_API, {
        params: {
          inputMint: tokenAddress,
          outputMint: 'So11111111111111111111111111111111111111112', // SOL mint address
          amount: Math.floor(sellAmount * 1e9), // Assuming 9 decimals
          slippageBps: config.swap.slippageBps
        }
      });
      
      if (!quoteResponse.data) {
        return { success: false, error: 'Failed to get quote from Jupiter' };
      }
      
      // 2. Get swap transaction
      const swapResponse = await axios.post(JUPITER_SWAP_API, {
        quoteResponse: quoteResponse.data,
        userPublicKey: wallet.walletAddress,
        wrapUnwrapSOL: true,
        useJitoTip: userPrefs.useJito
      });
      
      if (!swapResponse.data || !swapResponse.data.swapTransaction) {
        return { success: false, error: 'Failed to generate swap transaction' };
      }
      
      // 3. Deserialize and sign transaction
      const keypair = Keypair.fromSecretKey(bs58.decode(wallet.walletPk));
      const serializedTransaction = swapResponse.data.swapTransaction;
      const transaction = Transaction.from(Buffer.from(serializedTransaction, 'base64'));
      
      // 4. Sign and send transaction
      transaction.partialSign(keypair);
      const txid = await this.connection.sendRawTransaction(transaction.serialize());
      
      // 5. Wait for confirmation
      await this.connection.confirmTransaction(txid);
      
      // 6. Record transaction in database
      await this.recordTransaction(
        wallet.id,
        'SELL',
        tokenAddress,
        sellAmount,
        quoteResponse.data.outAmount / 1e9, // Convert lamports to SOL
        quoteResponse.data.price,
        txid,
        'COMPLETED'
      );
      
      return { 
        success: true, 
        txId: txid 
      };
      
    } catch (error) {
      console.error('Error selling token:', error);
      let errorMessage = 'Failed to sell token';
      
      if (axios.isAxiosError(error) && error.response?.data?.error) {
        errorMessage = error.response.data.error;
      } else if (error instanceof Error) {
        errorMessage = error.message;
      }
      
      return { 
        success: false, 
        error: errorMessage 
      };
    }
  }
  
  /**
   * Get user preferences for Jito, etc.
   */
  async getUserPreferences(userId: string): Promise<UserPreferences> {
    // Implement your actual user preferences storage
    // This is a placeholder implementation
    return {
      useJito: true // Default to using Jito
    };
  }
  
  /**
   * Toggle Jito usage for a user
   */
  async toggleJito(userId: string): Promise<boolean> {
    try {
      // Implement your actual toggling logic
      // This is a placeholder implementation
      const currentPrefs = await this.getUserPreferences(userId);
      
      // Here you would update the preferences in your database
      // For now, we just return the opposite of current setting
      return !currentPrefs.useJito;
    } catch (error) {
      console.error('Error toggling Jito:', error);
      return false;
    }
  }
  
  /**
   * Get a token's balance for a wallet
   */
  private async getTokenBalance(walletAddress: string, tokenAddress: string): Promise<number> {
    try {
      // Implement token balance checking logic
      // This is placeholder implementation
      return 1000; // Mock token balance
    } catch (error) {
      console.error('Error getting token balance:', error);
      return 0;
    }
  }
  
  /**
   * Get SOL balance for a wallet
   */
  private async getSolBalance(walletAddress: string): Promise<number> {
    try {
      const publicKey = new PublicKey(walletAddress);
      const balance = await this.connection.getBalance(publicKey);
      return balance / 1e9; // Convert lamports to SOL
    } catch (error) {
      console.error('Error getting SOL balance:', error);
      return 0;
    }
  }
  
  /**
   * Record a transaction in the database
   */
  private async recordTransaction(
    walletId: string,
    type: 'BUY' | 'SELL',
    tokenMint: string,
    tokenAmount: number,
    solAmount: number,
    price: number,
    txHash: string,
    status: 'PENDING' | 'COMPLETED' | 'FAILED' = 'PENDING',
    error?: string
  ): Promise<void> {
    try {
      await prisma.walletTransaction.create({
        data: {
          walletId,
          type,
          tokenMint,
          tokenAmount,
          solAmount,
          price,
          txHash,
          status,
          error,
          timestamp: new Date()
        }
      });
    } catch (error) {
      console.error('Error recording transaction:', error);
    }
  }
  
  /**
   * Get users with auto-buy enabled
   */
  async getUsersWithAutoBuy(): Promise<{ userId: string; walletId: string }[]> {
    const users = await prisma.userConfig.findMany({
      where: {
        autoBuy: true
      },
      select: {
        userId: true,
        wallet: {
          select: {
            id: true
          }
        }
      }
    });
    
    return users.map(user => ({
      userId: user.userId,
      walletId: user.wallet.id
    }));
  }

  /**
   * Get users with their preferences (both AutoBuy and PumpSwap)
   */
  async getUsersWithPreferences(): Promise<{ 
    userId: string; 
    walletId?: string;
    config?: { autoBuy: boolean };
    preferences?: { pumpSwapEnabled: boolean }
  }[]> {
    // Get all wallets
    const wallets = await prisma.wallet.findMany({
      select: {
        id: true,
        userId: true,
        config: {
          select: {
            autoBuy: true
          }
        }
      }
    });
    
    // Get all user preferences
    const preferences = await prisma.userPreference.findMany({
      select: {
        userId: true,
        pumpSwapEnabled: true
      }
    });
    
    // Create a map of user preferences
    const prefsMap = new Map();
    preferences.forEach(pref => {
      prefsMap.set(pref.userId, { pumpSwapEnabled: pref.pumpSwapEnabled });
    });
    
    // Combine data
    return wallets.map(wallet => ({
      userId: wallet.userId,
      walletId: wallet.id,
      config: wallet.config || undefined,
      preferences: prefsMap.get(wallet.userId) || undefined
    }));
  }

  /**
   * Get all wallets for a user with optional wallet name
   */
  async getAllWallets(userId: string): Promise<Array<{
    id: string;
    walletAddress: string;
    name?: string;
  }>> {
    try {
      const wallets = await prisma.wallet.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' }
      });
      
      // For now, we don't store wallet names, so we'll just return the basic info
      return wallets.map(wallet => ({
        id: wallet.id,
        walletAddress: wallet.walletAddress,
        name: undefined // We'll add name support in the future
      }));
    } catch (error) {
      console.error('Error getting all wallets:', error);
      return [];
    }
  }

  /**
   * Set a wallet as the default wallet for a user
   * This works by reordering wallets (first wallet is default)
   */
  async setDefaultWallet(userId: string, walletId: string): Promise<boolean> {
    try {
      // Validate that the wallet belongs to the user
      const wallet = await prisma.wallet.findFirst({
        where: {
          id: walletId,
          userId
        }
      });
      
      if (!wallet) {
        throw new Error('Wallet not found or does not belong to user');
      }
      
      // Currently we don't have a mechanism to set a default wallet
      // This is placeholder functionality - in the future, we would implement
      // proper default wallet selection by updating a defaultWalletId field on user
      return true;
    } catch (error) {
      console.error('Error setting default wallet:', error);
      return false;
    }
  }

  /**
   * Delete a wallet
   */
  async deleteWallet(userId: string, walletId: string): Promise<boolean> {
    try {
      // Validate that the wallet belongs to the user
      const wallet = await prisma.wallet.findFirst({
        where: {
          id: walletId,
          userId
        }
      });
      
      if (!wallet) {
        throw new Error('Wallet not found or does not belong to user');
      }
      
      // Delete the wallet
      await prisma.wallet.delete({
        where: { id: walletId }
      });
      
      return true;
    } catch (error) {
      console.error('Error deleting wallet:', error);
      return false;
    }
  }

  /**
   * Get a wallet's private key (be careful with this!)
   */
  async getWalletPrivateKey(userId: string, walletId: string): Promise<string> {
    try {
      // Validate that the wallet belongs to the user
      const wallet = await prisma.wallet.findFirst({
        where: {
          id: walletId,
          userId
        }
      });
      
      if (!wallet) {
        throw new Error('Wallet not found or does not belong to user');
      }
      
      return wallet.walletPk;
    } catch (error) {
      console.error('Error getting wallet private key:', error);
      throw new Error('Failed to get private key');
    }
  }

  /**
   * Get user token positions
   */
  async getUserTokenPositions(userId: string): Promise<Array<{
    tokenMint: string;
    tokenSymbol?: string;
    tokenName?: string;
    balance: number;
    usdValue?: number;
    pnl?: number;
    pnlPercentage?: number;
  }>> {
    try {
      // Get user wallet
      const wallet = await this.getWallet(userId);
      if (!wallet) return [];
      
      // Get token account balances
      const publicKey = new PublicKey(wallet.walletAddress);
      const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
        publicKey,
        { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }
      );
      
      // Process token accounts
      const positions = [];
      
      for (const account of tokenAccounts.value) {
        const tokenData = account.account.data.parsed.info;
        const mintAddress = tokenData.mint;
        const balance = Number(tokenData.tokenAmount.amount) / Math.pow(10, tokenData.tokenAmount.decimals);
        
        // Skip tokens with zero balance
        if (balance <= 0) continue;
        
        // Skip native SOL (it shows up separately)
        if (mintAddress === 'So11111111111111111111111111111111111111112') continue;
        
        // Get token transactions to calculate PNL
        const transactions = await prisma.walletTransaction.findMany({
          where: {
            walletId: wallet.id,
            tokenMint: mintAddress
          },
          orderBy: {
            timestamp: 'asc'
          }
        });
        
        // Calculate PNL if there are transactions
        let pnl = 0;
        let pnlPercentage = 0;
        let tokenName = 'Unknown';
        let tokenSymbol = 'Unknown';
        
        if (transactions.length > 0) {
          // Attempt to get token metadata
          try {
            const tokenMetadata = await this.getTokenMetadata(mintAddress);
            tokenName = tokenMetadata.name || 'Unknown';
            tokenSymbol = tokenMetadata.symbol || 'Unknown';
          } catch (e) {
            console.error('Error fetching token metadata:', e);
          }
          
          // Calculate average buy price and current estimated price
          let totalInvested = 0;
          let totalTokensBought = 0;
          
          for (const tx of transactions) {
            if (tx.type === 'BUY') {
              totalInvested += tx.solAmount;
              totalTokensBought += tx.tokenAmount;
            }
          }
          
          if (totalTokensBought > 0) {
            const avgBuyPrice = totalInvested / totalTokensBought;
            
            // Get estimated current token price
            // This would ideally use a price oracle, but we're keeping it simple
            const currentPriceEstimate = await this.estimateTokenPrice(mintAddress);
            
            // Calculate PNL
            const currentValue = balance * currentPriceEstimate;
            const investedValue = balance * avgBuyPrice;
            
            pnl = currentValue - investedValue;
            pnlPercentage = (pnl / investedValue) * 100;
          }
        }
        
        positions.push({
          tokenMint: mintAddress,
          tokenName,
          tokenSymbol,
          balance,
          pnl,
          pnlPercentage
        });
      }
      
      return positions;
    } catch (error) {
      console.error('Error getting user token positions:', error);
      return [];
    }
  }

  /**
   * Estimate token price
   */
  private async estimateTokenPrice(tokenMint: string): Promise<number> {
    try {
      // In a real application, use Jupiter API to get token price
      // For now, return a mock price
      return 0.01; // Mock price
    } catch (error) {
      console.error('Error estimating token price:', error);
      return 0;
    }
  }

  /**
   * Get token metadata
   */
  private async getTokenMetadata(tokenMint: string): Promise<{ name: string, symbol: string }> {
    try {
      // In a real application, fetch from a token list or Metaplex
      // For now, return placeholder data
      return {
        name: 'Unknown Token',
        symbol: 'UNKNOWN'
      };
    } catch (error) {
      console.error('Error getting token metadata:', error);
      return { name: 'Unknown', symbol: 'UNKNOWN' };
    }
  }
}

// Export a singleton instance
export const jupiterService = new JupiterService(); 