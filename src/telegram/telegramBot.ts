import { Telegraf, Context, Scenes, session } from 'telegraf';
import { Connection } from '@solana/web3.js';
import { jupiterService } from '../services/jupiterService';
import { config } from '../config';
import { registerCommands } from './commands';
import { registerCallbackHandlers } from './callbackHandlers';
import { sendTokenAlert } from './alerts';
import { setupScenes } from './scenes';

// Interface for bot configuration
export interface TelegramBotConfig {
  enabled: boolean;
  token: string;
  pumpSwapCallsEnabled: boolean;
}

// Create connection instance
const connection = new Connection(process.env.RPC_ENDPOINT || process.env.HELIUS_HTTPS_URI || 'https://api.mainnet-beta.solana.com');

// Define the channel ID directly - this is a workaround for channel command issues
// Get this ID from your channel URL (like -1001234567890)
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID || '';
// Enable channel alerts by default if a channel ID is set
const CHANNEL_ALERTS_ENABLED = process.env.TELEGRAM_CHANNEL_ALERTS_ENABLED !== 'false';

// Store this in global scope for access by other modules
if (CHANNEL_ID) {
  process.env.TELEGRAM_CHANNEL_ID = CHANNEL_ID;
  process.env.TELEGRAM_CHANNEL_ALERTS_ENABLED = String(CHANNEL_ALERTS_ENABLED);
  console.log(`Channel alerts ${CHANNEL_ALERTS_ENABLED ? 'enabled' : 'disabled'} for channel ID: ${CHANNEL_ID}`);
}

class TelegramBot {
  private bot: Telegraf;
  private static instance: TelegramBot;
  private isInitialized: boolean = false;

  private constructor() {
    const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
    console.log("===========================")
    console.log(telegramToken);
    console.log("===========================")
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
    
    // Set up session middleware
    this.bot.use(session());
    
    // Set up scenes
    const stage = setupScenes();
    this.bot.use(stage.middleware());
    
    // Register bot commands with Telegram
    await this.bot.telegram.setMyCommands([
      { command: 'start', description: 'Start the bot and get welcome message' },
      { command: 'buy', description: 'Buy a token' },
      { command: 'sell', description: 'Sell a token' },
      { command: 'wallet', description: 'Manage your wallet' },
      { command: 'config', description: 'Configure your trading settings' },
      { command: 'togglepumpswap', description: 'Toggle PumpSwap calls notifications' },
      { command: 'togglejito', description: 'Toggle Jito MEV protection' },
      { command: 'pumpsettings', description: 'Configure Pump.fun swap settings' },
      { command: 'service', description: 'Choose swap service (Jupiter or Pump.fun)' },
      { command: 'togglechannel', description: 'Toggle channel alerts (admin only)' },
      { command: 'getchannelid', description: 'Get channel ID from forwarded message' },
      { command: 'testchannel', description: 'Send test alerts to your configured channel' }
    ]);

    // Register command handlers
    registerCommands(this.bot);
    
    // Register callback handlers
    registerCallbackHandlers(this.bot);
    
    // Special handling for channel posts to manually handle messages
    this.bot.on('channel_post', async (ctx) => {
      const message = ctx.channelPost;
      console.log("Channel post received:", message);
      
      // Check if it's a text message that looks like a command
      if (message && 'text' in message && message.text.startsWith('/')) {
        console.log("Channel command detected:", message.text);
        
        // The bot will log this but won't automatically handle it
        // You'll need to manually configure channel ID in .env
      }
    });

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
    buyLink: string,
    isMigrationToken: boolean = false,
    marketCap?: string,
    volume24h?: string,
    bundles?: string,
    percentage?: string,
    solSpent?: string
  ): Promise<void> {
    if (!this.isInitialized) {
      console.error('📱 TELEGRAM: ❌ Cannot send alert, Telegram bot not initialized');
      
      // Force initialization attempt
      try {
        console.log('📱 TELEGRAM: Attempting to initialize bot before sending alert...');
        await this.initialize();
        console.log('📱 TELEGRAM: Bot initialized successfully, proceeding with alert');
      } catch (error) {
        console.error('📱 TELEGRAM: Failed emergency initialization attempt:', error);
        return;
      }
    }

    console.log('📱 TELEGRAM: sendTokenAlert called for', tokenSymbol, tokenAddress);

    // Send to channel only (no user preference logic)
    try {
      console.log('📱 TELEGRAM: Importing alerts module...');
      const { sendTokenAlert: sendAlert } = await import('./alerts');
      console.log('📱 TELEGRAM: Successfully imported alerts module');
      
      console.log('📱 TELEGRAM: Calling sendAlert function with bot and token data');
      await sendAlert(
        this.bot, 
        tokenAddress, 
        tokenName, 
        tokenSymbol, 
        liquidityInSol, 
        buyLink,
        isMigrationToken,
        marketCap,
        volume24h,
        bundles,
        percentage,
        solSpent
      );
      console.log('📱 TELEGRAM: Alert successfully processed');
    } catch (error) {
      console.error(`📱 TELEGRAM: 💥 Error sending channel alert for token ${tokenAddress}:`, error);
    }
  }

