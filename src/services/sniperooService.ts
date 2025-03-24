import axios from "axios";
import { validateEnv } from "../utils/env-validator";
import { Keypair } from "@solana/web3.js";
import { Database } from "sqlite3";
import { config } from "../config";
import { PrismaClient, Prisma, Wallet as PrismaWallet, UserConfig as PrismaUserConfig, WalletTransaction } from "@prisma/client";

export interface WalletData {
    userId: string;
    walletAddress: string;
    walletPk: string;
    createdAt?: Date;
}

export interface WalletError {
    error: string;
}

export function isWalletData(data: WalletData | WalletError): data is WalletData {
    return 'walletAddress' in data;
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
    private env: any;
    private prisma: PrismaClient;

    constructor() {
        this.env = validateEnv();
        this.prisma = new PrismaClient();
    }

    async createWallet(userId: string, name: string): Promise<WalletData | WalletError> {
        try {
            const response = await axios.post(
                "https://api.sniperoo.app/user/wallets",
                {
                    name
                },
                {
                    headers: {
                        Authorization: `Bearer ${process.env.SNIPEROO_API_KEY}`,
                        "Content-Type": "application/json",
                    },
                }
            );

            console.log('Response status:', response.status);
            console.log('Response data:', JSON.stringify(response.data, null, 2));

            // Check for successful status code (201 Created)
            if (response.status === 201 || response.status === 200) {
                // Ensure we have the required data
                if (!response.data || !response.data.walletAddress || !response.data.walletPk) {
                    console.error('Missing required data in response:', response.data);
                    return { error: "Invalid response data from server" };
                }

                const walletData: WalletData = {
                    userId,
                    walletAddress: response.data.walletAddress,
                    walletPk: response.data.walletPk,
                    createdAt: new Date()
                };

                // Create wallet and default config in a transaction
                await this.prisma.$transaction(async (prisma) => {
                    await prisma.wallet.create({
                        data: {
                            userId: walletData.userId,
                            walletAddress: walletData.walletAddress,
                            walletPk: walletData.walletPk,
                            createdAt: walletData.createdAt
                        }
                    });
                });

                return walletData;
            }
            return { error: "Failed to create wallet" };
        } catch (error) {
            console.error("Error creating wallet:", error);
            if (axios.isAxiosError(error) && error.response?.data) {
                return { error: error.response.data.message || "Failed to create wallet" };
            }
            return { error: "An unexpected error occurred" };
        }
    }

    async importWallet(userId: string, privateKey: string): Promise<WalletData | WalletError> {
        try {
            const response = await axios.post(
                "https://api.sniperoo.app/user/wallets/import",
                {
                    privateKey,
                    name: `Wallet-${userId}`
                },
                {
                    headers: {
                        Authorization: `Bearer ${process.env.SNIPEROO_API_KEY}`,
                        "Content-Type": "application/json",
                    },
                }
            );
            console.log('Response status:', response.status);
            console.log('Response data:', JSON.stringify(response.data, null, 2));

            if (response.status === 201 || response.status === 200) {
                if (!response.data || !response.data.walletAddress || !response.data.walletPk) {
                    console.error('Missing required data in response:', response.data);
                    return { error: "Invalid response data from server" };
                }

                const walletData: WalletData = {
                    userId,
                    walletAddress: response.data.walletAddress,
                    walletPk: response.data.walletPk,
                    createdAt: new Date()
                };

                // Use upsert to handle both creation and updating
                await this.prisma.wallet.upsert({
                    where: { userId },
                    update: {
                        walletAddress: walletData.walletAddress,
                        walletPk: walletData.walletPk
                    },
                    create: {
                        userId: walletData.userId,
                        walletAddress: walletData.walletAddress,
                        walletPk: walletData.walletPk,
                        createdAt: walletData.createdAt
                    }
                });

                return walletData;
            }
            return { error: "Failed to import wallet" };
        } catch (error) {
            console.error("Error importing wallet:", error);
            if (axios.isAxiosError(error)) {
                if (error.response?.status === 400) {
                    return { error: error.response.data.message || "Invalid private key format" };
                } else if (error.response?.status === 500) {
                    return { error: error.response.data.message || "Server error occurred while importing wallet" };
                } else if (error.response?.data?.message) {
                    return { error: error.response.data.message };
                }
            }
            return { error: "An unexpected error occurred while importing wallet" };
        }
    }

    async getWallet(userId: string) {
        return this.prisma.wallet.findUnique({
            where: { userId }
        });
    }

    async getUserConfig(userId: string) {
        return this.prisma.userConfig.findUnique({
            where: { userId }
        });
    }

    async updateUserConfig(userId: string, config: Partial<UserConfig>): Promise<boolean> {
        try {
            await this.prisma.userConfig.upsert({
                where: { userId },
                update: {
                    autoBuy: config.autoBuy,
                    autoSell: config.autoSell,
                    buyAmount: config.buyAmount,
                    takeProfit: config.takeProfit,
                    stopLoss: config.stopLoss
                },
                create: {
                    userId,
                    autoBuy: config.autoBuy ?? false,
                    autoSell: config.autoSell ?? false,
                    buyAmount: config.buyAmount ?? 0,
                    takeProfit: config.takeProfit ?? 0,
                    stopLoss: config.stopLoss ?? 0
                }
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
            
            if (!wallet) {
                console.error("No wallet found for user");
                return false;
            }

            if (!userConfig) {
                console.error("No user config found");
                return false;
            }

            const requestBody = {
                walletAddresses: [wallet.walletAddress],
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
                        Authorization: `Bearer ${process.env.SNIPEROO_API_KEY}`,
                        "Content-Type": "application/json",
                    },
                }
            );

            // Record the transaction only if we have a valid wallet and response data
            if (wallet.id && response.data) {
                await this.recordTransaction(
                    wallet.id,
                    'BUY',
                    tokenAddress,
                    response.data.tokenAmount || 0,
                    response.data.solAmount || 0,
                    response.data.price || 0,
                    response.data.txHash || '',
                    'COMPLETED'
                );
            }

            return true;
        } catch (error) {
            // Get wallet for error recording
            const wallet = await this.getWallet(userId);
            
            // Record failed transaction if we have a valid wallet
            if (wallet?.id) {
                await this.recordTransaction(
                    wallet.id,
                    'BUY',
                    tokenAddress,
                    0,
                    0,
                    0,
                    '',
                    'FAILED',
                    error instanceof Error ? error.message : 'Unknown error'
                );
            }

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
                    walletAddress: wallet.walletAddress,
                    tokenAddress: tokenAddress,
                    percentage: percentage
                },
                {
                    headers: {
                        Authorization: `Bearer ${process.env.SNIPEROO_API_KEY}`,
                        "Content-Type": "application/json",
                    },
                }
            );

            // Record the transaction only if we have a valid wallet
            if (wallet.id) {
                await this.recordTransaction(
                    wallet.id, // Use wallet.id instead of userId
                    'SELL',
                    tokenAddress,
                    response.data.tokenAmount,
                    response.data.solAmount,
                    response.data.price,
                    response.data.txHash,
                    'COMPLETED'
                );
            }

            return true;
        } catch (error) {
            // Get wallet for error recording
            const wallet = await this.getWallet(userId);
            
            // Record failed transaction if we have a valid wallet
            if (wallet?.id) {
                await this.recordTransaction(
                    wallet.id, // Use wallet.id instead of userId
                    'SELL',
                    tokenAddress,
                    0,
                    0,
                    0,
                    '',
                    'FAILED',
                    error instanceof Error ? error.message : 'Unknown error'
                );
            }

            if (axios.isAxiosError(error)) {
                console.error(`Sniperoo API error (${error.response?.status || "unknown"}):`, error.response?.data || error.message);
            } else {
                console.error("Error selling token:", error instanceof Error ? error.message : "Unknown error");
            }
            return false;
        }
    }

    async getUsersWithAutoBuy(): Promise<{ userId: string }[]> {
        const configs = await this.prisma.userConfig.findMany({
            where: { autoBuy: true },
            select: { userId: true }
        });
        return configs;
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
