import { Connection, PublicKey } from '@solana/web3.js';
import axios from 'axios';
import { PrismaClient, Wallet, UserConfig } from '@prisma/client';

/**
 * Jupiter API endpoints.
 *
 * `quote-api.jup.ag` was retired and no longer resolves at all — verified 2026-09-26, when
 * it returned DNS ENOTFOUND while `lite-api.jup.ag` and `api.jup.ag` both answered with live
 * quotes from the same machine seconds apart. Every call in this file was dead until then.
 *
 * `lite-api` is the keyless tier; `api.jup.ag` is the keyed one and is used automatically
 * when `JUPITER_API_KEY` is set. `JUPITER_API_BASE` overrides both.
 */
const JUPITER_API_BASE =
  process.env.JUPITER_API_BASE?.trim() ||
  (process.env.JUPITER_API_KEY?.trim() ? 'https://api.jup.ag/swap/v1' : 'https://lite-api.jup.ag/swap/v1');
const JUPITER_QUOTE_API = `${JUPITER_API_BASE}/quote`;
const JUPITER_SWAP_API = `${JUPITER_API_BASE}/swap`;

/** Present only on the keyed tier; `lite-api` takes no key. */
const JUPITER_HEADERS: Record<string, string> = process.env.JUPITER_API_KEY?.trim()
  ? { 'x-api-key': process.env.JUPITER_API_KEY.trim() }
  : {};

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

// Trading-preference defaults. Previously read from config.sniperoo, which
// was removed with sniperooService (this project never stores a private key
// for this service to sign with, so there is no custodial config left to
// couple these to).
const DEFAULT_BUY_AMOUNT_SOL = 0.1;
const DEFAULT_TAKE_PROFIT_PCT = 50;
const DEFAULT_STOP_LOSS_PCT = 15;
const DEFAULT_AUTO_SELL = false;

/**
 * 5%. High for a liquid pair and ordinary for a memecoin, which is what this service is for.
 * Callers may pass their own; it is named rather than repeated so it can be found and argued
 * with, instead of sitting as a literal in two places.
 */
const DEFAULT_SLIPPAGE_BPS = 500;

// Database client
const prisma = new PrismaClient();

export interface BuiltSwapTransaction {
  /** Base64-encoded, UNSIGNED (or Jupiter-fee-account-partially-signed) transaction. The caller's own wallet signs this — this service never holds or sees a private key. */
  transactionBase64: string;
  quote: {
    inAmount: string;
    outAmount: string;
    /**
     * Read from the output mint on chain.
     *
     * Jupiter's quote response does NOT carry decimals — verified against the live API on
     * 2026-09-26, whose keys are inputMint, inAmount, outputMint, outAmount,
     * otherAmountThreshold, swapMode, slippageBps, platformFee, priceImpactPct, routePlan…
     * The previous code read a field that was never there and fell back to `?? 9`, so every
     * amount was formatted as if it had nine decimals. USDC has six.
     */
    outputDecimals: number;
    /** `otherAmountThreshold`: the least the swap may deliver at this slippage. */
    minimumOut: string;
    /** Jupiter's own price-impact estimate, as a fraction. */
    priceImpactPct: string | null;
  };
}

interface UserPreferences {
  useJito: boolean;
}

/**
 * Non-custodial Jupiter integration. Every method that builds a transaction
 * takes the owner's PUBLIC key as a plain string and returns an unsigned
 * transaction for that owner to sign in their own wallet — this class never
 * generates, imports, stores, or signs with a private key (see
 * ARCHITECTURE.md §8 for why the previous custodial version was removed).
 */
export class JupiterService {
  private connection: Connection;

  /**
   * Decimals for a mint, read on chain and cached.
   *
   * Jupiter does not return them, so without this every amount would have to assume a value.
   * A wrong assumption is not a rounding error: nine-vs-six decimals misreports a balance by
   * a thousand times.
   */
  private static readonly decimalsCache = new Map<string, number>();

