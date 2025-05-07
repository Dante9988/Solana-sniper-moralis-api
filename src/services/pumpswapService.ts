import { 
  Connection, 
  Keypair, 
  PublicKey, 
  Transaction, 
  TransactionInstruction, 
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  ComputeBudgetProgram
} from '@solana/web3.js';
import { PrismaClient, Wallet, UserConfig, WalletTransaction } from '@prisma/client';
import { config } from '../config';
import bs58 from 'bs58';

export const PUMPSWAP_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
export const PUMP_FUN_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

// Raydium Migration Account
export const PUMP_FUN_RAYDIUM_MIGRATION = new PublicKey('39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg');

// Jito tip program
export const JITO_TIP_PROGRAM_ID = new PublicKey('4R3gSG8BpU4t19KYj8CfnbtRpnT8gtk4dvTHxVRwc2T3');
export const JITO_TIP_ACCOUNT = new PublicKey('96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhArj8T');

// WSOL mint address
export const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

// Discriminator for CompleteEvent from IDL
export const COMPLETE_EVENT_DISCRIMINATOR = [95, 114, 97, 156, 212, 46, 152, 8];

// Database client
const prisma = new PrismaClient();

// Define speed levels with priority fees
export enum TransactionSpeed {
  FAST = 'fast',
  TURBO = 'turbo',
  ULTRA = 'ultra'
}

// Define slippage presets
export enum SlippagePreset {
  LOW = 500, // 5%
  MEDIUM = 1000, // 10%
  HIGH = 2000, // 20%
  CUSTOM = 0 // Custom value
}

export interface PumpSwapSettings {
  speed: TransactionSpeed;
  slippageBps: number;
  useJito: boolean;
  jitoTipLamports: number;
}

export interface BuySettings extends PumpSwapSettings {
  buySlippagePreset?: SlippagePreset | number;
}

export interface SellSettings extends PumpSwapSettings {
  sellSlippagePreset?: SlippagePreset | number;
}

export interface PumpSwapResult {
  success: boolean;
  txId?: string;
  error?: string;
}

export interface PoolTokens {
  baseToken: string;
  quoteToken: string;
  lpToken: string;
}

export interface BondingCurveAccount {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
}

export function isBondingCurveComplete(logs: string[]): boolean {
  // Look for CompleteEvent discriminator or withdraw instruction in the logs
  return logs.some(log => 
      typeof log === "string" && (
          // Check for the event discriminator
          log.includes(COMPLETE_EVENT_DISCRIMINATOR.join(", ")) ||
          // Check for withdraw instruction (used for migration)
          log.includes("Program log: Instruction: Withdraw") ||
          // Also check for the completion message
          log.includes("Program log: Bonding curve complete")
      )
  );
}

export function isPumpSwapPoolCreation(logs: string[]): boolean {
  // Check for Create_pool instruction with Pump.fun AMM and extract WSOL amount
  const liquidityLog = logs.find(log => 
      typeof log === "string" && 
      log.includes("Create_pool") && 
      log.includes("WSOL")
  );

  if (!liquidityLog) return false;

  // Extract WSOL amount from the log
  const wsolMatch = liquidityLog.match(/and ([\d,.]+) WSOL/);
  if (!wsolMatch) return false;

  // Parse WSOL amount and check if it's > 80
  const wsolAmount = parseFloat(wsolMatch[1].replace(/,/g, ''));
  if (isNaN(wsolAmount) || wsolAmount <= 80) return false;

  return true;
}

