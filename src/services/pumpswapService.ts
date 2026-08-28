import {
  Connection,
  PublicKey,
} from '@solana/web3.js';
import { PrismaClient, UserConfig, Wallet } from '@prisma/client';

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
   * Buying/selling directly through the Pump.fun AMM was never actually
   * implemented — `getPumpFunBuyInstructions`/`getPumpFunSellInstructions`
   * (removed here) always returned an empty instruction array, so calling
   * this previously only sent a compute-budget bump plus an optional real
   * Jito tip payment and nothing else, using a private key held in
   * `Wallet.walletPk`. That custodial signing path is removed along with
   * the rest of the plaintext-key storage (see ARCHITECTURE.md §8) rather
   * than kept around non-functional. Real PumpSwap AMM swaps are not
   * available from this service; use `jupiterService`'s non-custodial
   * builders instead — Jupiter can already route through a token's
   * PumpSwap pool once one exists on-chain.
   */

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
}

// Export a singleton instance
export const pumpSwapService = new PumpSwapService(); 