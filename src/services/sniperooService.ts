import axios from "axios";
import { validateEnv } from "../utils/env-validator";
import { Keypair } from "@solana/web3.js";
import { Database } from "sqlite3";
import { config } from "../config";
import { PrismaClient, WalletTransaction } from "@prisma/client";

interface WalletData {
    userId: string;
    publicKey: string;
    createdAt: Date;
}

export interface UserConfig {
    userId: string;
    autoBuy: boolean;
    buyAmount: number;
    takeProfit: number;
    stopLoss: number;
    autoSell: boolean;
}

export class SniperooService {
    private db: Database;
    private env: any;
    private prisma: PrismaClient;

    constructor() {
        this.db = new Database("src/tracker/wallets.db");
        this.env = validateEnv();
        this.prisma = new PrismaClient();
        this.initDatabase();
    }

    private initDatabase() {
        // Create wallets table without private key storage
        this.db.run(`
            CREATE TABLE IF NOT EXISTS wallets (
                userId TEXT PRIMARY KEY,
                publicKey TEXT UNIQUE,
                createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Create user configurations table
        this.db.run(`
            CREATE TABLE IF NOT EXISTS user_configs (
                userId TEXT PRIMARY KEY,
                autoBuy BOOLEAN DEFAULT ${config.sniperoo.auto_sell},
                buyAmount REAL DEFAULT ${config.sniperoo.default_buy_amount},
                takeProfit REAL DEFAULT ${config.sniperoo.default_take_profit},
                stopLoss REAL DEFAULT ${config.sniperoo.default_stop_loss},
                autoSell BOOLEAN DEFAULT ${config.sniperoo.auto_sell},
                FOREIGN KEY (userId) REFERENCES wallets(userId)
            )
        `);
    }

    async createWallet(userId: string): Promise<WalletData | null> {
        try {
            const response = await axios.post(
                "https://api.sniperoo.app/user/wallets",
                {},
                {
                    headers: {
                        Authorization: `Bearer ${this.env.SNIPEROO_API_KEY}`,
                        "Content-Type": "application/json",
                    },
                }
            );

            if (response.data && response.data.publicKey) {
                const walletData: WalletData = {
                    userId,
                    publicKey: response.data.publicKey,
                    createdAt: new Date()
                };

                await new Promise((resolve, reject) => {
                    this.db.run(
                        "INSERT INTO wallets (userId, publicKey) VALUES (?, ?)",
                        [walletData.userId, walletData.publicKey],
                        (err) => err ? reject(err) : resolve(null)
                    );
                });

                // Initialize user config with defaults
                await new Promise((resolve, reject) => {
                    this.db.run(
                        "INSERT INTO user_configs (userId) VALUES (?)",
                        [userId],
                        (err) => err ? reject(err) : resolve(null)
                    );
                });

                return walletData;
            }
            return null;
        } catch (error) {
            console.error("Error creating wallet:", error);
            return null;
        }
    }

    async importWallet(userId: string, privateKey: string): Promise<WalletData | null> {
        try {
            const response = await axios.post(
                "https://api.sniperoo.app/user/wallets/import",
                {
                    privateKey,
                    name: `Wallet-${userId}`
                },
                {
                    headers: {
                        Authorization: `Bearer ${this.env.SNIPEROO_API_KEY}`,
                        "Content-Type": "application/json",
                    },
                }
            );

            if (response.data && response.data.publicKey) {
                const walletData: WalletData = {
                    userId,
                    publicKey: response.data.publicKey,
                    createdAt: new Date()
                };

                await new Promise((resolve, reject) => {
                    this.db.run(
                        "INSERT INTO wallets (userId, publicKey) VALUES (?, ?)",
                        [walletData.userId, walletData.publicKey],
                        (err) => err ? reject(err) : resolve(null)
                    );
                });

                // Initialize user config with defaults
                await new Promise((resolve, reject) => {
                    this.db.run(
                        "INSERT INTO user_configs (userId) VALUES (?)",
                        [userId],
                        (err) => err ? reject(err) : resolve(null)
                    );
                });

                return walletData;
            }
            return null;
        } catch (error) {
            console.error("Error importing wallet:", error);
            return null;
        }
    }

    async getWallet(userId: string): Promise<WalletData | null> {
        return new Promise((resolve, reject) => {
            this.db.get(
                "SELECT * FROM wallets WHERE userId = ?",
                [userId],
                (err, row) => err ? reject(err) : resolve(row as WalletData || null)
            );
        });
    }

    async getUserConfig(userId: string): Promise<UserConfig | null> {
        return new Promise((resolve, reject) => {
            this.db.get(
                "SELECT * FROM user_configs WHERE userId = ?",
                [userId],
                (err, row) => err ? reject(err) : resolve(row as UserConfig || null)
            );
        });
    }

    async updateUserConfig(userId: string, config: Partial<UserConfig>): Promise<boolean> {
        try {
            const updates = Object.entries(config)
                .map(([key, value]) => `${key} = ?`)
                .join(', ');
            
            const values = Object.values(config);
            values.push(userId);

            await new Promise((resolve, reject) => {
                this.db.run(
                    `UPDATE user_configs SET ${updates} WHERE userId = ?`,
                    values,
                    (err) => err ? reject(err) : resolve(null)
                );
            });

            return true;
        } catch (error) {
            console.error("Error updating user config:", error);
            return false;
        }
    }

    async buyToken(tokenAddress: string, userId: string): Promise<boolean> {
        try {
            const wallet = await this.getWallet(userId);
            const userConfig = await this.getUserConfig(userId);
            
            if (!wallet || !userConfig) {
                console.error("No wallet or config found for user");
                return false;
            }

            const requestBody = {
                walletAddresses: [wallet.publicKey],
                tokenAddress: tokenAddress,
                inputAmount: userConfig.buyAmount,
                autoSell: {
                    enabled: userConfig.autoSell,
                    strategy: {
                        strategyName: "simple",
                        profitPercentage: userConfig.takeProfit,
                        stopLossPercentage: userConfig.stopLoss,
                    },
                },
            };

            const response = await axios.post(
                "https://api.sniperoo.app/trading/buy-token?toastFrontendId=0",
                requestBody,
                {
                    headers: {
                        Authorization: `Bearer ${this.env.SNIPEROO_API_KEY}`,
                        "Content-Type": "application/json",
                    },
                }
            );

            // Record the transaction
            await this.recordTransaction(
                userId,
                'BUY',
                tokenAddress,
                response.data.tokenAmount,
                response.data.solAmount,
                response.data.price,
                response.data.txHash,
                'COMPLETED'
            );

            return true;
        } catch (error) {
            // Record failed transaction
            await this.recordTransaction(
                userId,
                'BUY',
                tokenAddress,
                0,
                0,
                0,
                '',
                'FAILED',
                error instanceof Error ? error.message : 'Unknown error'
            );
            if (axios.isAxiosError(error)) {
                console.error(`Sniperoo API error (${error.response?.status || "unknown"}):`, error.response?.data || error.message);
            } else {
                console.error("Error buying token:", error instanceof Error ? error.message : "Unknown error");
            }
            return false;
        }
    }

    async sellToken(tokenAddress: string, percentage: number, userId: string): Promise<boolean> {
        try {
            const wallet = await this.getWallet(userId);
            if (!wallet) {
                console.error("No wallet found for user");
                return false;
            }

            const response = await axios.post(
                "https://api.sniperoo.app/trading/sell-percentage-from-position",
                {
                    walletAddress: wallet.publicKey,
                    tokenAddress: tokenAddress,
                    percentage: percentage
                },
                {
                    headers: {
                        Authorization: `Bearer ${this.env.SNIPEROO_API_KEY}`,
                        "Content-Type": "application/json",
                    },
                }
            );

            // Record the transaction
            await this.recordTransaction(
                userId,
                'SELL',
                tokenAddress,
                response.data.tokenAmount,
                response.data.solAmount,
                response.data.price,
                response.data.txHash,
                'COMPLETED'
            );

            return true;
        } catch (error) {
            // Record failed transaction
            await this.recordTransaction(
                userId,
                'SELL',
                tokenAddress,
                0,
                0,
                0,
                '',
                'FAILED',
                error instanceof Error ? error.message : 'Unknown error'
            );
            if (axios.isAxiosError(error)) {
                console.error(`Sniperoo API error (${error.response?.status || "unknown"}):`, error.response?.data || error.message);
            } else {
                console.error("Error selling token:", error instanceof Error ? error.message : "Unknown error");
            }
            return false;
        }
    }

    async getUsersWithAutoBuy(): Promise<{ userId: string }[]> {
        return new Promise((resolve, reject) => {
            this.db.all(
                "SELECT userId FROM user_configs WHERE autoBuy = 1",
                (err, rows) => err ? reject(err) : resolve(rows as { userId: string }[])
            );
        });
    }

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
            await this.prisma.walletTransaction.create({
                data: {
                    walletId,
                    type,
                    tokenMint,
                    tokenAmount,
                    solAmount,
                    price,
                    txHash,
                    status,
                    error
                }
            });

            // Update wallet balance
            if (status === 'COMPLETED') {
                const currentBalance = await this.prisma.walletBalance.findUnique({
                    where: {
                        walletId_tokenMint: {
                            walletId,
                            tokenMint
                        }
                    }
                });

                if (currentBalance) {
                    await this.prisma.walletBalance.update({
                        where: {
                            walletId_tokenMint: {
                                walletId,
                                tokenMint
                            }
                        },
                        data: {
                            amount: type === 'BUY' 
                                ? currentBalance.amount + tokenAmount 
                                : currentBalance.amount - tokenAmount,
                            lastUpdated: new Date()
                        }
                    });
                } else if (type === 'BUY') {
                    await this.prisma.walletBalance.create({
                        data: {
                            walletId,
                            tokenMint,
                            amount: tokenAmount
                        }
                    });
                }
            }
        } catch (error) {
            console.error('Error recording transaction:', error);
            throw error;
        }
    }

    async getWalletBalance(walletId: string, tokenMint: string): Promise<number> {
        const balance = await this.prisma.walletBalance.findUnique({
            where: {
                walletId_tokenMint: {
                    walletId,
                    tokenMint
                }
            }
        });
        return balance?.amount || 0;
    }

    async getWalletTransactions(
        walletId: string,
        limit: number = 10,
        offset: number = 0
    ): Promise<WalletTransaction[]> {
        return this.prisma.walletTransaction.findMany({
            where: { walletId },
            orderBy: { timestamp: 'desc' },
            take: limit,
            skip: offset
        });
    }
}

// Export a singleton instance
export const sniperooService = new SniperooService(); 