// Extract token mint from logs
export function getTokenMintFromLogs(logs: string[]): PublicKey | null {
  try {
      // Look for Create_pool instruction
      const liquidityLog = logs.find(log => 
          typeof log === "string" && 
          log.includes("Create_pool") && 
          log.includes("WSOL")
      );

      if (liquidityLog) {
          // Extract token amount and symbol before "and X WSOL"
          const tokenMatch = liquidityLog.match(/Create_pool ([\d,.]+ [A-Z0-9]+)/);
          if (tokenMatch && tokenMatch[1]) {
              // Find a transfer log containing this token amount and symbol
              const transferLog = logs.find(log =>
                  typeof log === "string" && 
                  log.includes("Transfer") &&
                  log.includes(tokenMatch[1])
              );
              if (transferLog) {
                  const mintMatch = transferLog.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
                  if (mintMatch) {
                      return new PublicKey(mintMatch[0]);
                  }
              }
          }
      }

      console.log("Debug: Could not find mint in logs");
      return null;
  } catch (error) {
      console.error('Error extracting token mint:', error);
      return null;
  }
}

// Simplified to just check for pool creation with high WSOL
export function isValidMigration(logs: string[]): boolean {
  return isPumpSwapPoolCreation(logs);
}

export async function getBondingCurveState(connection: Connection, mint: PublicKey): Promise<boolean> {
  try {
      // Derive bonding curve PDA
      const [bondingCurvePDA] = PublicKey.findProgramAddressSync(
          [
              Buffer.from("bonding-curve"),
              mint.toBuffer()
          ],
          PUMP_FUN_PROGRAM_ID
      );

      // Fetch the bonding curve account
      const account = await connection.getAccountInfo(bondingCurvePDA);
      if (!account) return false;

      // Skip 8 bytes of discriminator
      const complete = account.data[account.data.length - 1] === 1; // complete is the last boolean field
      return complete;

  } catch (error) {
      console.error('Error checking bonding curve state:', error);
      return false;
  }
}

// This should be called after detecting a pool creation
export async function verifyPumpFunMigration(
  connection: Connection, 
  logs: string[],
  mint: PublicKey
): Promise<boolean> {
  // First verify this is a pool creation
  if (!isPumpSwapPoolCreation(logs)) return false;

  // Then check if the token's bonding curve is complete
  const isBondingComplete = await getBondingCurveState(connection, mint);
  return isBondingComplete;
} 

/**
 * Main service class for Pump.fun trading
 */
export class PumpSwapService {
  private connection: Connection;
  
  constructor() {
    // Use Helius RPC URL from env
    this.connection = new Connection(process.env.HELIUS_HTTPS_URI || '');
  }
  
  /**
   * Get user's pump swap settings
   */
  async getUserSettings(userId: string): Promise<PumpSwapSettings> {
    // Default settings
    const defaultSettings: PumpSwapSettings = {
      speed: TransactionSpeed.FAST,
      slippageBps: 100, // 1%
      useJito: true,
      jitoTipLamports: 10000000 // 0.01 SOL
    };
    
    try {
      // Get user settings from database
      // Implement your actual preferences storage
      // This is a placeholder implementation
      return defaultSettings;
    } catch (error) {
      console.error('Error getting user settings:', error);
      return defaultSettings;
    }
  }
  
  /**
   * Update user's pump swap settings
   */
  async updateUserSettings(
    userId: string, 
    settings: Partial<PumpSwapSettings>
  ): Promise<boolean> {
    try {
      // Update user settings in database
      // Implement your actual settings storage
      // This is a placeholder implementation
      return true;
    } catch (error) {
      console.error('Error updating user settings:', error);
      return false;
    }
  }
  