  private async mintDecimals(mint: string): Promise<number> {
    const cached = JupiterService.decimalsCache.get(mint);
    if (cached !== undefined) return cached;
    const info = await this.connection.getParsedAccountInfo(new PublicKey(mint));
    const data = info.value?.data;
    const decimals =
      data && typeof data === 'object' && 'parsed' in data ? (data.parsed as { info?: { decimals?: number } })?.info?.decimals : undefined;
    if (typeof decimals !== 'number') throw new Error(`Could not read decimals for mint ${mint}`);
    JupiterService.decimalsCache.set(mint, decimals);
    return decimals;
  }

  /**
   * One quote + one unsigned swap, shared by buy and sell.
   *
   * Both sides had their own copy of this before, which is how the same three bugs — a dead
   * host, a field name Jupiter ignores, and invented decimals — existed twice.
   */
  private async quoteAndBuild(params: {
    inputMint: string;
    outputMint: string;
    amountRaw: string;
    slippageBps: number;
    ownerAddress: string;
  }): Promise<BuiltSwapTransaction> {
    const quoteResponse = await axios.get(JUPITER_QUOTE_API, {
      params: {
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        amount: params.amountRaw,
        slippageBps: params.slippageBps,
      },
      headers: JUPITER_HEADERS,
    });
    const quote = quoteResponse.data;
    if (!quote?.outAmount) throw new Error('Failed to get quote from Jupiter');

    const swapResponse = await axios.post(
      JUPITER_SWAP_API,
      {
        quoteResponse: quote,
        userPublicKey: params.ownerAddress,
        // The current parameter name. The old `wrapUnwrapSOL` is silently ignored by the
        // live API — it still returns 200, so the mistake was invisible.
        wrapAndUnwrapSol: true,
      },
      { headers: JUPITER_HEADERS }
    );
    const swap = swapResponse.data;
    if (!swap?.swapTransaction) throw new Error('Failed to generate swap transaction');
    // Jupiter simulates before returning. A route that already failed must not be handed to
    // a wallet as if it were ready to sign.
    if (swap.simulationError) {
      const detail = typeof swap.simulationError === 'string' ? swap.simulationError : JSON.stringify(swap.simulationError);
      throw new Error(`Jupiter could not simulate this swap: ${detail}`);
    }

    return {
      transactionBase64: swap.swapTransaction,
      quote: {
        inAmount: quote.inAmount,
        outAmount: quote.outAmount,
        outputDecimals: await this.mintDecimals(params.outputMint),
        minimumOut: quote.otherAmountThreshold ?? quote.outAmount,
        priceImpactPct: quote.priceImpactPct ?? null,
      },
    };
  }

  constructor() {
    // Alchemy first: Helius is not configured on this deployment, and the public endpoint is
    // rate-limited hard enough to be a liability for anything user-facing.
    this.connection = new Connection(
      process.env.SOLANA_RPC_ENDPOINT || process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com'
    );
  }

  /**
   * Record that a user's wallet is this PUBLIC address — never a private
   * key. Used only so read-only features (balance, positions, buy-amount
   * defaults) know which address to look up; it is never required to build
   * or approve a swap, since the Solana Pay flow (`solanaPayService.ts`)
   * asks the connecting wallet for its own address at sign time.
   */
  async connectWallet(userId: string, publicAddress: string): Promise<Wallet | { error: string }> {
    let parsed: PublicKey;
    try {
      parsed = new PublicKey(publicAddress.trim());
    } catch {
      return { error: 'That does not look like a valid Solana wallet address.' };
    }

    const walletAddress = parsed.toBase58();
    const wallet = await prisma.wallet.upsert({
      where: { userId },
      update: { walletAddress },
      create: { userId, walletAddress, createdAt: new Date() },
    });

    await this.createDefaultConfigIfNeeded(userId);
    return wallet;
  }

