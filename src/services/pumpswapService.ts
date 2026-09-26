import {
  Connection,
  PublicKey,
} from '@solana/web3.js';
import { PrismaClient, UserConfig, Wallet } from '@prisma/client';


/**
 * Protocol constants and detection helpers come from the pure module — one definition, not
 * a second copy that can drift. Re-exported because this file's existing importers expect
 * them here.
 *
 * Phase 7E.4.2: these were duplicated verbatim (three program IDs, the discriminator and six
 * function bodies), so a fix applied to one copy silently missed the other.
 */
export {
  PUMPSWAP_PROGRAM_ID,
  PUMP_FUN_PROGRAM_ID,
  PUMP_FUN_RAYDIUM_MIGRATION,
  COMPLETE_EVENT_DISCRIMINATOR,
  isBondingCurveComplete,
  isPumpSwapPoolCreation,
  getTokenMintFromLogs,
  isValidMigration,
  getBondingCurveState,
  verifyPumpFunMigration,
} from '../pump/protocol/pumpSwap';

// Jito tip program
export const JITO_TIP_PROGRAM_ID = new PublicKey('4R3gSG8BpU4t19KYj8CfnbtRpnT8gtk4dvTHxVRwc2T3');
export const JITO_TIP_ACCOUNT = new PublicKey('96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhArj8T');

// WSOL mint address
export const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

/**
 * Built on first use. A module-level `new PrismaClient()` opens a client for anyone who
 * imports this file for a constant, which used to include the pure detection helpers.
 */
let prismaRef: PrismaClient | null = null;
function db(): PrismaClient {
  prismaRef ??= new PrismaClient();
  return prismaRef;
}

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


/**
 * Main service class for Pump.fun trading
 */
export class PumpSwapService {
  private connectionRef: Connection | null = null;

  /**
   * Built on first use, not in the constructor.
   *
   * This class is instantiated at module load (`export const pumpSwapService = ...` below),
   * so anything the constructor does happens to every importer — including ingestion,
   * intelligence and CI, none of which trade. It also read `HELIUS_HTTPS_URI`, which is unset
   * on this deployment, so the Connection was built on an empty string and only failed later
   * at an unrelated call site.
   */
  private get connection(): Connection {
    if (this.connectionRef) return this.connectionRef;
    const url = process.env.SOLANA_RPC_ENDPOINT || process.env.RPC_ENDPOINT || process.env.HELIUS_HTTPS_URI;
    if (!url) throw new Error('No Solana RPC configured: set SOLANA_RPC_ENDPOINT');
    this.connectionRef = new Connection(url);
    return this.connectionRef;
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
    return db().wallet.findUnique({
      where: { userId }
    });
  }

  /**
   * Get user configuration
   */
  async getUserConfig(userId: string): Promise<UserConfig | null> {
    return db().userConfig.findUnique({
      where: { userId }
    });
  }
}

// Export a singleton instance
export const pumpSwapService = new PumpSwapService(); 