  /**
   * Buy a token using Pump.fun AMM
   */
  async buyToken(
    tokenAddress: string, 
    userId: string, 
    customSettings?: Partial<BuySettings>
  ): Promise<PumpSwapResult> {
    try {
      // Get user wallet
      const wallet = await this.getWallet(userId);
      if (!wallet) {
        return { success: false, error: 'No wallet found for user' };
      }
      
      // Get user config
      const userConfig = await this.getUserConfig(userId);
      if (!userConfig) {
        return { success: false, error: 'No user configuration found' };
      }
      
      // Get user settings with potential custom overrides
      const baseSettings = await this.getUserSettings(userId);
      const settings = {
        ...baseSettings,
        ...customSettings
      };
      
      // Check if wallet has enough SOL
      const solBalance = await this.getSolBalance(wallet.walletAddress);
      if (solBalance < userConfig.buyAmount) {
        return { 
          success: false, 
          error: `Insufficient SOL balance. You have ${solBalance.toFixed(4)} SOL but need ${userConfig.buyAmount} SOL.` 
        };
      }
      
      // Create the BUY transaction
      const tokenMint = new PublicKey(tokenAddress);
      const keypair = Keypair.fromSecretKey(bs58.decode(wallet.walletPk));
      
      // Build the transaction
      const transaction = await this.buildBuyTransaction(
        tokenMint,
        keypair.publicKey,
        userConfig.buyAmount,
        settings
      );
      
      // Sign and send transaction
      transaction.partialSign(keypair);
      const txid = await this.connection.sendRawTransaction(transaction.serialize());
      
      // Wait for confirmation
      const { value } = await this.connection.getSignatureStatus(txid, { searchTransactionHistory: true });
      if (value?.err) throw new Error(`Transaction failed: ${value.err.toString()}`);
      
      // Record transaction in database
      await this.recordTransaction(
        wallet.id,
        'BUY',
        tokenAddress,
        0, // Token amount will be determined after the swap
        userConfig.buyAmount,
        0, // Price will be determined after the swap
        txid,
        'COMPLETED'
      );
      
      return { 
        success: true, 
        txId: txid 
      };
      
    } catch (error) {
      console.error('Error buying token with Pump.fun:', error);
      let errorMessage = 'Failed to buy token';
      
      if (error instanceof Error) {
        errorMessage = error.message;
      }
      
      return { 
        success: false, 
        error: errorMessage 
      };
    }
  }
  
  /**
   * Sell a token using Pump.fun AMM
   */
  async sellToken(
    tokenAddress: string, 
    percentage: number, 
    userId: string,
    customSettings?: Partial<SellSettings>
  ): Promise<PumpSwapResult> {
    try {
      // Get user wallet
      const wallet = await this.getWallet(userId);
      if (!wallet) {
        return { success: false, error: 'No wallet found for user' };
      }
      
      // Get user settings with potential custom overrides
      const baseSettings = await this.getUserSettings(userId);
      const settings = {
        ...baseSettings,
        ...customSettings
      };
      
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
      
      // Create the SELL transaction
      const tokenMint = new PublicKey(tokenAddress);
      const keypair = Keypair.fromSecretKey(bs58.decode(wallet.walletPk));
      
      // Build the transaction
      const transaction = await this.buildSellTransaction(
        tokenMint,
        keypair.publicKey,
        sellAmount,
        settings
      );
      
      // Sign and send transaction
      transaction.partialSign(keypair);
      const txid = await this.connection.sendRawTransaction(transaction.serialize());
      
      // Wait for confirmation
      const { value: sellValue } = await this.connection.getSignatureStatus(txid, { searchTransactionHistory: true });
      if (sellValue?.err) throw new Error(`Transaction failed: ${sellValue.err.toString()}`);
      
      // Record transaction in database
      await this.recordTransaction(
        wallet.id,
        'SELL',
        tokenAddress,
        sellAmount,
        0, // SOL amount will be determined after the swap
        0, // Price will be determined after the swap
        txid,
        'COMPLETED'
      );
      
      return { 
        success: true, 
        txId: txid 
      };
      
    } catch (error) {
      console.error('Error selling token with Pump.fun:', error);
      let errorMessage = 'Failed to sell token';
      
      if (error instanceof Error) {
        errorMessage = error.message;
      }
      
      return { 
        success: false, 
        error: errorMessage 
      };
    }
  }
  