  /** Forgets the connected public address. There is nothing to "revoke" beyond this — the bot never held signing authority over it. */
  async disconnectWallet(userId: string): Promise<boolean> {
    try {
      await prisma.wallet.delete({ where: { userId } });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get a user's connected wallet (public address only).
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
          autoSell: configData.autoSell ?? DEFAULT_AUTO_SELL,
          buyAmount: configData.buyAmount ?? DEFAULT_BUY_AMOUNT_SOL,
          takeProfit: configData.takeProfit ?? DEFAULT_TAKE_PROFIT_PCT,
          stopLoss: configData.stopLoss ?? DEFAULT_STOP_LOSS_PCT
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
          autoSell: DEFAULT_AUTO_SELL,
          buyAmount: DEFAULT_BUY_AMOUNT_SOL,
          takeProfit: DEFAULT_TAKE_PROFIT_PCT,
          stopLoss: DEFAULT_STOP_LOSS_PCT
        }
      });
    }
  }

  /**
   * Build an unsigned SOL -> token swap transaction for `ownerAddress`.
   * Does not sign or send anything — the caller (a Solana Pay transaction
   * request handler) hands this to the owner's own wallet to sign.
   */
  async buildBuySwapTransaction(
    ownerAddress: string,
    tokenAddress: string,
    solAmount: number,
    opts: { slippageBps?: number; useJito?: boolean } = {}
  ): Promise<BuiltSwapTransaction> {
    return this.quoteAndBuild({
      inputMint: SOL_MINT,
      outputMint: tokenAddress,
      amountRaw: String(Math.floor(solAmount * 1e9)),
      slippageBps: opts.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
      ownerAddress,
    });
  }

  /**
   * Build an unsigned token -> SOL swap transaction for `ownerAddress`,
   * selling `percentage` of that owner's on-chain balance of `tokenAddress`.
   * Does not sign or send anything.
   */
  async buildSellSwapTransaction(
    ownerAddress: string,
    tokenAddress: string,
    percentage: number,
    opts: { slippageBps?: number; useJito?: boolean } = {}
  ): Promise<BuiltSwapTransaction> {
    const tokenBalanceRaw = await this.getTokenBalanceRaw(ownerAddress, tokenAddress);
    if (tokenBalanceRaw <= 0n) throw new Error('No tokens found in that wallet for this mint.');

    const sellAmountRaw = (tokenBalanceRaw * BigInt(Math.round(percentage * 100))) / 10000n;
    if (sellAmountRaw <= 0n) throw new Error('Invalid sell amount.');

    return this.quoteAndBuild({
      inputMint: tokenAddress,
      outputMint: SOL_MINT,
      amountRaw: sellAmountRaw.toString(),
      slippageBps: opts.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
      ownerAddress,
    });
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
      const currentPrefs = await this.getUserPreferences(userId);
      return !currentPrefs.useJito;
    } catch (error) {
      console.error('Error toggling Jito:', error);
      return false;
    }
  }

  /**
   * Get a token's raw base-unit balance for a wallet (real on-chain read —
   * the previous version of this method was a hardcoded mock).
   */
  private async getTokenBalanceRaw(walletAddress: string, tokenAddress: string): Promise<bigint> {
    try {
      const owner = new PublicKey(walletAddress);
      const mint = new PublicKey(tokenAddress);
      const accounts = await this.connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID });
      let total = 0n;
      for (const { account } of accounts.value) {
        const info = account.data.parsed.info;
        if (info.mint === mint.toBase58()) {
          total += BigInt(info.tokenAmount.amount);
        }
      }
      return total;
    } catch (error) {
      console.error('Error getting token balance:', error);
      return 0n;
    }
  }

  /**
   * Get SOL balance for a wallet
   */
  async getSolBalance(walletAddress: string): Promise<number> {
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
   * Record a completed transaction for PnL tracking. Since swaps are now
   * signed and submitted by the user's own wallet (not this service), the
   * caller must supply a real signature it learned some other way (e.g. a
   * user pasting it back via `/confirm <signature>`) — this is best-effort
   * bookkeeping, not a guarantee every trade gets recorded.
   */
  async recordTransaction(
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
   * Get users with auto-buy enabled. Kept for the (currently unreachable —
   * see src/index.ts's handleWebsocketMessage, which is defined but never
   * called) auto-buy code path. A fully unattended auto-buy is inherently
   * incompatible with a non-custodial signing model — there is no key here
   * to sign with — so this can only ever list candidates, never execute for
   * them.
   */
  async getUsersWithAutoBuy(): Promise<{ userId: string; walletId: string }[]> {
    const users = await prisma.userConfig.findMany({
      where: { autoBuy: true },
      select: { userId: true, wallet: { select: { id: true } } }
    });
    return users.filter((u) => u.wallet).map((user) => ({ userId: user.userId, walletId: user.wallet!.id }));
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
      return wallets.map((wallet) => ({ id: wallet.id, walletAddress: wallet.walletAddress, name: undefined }));
    } catch (error) {
      console.error('Error getting all wallets:', error);
      return [];
    }
  }

  /**
   * Set a wallet as the default wallet for a user. Placeholder — there is
   * currently no multi-wallet default selection mechanism; kept only so the
   * existing Telegram callback wiring compiles and degrades gracefully.
   */
  async setDefaultWallet(userId: string, walletId: string): Promise<boolean> {
    const wallet = await prisma.wallet.findFirst({ where: { id: walletId, userId } });
    return !!wallet;
  }

  /**
   * Delete a connected wallet record (just forgets the public address —
   * there was never a key to delete).
   */
  async deleteWallet(userId: string, walletId: string): Promise<boolean> {
    try {
      const wallet = await prisma.wallet.findFirst({ where: { id: walletId, userId } });
      if (!wallet) throw new Error('Wallet not found or does not belong to user');
      await prisma.wallet.delete({ where: { id: walletId } });
      return true;
    } catch (error) {
      console.error('Error deleting wallet:', error);
      return false;
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
    pnl?: number;
    pnlPercentage?: number;
  }>> {
    try {
      const wallet = await this.getWallet(userId);
      if (!wallet) return [];

      const publicKey = new PublicKey(wallet.walletAddress);
      const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(publicKey, { programId: TOKEN_PROGRAM_ID });

      const positions = [];
      for (const account of tokenAccounts.value) {
        const tokenData = account.account.data.parsed.info;
        const mintAddress = tokenData.mint;
        const balance = Number(tokenData.tokenAmount.amount) / Math.pow(10, tokenData.tokenAmount.decimals);
        if (balance <= 0) continue;
        if (mintAddress === SOL_MINT) continue;

        const transactions = await prisma.walletTransaction.findMany({
          where: { walletId: wallet.id, tokenMint: mintAddress },
          orderBy: { timestamp: 'asc' }
        });

        let pnl: number | undefined;
        let pnlPercentage: number | undefined;
        if (transactions.length > 0) {
          let totalInvested = 0;
          let totalTokensBought = 0;
          for (const tx of transactions) {
            if (tx.type === 'BUY') {
              totalInvested += tx.solAmount;
              totalTokensBought += tx.tokenAmount;
            }
          }
          if (totalTokensBought > 0 && tx_hasValidPrice(transactions)) {
            const avgBuyPrice = totalInvested / totalTokensBought;
            const lastKnownPrice = transactions[transactions.length - 1].price;
            const currentValue = balance * lastKnownPrice;
            const investedValue = balance * avgBuyPrice;
            pnl = currentValue - investedValue;
            pnlPercentage = investedValue > 0 ? (pnl / investedValue) * 100 : undefined;
          }
        }

        positions.push({ tokenMint: mintAddress, balance, pnl, pnlPercentage });
      }
      return positions;
    } catch (error) {
      console.error('Error getting user token positions:', error);
      return [];
    }
  }
}

function tx_hasValidPrice(transactions: { price: number }[]): boolean {
  return transactions.length > 0 && transactions[transactions.length - 1].price > 0;
}

// Export a singleton instance
export const jupiterService = new JupiterService();
