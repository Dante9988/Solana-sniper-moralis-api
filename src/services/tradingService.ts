/**
 * @deprecated LEGACY — custodial. Do not import from production code.
 *
 * This is the pre-OnlyPump trading model and it is kept only so the boundary tests below
 * have something concrete to assert against. It has **zero production importers**: the sole
 * non-test reference in the repository is its own `export const` on the last line.
 *
 * Every reason it must not be revived, measured rather than assumed:
 *
 *   - it takes `wallet: Keypair` and signs server-side, which is the one thing OnlyPump's
 *     architecture forbids — the backend builds an unsigned transaction and the user's own
 *     wallet signs it (Part D of phase7e.4.1);
 *   - it defaults to `slippage: 5000`, i.e. **50%**, silently;
 *   - it sends with `skipPreflight: true`, so a transaction that would fail simulation is
 *     broadcast anyway;
 *   - it points at `https://quote-api.jup.ag/v6`, a host that was retired and no longer
 *     resolves (verified 2026-09-26), so it cannot work even on its own terms.
 *
 * The replacement is `src/services/jupiterService.ts`, which quotes and builds an unsigned
 * transaction for a public key and never sees a private one.
 *
 * `src/__tests__/noCustodialTradingImports.test.ts` fails the build if any production module
 * imports this file.
 */
import { Connection, PublicKey, Transaction, Keypair, ComputeBudgetProgram } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import axios from 'axios';

interface JupiterQuoteResponse {
    inputMint: string;
    outputMint: string;
    amount: string;
    slippageBps: number;
    platformFee: {
        amount: string;
        feeBps: number;
    };
    priceImpactPct: number;
    routePlan: any[];
    contextSlot: number;
    timeTaken: number;
}

interface JupiterSwapResponse {
    swapTransaction: string;
    userPublicKey: string;
    wrapUnwrapSOL: boolean;
}

interface TradeConfig {
    slippage: number; // in basis points (1% = 100)
    jitoTip: number; // in lamports
    priorityFee: number; // in micro-lamports
    maxRetries: number;
    retryDelay: number; // in milliseconds
}

interface TradeResult {
    success: boolean;
    signature?: string;
    error?: string;
    price?: number;
    amount?: number;
}

class TradingService {
    private static instance: TradingService;
    private connection: Connection;
    private defaultConfig: TradeConfig;
    private jupiterApiUrl: string;

    private constructor() {
        this.connection = new Connection(process.env.HELIUS_HTTPS_URI || 'https://api.mainnet-beta.solana.com');
        this.jupiterApiUrl = 'https://quote-api.jup.ag/v6';
        this.defaultConfig = {
            slippage: 5000, // 50% default slippage
            jitoTip: 3000000, // 0.003 SOL default tip
            priorityFee: 10000, // 0.00001 SOL Default priority fee
            maxRetries: 3,
            retryDelay: 1000
        };
    }

    public static getInstance(): TradingService {
        if (!TradingService.instance) {
            TradingService.instance = new TradingService();
        }
        return TradingService.instance;
    }

    private async getJupiterQuote(
        inputMint: string,
        outputMint: string,
        amount: string,
        slippage: number
    ): Promise<JupiterQuoteResponse> {
        try {
            const response = await axios.get(`${this.jupiterApiUrl}/quote`, {
                params: {
                    inputMint,
                    outputMint,
                    amount,
                    slippageBps: slippage,
                    onlyDirectRoutes: false,
                    asLegacyTransaction: false
                }
            });
            return response.data;
        } catch (error) {
            console.error('Error getting Jupiter quote:', error);
            throw new Error('Failed to get Jupiter quote');
        }
    }

    private async getJupiterSwap(
        quoteResponse: JupiterQuoteResponse,
        userPublicKey: string
    ): Promise<JupiterSwapResponse> {
        try {
            const response = await axios.post(`${this.jupiterApiUrl}/swap`, {
                quoteResponse,
                userPublicKey,
                wrapUnwrapSOL: true,
                computeUnitPriceMicroLamports: this.defaultConfig.priorityFee
            });
            return response.data;
        } catch (error) {
            console.error('Error getting Jupiter swap:', error);
            throw new Error('Failed to get Jupiter swap transaction');
        }
    }

