import { Telegraf, Context } from 'telegraf';
import { Connection } from '@solana/web3.js';
import { sniperooService } from '../services/sniperooService';
import { config } from '../config';
import { registerCommands } from './commands';
import { sendTokenAlert } from './alerts';

// Interface for bot configuration
export interface TelegramBotConfig {
  enabled: boolean;
  token: string;
  pumpSwapCallsEnabled: boolean;
}

// Create connection instance
const connection = new Connection(process.env.HELIUS_HTTPS_URI || 'https://api.mainnet-beta.solana.com');

class TelegramBot {
  private bot: Telegraf;
  private static instance: TelegramBot;
  private isInitialized: boolean = false;

  private constructor() {
    const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!telegramToken) {
      console.error('❌ Telegram bot token not found in environment variables');
      throw new Error('TELEGRAM_BOT_TOKEN is required');
    }
    
    this.bot = new Telegraf(telegramToken);
  }

  public static getInstance(): TelegramBot {
    if (!TelegramBot.instance) {
      TelegramBot.instance = new TelegramBot();
    }
    return TelegramBot.instance;
  }

  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }
    
    console.log('🤖 Initializing Telegram bot...');
    
    // Register bot commands with Telegram
    await this.bot.telegram.setMyCommands([
      { command: 'start', description: 'Start the bot and get welcome message' },
      { command: 'buy', description: 'Buy a token using Sniperoo' },
      { command: 'sell', description: 'Sell a token using Sniperoo' },
      { command: 'wallet', description: 'Manage your Sniperoo wallet' },
      { command: 'config', description: 'Configure your trading settings' },
      { command: 'togglepumpswap', description: 'Toggle PumpSwap calls notifications' }
    ]);

    // Register command handlers
    registerCommands(this.bot);

    // Start bot
    this.bot.launch();
    console.log('✅ Telegram bot started successfully');
    this.isInitialized = true;
    
    // Enable graceful stop
    process.once('SIGINT', () => this.bot.stop('SIGINT'));
    process.once('SIGTERM', () => this.bot.stop('SIGTERM'));
  }

  public async sendTokenAlert(
    tokenAddress: string, 
    tokenName: string, 
    tokenSymbol: string, 
    liquidityInSol: number, 
    buyLink: string
  ): Promise<void> {
    if (!this.isInitialized) {
      console.error('❌ Cannot send alert, Telegram bot not initialized');
      return;
    }

    // Get all users who have auto-buy enabled
    const usersWithAutoBuy = await sniperooService.getUsersWithAutoBuy();
    
    // Send alerts to all users with auto-buy enabled
    for (const user of usersWithAutoBuy) {
      try {
        await sendTokenAlert(this.bot, user.userId, tokenAddress, tokenName, tokenSymbol, liquidityInSol, buyLink);
      } catch (error) {
        console.error(`Error sending alert to user ${user.userId}:`, error);
      }
    }
  }
}

export const telegramBot = TelegramBot.getInstance(); 