  /**
   * Build a BUY transaction using Pump.fun AMM
   */
  private async buildBuyTransaction(
    tokenMint: PublicKey,
    wallet: PublicKey,
    amount: number,
    settings: BuySettings
  ): Promise<Transaction> {
    // Create a new transaction
    const transaction = new Transaction();
    
    // Add compute budget instruction based on speed
    transaction.add(this.getComputeBudgetInstruction(settings.speed));
    
    // Add Jito tip instruction if enabled
    if (settings.useJito && settings.jitoTipLamports > 0) {
      transaction.add(this.getJitoTipInstruction(wallet, settings.jitoTipLamports));
    }
    
    // Add Pump.fun AMM buy instruction
    // This is a placeholder - you would need to implement the actual instruction based on 
    // reverse engineering the program
    const buyInstructions = await this.getPumpFunBuyInstructions(
      tokenMint,
      wallet,
      amount,
      settings.slippageBps
    );
    
    transaction.add(...buyInstructions);
    
    return transaction;
  }
  
  /**
   * Build a SELL transaction using Pump.fun AMM
   */
  private async buildSellTransaction(
    tokenMint: PublicKey,
    wallet: PublicKey,
    tokenAmount: number,
    settings: SellSettings
  ): Promise<Transaction> {
    // Create a new transaction
    const transaction = new Transaction();
    
    // Add compute budget instruction based on speed
    transaction.add(this.getComputeBudgetInstruction(settings.speed));
    
    // Add Jito tip instruction if enabled
    if (settings.useJito && settings.jitoTipLamports > 0) {
      transaction.add(this.getJitoTipInstruction(wallet, settings.jitoTipLamports));
    }
    
    // Add Pump.fun AMM sell instruction
    // This is a placeholder - you would need to implement the actual instruction based on 
    // reverse engineering the program
    const sellInstructions = await this.getPumpFunSellInstructions(
      tokenMint,
      wallet,
      tokenAmount,
      settings.slippageBps
    );
    
    transaction.add(...sellInstructions);
    
    return transaction;
  }
  
  /**
   * Get compute budget instruction based on speed setting
   */
  private getComputeBudgetInstruction(speed: TransactionSpeed): TransactionInstruction {
    let priorityFee: number;
    
    switch (speed) {
      case TransactionSpeed.ULTRA:
        priorityFee = 1000000; // 0.001 SOL
        break;
      case TransactionSpeed.TURBO:
        priorityFee = 500000; // 0.0005 SOL
        break;
      case TransactionSpeed.FAST:
      default:
        priorityFee = 250000; // 0.00025 SOL
        break;
    }
    
    return ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: priorityFee
    });
  }
  
  /**
   * Get Jito tip instruction
   */
  private getJitoTipInstruction(
    wallet: PublicKey,
    lamports: number
  ): TransactionInstruction {
    return SystemProgram.transfer({
      fromPubkey: wallet,
      toPubkey: JITO_TIP_ACCOUNT,
      lamports: lamports
    });
  }
  
  /**
   * Get Pump.fun AMM buy instructions
   * Note: This is a placeholder and would need to be implemented based on program reverse engineering
   */
  private async getPumpFunBuyInstructions(
    tokenMint: PublicKey,
    wallet: PublicKey,
    solAmount: number,
    slippageBps: number
  ): Promise<TransactionInstruction[]> {
    // This would need to be implemented based on reverse engineering the program
    // For now, return empty array as placeholder
    console.log(`Buy params: token=${tokenMint.toString()}, wallet=${wallet.toString()}, amount=${solAmount}, slippage=${slippageBps}`);
    return [];
  }
  
  /**
   * Get Pump.fun AMM sell instructions
   * Note: This is a placeholder and would need to be implemented based on program reverse engineering
   */
  private async getPumpFunSellInstructions(
    tokenMint: PublicKey,
    wallet: PublicKey,
    tokenAmount: number,
    slippageBps: number
  ): Promise<TransactionInstruction[]> {
    // This would need to be implemented based on reverse engineering the program
    // For now, return empty array as placeholder
    console.log(`Sell params: token=${tokenMint.toString()}, wallet=${wallet.toString()}, amount=${tokenAmount}, slippage=${slippageBps}`);
    return [];
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
}

// Export a singleton instance
export const pumpSwapService = new PumpSwapService(); 