    private async addJitoTip(transaction: Transaction): Promise<Transaction> {
        // Add Jito tip instruction
        const tipInstruction = ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: this.defaultConfig.jitoTip
        });
        transaction.add(tipInstruction);
        return transaction;
    }

    public async buyToken(
        tokenMint: string,
        amount: number,
        wallet: Keypair,
        config?: Partial<TradeConfig>
    ): Promise<TradeResult> {
        const tradeConfig = { ...this.defaultConfig, ...config };
        let retries = 0;

        while (retries < tradeConfig.maxRetries) {
            try {
                // Get quote for buying token
                const quoteResponse = await this.getJupiterQuote(
                    'So11111111111111111111111111111111111111112', // SOL
                    tokenMint,
                    amount.toString(),
                    tradeConfig.slippage
                );

                // Get swap transaction
                const swapResponse = await this.getJupiterSwap(
                    quoteResponse,
                    wallet.publicKey.toString()
                );

                // Deserialize and sign transaction
                const transaction = Transaction.from(
                    Buffer.from(swapResponse.swapTransaction, 'base64')
                );

                // Add Jito tip
                await this.addJitoTip(transaction);

                // Sign and send transaction
                const signature = await this.connection.sendTransaction(
                    transaction,
                    [wallet],
                    { skipPreflight: true }
                );

                // Wait for confirmation
                await this.connection.confirmTransaction(signature);

                return {
                    success: true,
                    signature,
                    price: parseFloat(quoteResponse.amount) / amount,
                    amount: parseFloat(quoteResponse.amount)
                };
            } catch (error) {
                retries++;
                if (retries === tradeConfig.maxRetries) {
                    return {
                        success: false,
                        error: error instanceof Error ? error.message : 'Unknown error occurred'
                    };
                }
                await new Promise(resolve => setTimeout(resolve, tradeConfig.retryDelay));
            }
        }

        return {
            success: false,
            error: 'Max retries exceeded'
        };
    }

    public async sellToken(
        tokenMint: string,
        percentage: number,
        wallet: Keypair,
        config?: Partial<TradeConfig>
    ): Promise<TradeResult> {
        const tradeConfig = { ...this.defaultConfig, ...config };
        let retries = 0;

        while (retries < tradeConfig.maxRetries) {
            try {
                // Get token account
                const tokenAccount = await getAssociatedTokenAddress(
                    new PublicKey(tokenMint),
                    wallet.publicKey
                );
                const balance = await getAccount(
                    this.connection,
                    tokenAccount
                );
                if (!balance) {
                    throw new Error('Token account not found');
                }

                // Calculate sell amount based on percentage
                const sellAmount = (Number(balance.amount) * percentage) / 100;

                // Get quote for selling token
                const quoteResponse = await this.getJupiterQuote(
                    tokenMint,
                    'So11111111111111111111111111111111111111112', // SOL
                    sellAmount.toString(),
                    tradeConfig.slippage
                );

                // Get swap transaction
                const swapResponse = await this.getJupiterSwap(
                    quoteResponse,
                    wallet.publicKey.toString()
                );

                // Deserialize and sign transaction
                const transaction = Transaction.from(
                    Buffer.from(swapResponse.swapTransaction, 'base64')
                );

                // Add Jito tip
                await this.addJitoTip(transaction);

                // Sign and send transaction
                const signature = await this.connection.sendTransaction(
                    transaction,
                    [wallet],
                    { skipPreflight: true }
                );

                // Wait for confirmation
                await this.connection.confirmTransaction(signature);

                return {
                    success: true,
                    signature,
                    price: parseFloat(quoteResponse.amount) / sellAmount,
                    amount: parseFloat(quoteResponse.amount)
                };
            } catch (error) {
                retries++;
                if (retries === tradeConfig.maxRetries) {
                    return {
                        success: false,
                        error: error instanceof Error ? error.message : 'Unknown error occurred'
                    };
                }
                await new Promise(resolve => setTimeout(resolve, tradeConfig.retryDelay));
            }
        }

        return {
            success: false,
            error: 'Max retries exceeded'
        };
    }

    public async setConfig(config: Partial<TradeConfig>): Promise<void> {
        this.defaultConfig = { ...this.defaultConfig, ...config };
    }
}

export const tradingService = TradingService.getInstance(); 