  /**
   * Send a PnL alert to the Telegram channel
   */
  public async sendPnLAlert(
    channelId: string,
    tokenAddress: string,
    tokenName: string,
    tokenSymbol: string,
    pnl: number,
    pnlPercentage: number,
    currentPrice: number
  ): Promise<void> {
    if (!this.isInitialized) {
      console.error('📱 TELEGRAM: ❌ Cannot send PnL alert, Telegram bot not initialized');
      return;
    }

    console.log('📱 TELEGRAM: sendPnLAlert called for', tokenSymbol, tokenAddress);

    try {
      console.log('📱 TELEGRAM: Importing alerts module...');
      const { sendPnlReport } = await import('./alerts');
      console.log('📱 TELEGRAM: Successfully imported sendPnlReport function');
      
      // Send to channel
      await sendPnlReport(
        this.bot,
        channelId, // This is the channel ID instead of userId
        tokenAddress,
        tokenName,
        tokenSymbol,
        pnl,
        pnlPercentage,
        currentPrice
      );
      console.log('📱 TELEGRAM: PnL alert successfully sent to channel', channelId);
    } catch (error) {
      console.error(`📱 TELEGRAM: 💥 Error sending PnL alert for token ${tokenAddress}:`, error);
    }
  }

  /**
   * Send a PnL alert with image to the Telegram channel
   */
  public async sendPnLAlertWithImage(
    channelId: string,
    tokenAddress: string,
    tokenSymbol: string,
    pnlPercentage: number,
    pnlImage: Buffer
  ): Promise<void> {
    if (!this.isInitialized) {
      console.error('📱 TELEGRAM: ❌ Cannot send PnL alert, Telegram bot not initialized');
      return;
    }

    console.log('📱 TELEGRAM: sendPnLAlertWithImage called for', tokenSymbol, tokenAddress);

    try {
      // Send the PnL image with caption
      await this.bot.telegram.sendPhoto(
        channelId, 
        { source: pnlImage }, 
        { 
          caption: `🚀 *PNL ALERT: $${tokenSymbol || 'TOKEN'}* - Growth: *+${pnlPercentage.toFixed(2)}%*\n\nToken: \`${tokenAddress}\`\n[Check it out](https://pump.fun/${tokenAddress})`,
          parse_mode: 'Markdown'
        }
      );
      console.log('📱 TELEGRAM: PnL alert with image successfully sent to channel', channelId);
    } catch (error) {
      console.error(`📱 TELEGRAM: 💥 Error sending PnL alert with image for token ${tokenAddress}:`, error);
    }
  }

  /**
   * Send a top calls report with image to the Telegram channel
   */
  public async sendTopCallsReport(
    channelId: string,
    reportImage: Buffer,
    messageText: string
  ): Promise<void> {
    if (!this.isInitialized) {
      console.error('📱 TELEGRAM: ❌ Cannot send top calls report, Telegram bot not initialized');
      return;
    }

    console.log('📱 TELEGRAM: sendTopCallsReport called for channel', channelId);

    try {
      // Send the image with the full text as caption (single message)
      await this.bot.telegram.sendPhoto(
        channelId, 
        { source: reportImage }, 
        { 
          caption: messageText,
          parse_mode: 'Markdown',
          disable_web_page_preview: true
        } as any
      );
      
      console.log('📱 TELEGRAM: Top calls report successfully sent to channel', channelId);
    } catch (error) {
      console.error(`📱 TELEGRAM: 💥 Error sending top calls report:`, error);
      
      // If the message is too long for a caption, try sending as two separate messages
      try {
        console.log('📱 TELEGRAM: Message may be too long for caption, sending as separate messages');
        
        // First send image with brief caption
        await this.bot.telegram.sendPhoto(
          channelId, 
          { source: reportImage }, 
          { caption: "Today's Top Performing Tokens" }
        );
        
        // Then send detailed message
        await this.bot.telegram.sendMessage(
          channelId, 
          messageText, 
          {
            parse_mode: 'Markdown',
            disable_web_page_preview: true
          } as any
        );
        
        console.log('📱 TELEGRAM: Top calls report sent as separate messages');
      } catch (fallbackError) {
        console.error(`📱 TELEGRAM: 💥 Failed to send even with fallback approach:`, fallbackError);
      }
    }
  }
}

export const telegramBot = TelegramBot.getInstance(); 
