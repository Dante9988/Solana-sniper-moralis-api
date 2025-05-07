import { Client, TextChannel, Message, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, REST, Routes, SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import dotenv from 'dotenv';
import axios from 'axios';
import { PublicKey, Connection } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import { CallStatsAnalyzer } from '../callStats';
import { PUMP_FUN_PROGRAM } from '../constants';
import { analyzeTokenWithGrok, TokenAnalysisData, updateDiscordWithGrokAnalysis } from '../grok';
import { getRugCheckConfirmed } from '../transactions';
import { getTokenMarketData, formatPrice, formatMarketCap, formatVolume, formatLiquidity } from '../services/tokenDataService';
import { fetchSniperData } from '../services/sniperDataService';
import { storeTokenAlert } from '../services/tokenTrackingService';
import { sniperooService, UserConfig, isWalletData } from '../services/sniperooService';
import { registerCommands, setupCommandExecution } from './registerCommands';

dotenv.config();

// Create connection instance
const connection = new Connection(process.env.HELIUS_HTTPS_URI || 'https://api.mainnet-beta.solana.com');

export const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.DirectMessageTyping
    ]
});

let channel: TextChannel | null = null;

// Define slash commands
// const commands = [
//     new SlashCommandBuilder()
//         .setName('ping')
//         .setDescription('Check if the bot is alive'),
//     new SlashCommandBuilder()
//         .setName('wallet')
//         .setDescription('Manage your wallet')
//         .addSubcommand(subcommand =>
//             subcommand
//                 .setName('create')
//                 .setDescription('Create a new wallet')
//                 .addStringOption(option =>
//                     option.setName('name')
//                         .setDescription('Name for your new wallet')
//                         .setRequired(true)))
//         .addSubcommand(subcommand =>
//             subcommand
//                 .setName('import')
//                 .setDescription('Import an existing wallet')
//                 .addStringOption(option =>
//                     option.setName('private_key')
//                         .setDescription('Your private key')
//                         .setRequired(true))),
//     new SlashCommandBuilder()
//         .setName('buy')
//         .setDescription('Buy a token')
//         .addStringOption(option =>
//             option.setName('token_address')
//                 .setDescription('The token address to buy')
//                 .setRequired(true)),
//     new SlashCommandBuilder()
//         .setName('sell')
//         .setDescription('Sell a token')
//         .addStringOption(option =>
//             option.setName('token_address')
//                 .setDescription('The token address to sell')
//                 .setRequired(true))
//         .addNumberOption(option =>
//             option.setName('percentage')
//                 .setDescription('Percentage to sell')
//                 .setRequired(true)),
//     new SlashCommandBuilder()
//         .setName('config')
//         .setDescription('Manage your configuration')
//         .addSubcommand(subcommand =>
//             subcommand
//                 .setName('view')
//                 .setDescription('View your current configuration'))
//         .addSubcommand(subcommand =>
//             subcommand
//                 .setName('set')
//                 .setDescription('Set your configuration')
//                 .addBooleanOption(option =>
//                     option.setName('autobuy')
//                         .setDescription('Enable/disable auto-buy')
//                         .setRequired(true))
//                 .addNumberOption(option =>
//                     option.setName('amount')
//                         .setDescription('Amount in SOL')
//                         .setRequired(true))
//                 .addNumberOption(option =>
//                     option.setName('takeprofit')
//                         .setDescription('Take profit percentage')
//                         .setRequired(true))
//                 .addNumberOption(option =>
//                     option.setName('stoploss')
//                         .setDescription('Stop loss percentage')
//                         .setRequired(true))
//                 .addBooleanOption(option =>
//                     option.setName('autosell')
//                         .setDescription('Enable/disable auto-sell')
//                         .setRequired(true)))
// ];

// Register commands when bot is ready
client.once('ready', async () => {
    console.log('🤖 Discord bot is ready!');
    const channelId = process.env.DISCORD_CHANNEL_ID;
    console.log('Channel ID from env:', channelId);
    
    try {
        // Register slash commands
        const clientId = client.user?.id;
        if (clientId) {
            await registerCommands(clientId, process.env.DISCORD_BOT_TOKEN || '');
            // Set up command execution handler
            setupCommandExecution(client);
            console.log('✅ Commands registered and handlers set up');
        } else {
            console.error('❌ Failed to get client ID for command registration');
        }
        
        // Keep channel setup
        if (channelId) {
            channel = client.channels.cache.get(channelId.replace(/"/g, '')) as TextChannel;
            if (channel) {
                console.log('✅ Successfully connected to channel:', channel.name);
            } else {
                console.log('❌ Could not find channel with ID:', channelId);
            }
        }
    } catch (error) {
        console.error('Error setting up bot:', error);
    }
});

// Handle slash commands
// client.on('interactionCreate', async interaction => {
//     if (!interaction.isChatInputCommand()) return;
//
//     try {
//         switch (interaction.commandName) {
//             case 'ping':
//                 await interaction.reply('Pong! 🏓');
//                 break;
//
//             case 'wallet':
//                 if (interaction.options.getSubcommand() === 'create') {
//                     const name = interaction.options.getString('name', true);
//                     
//                     // // If command is used in a public channel, redirect to DM
//                     // const isDM = interaction.channel?.type === 1; // ChannelType.DM is 1
//                     
//                     // if (!isDM) {
//                     //     await interaction.reply({
//                     //         content: `⚠️ **SECURITY ALERT**\n\n` +
//                     //             `For your security, please create wallets through DM with the bot.\n` +
//                     //             `1. Right-click on the bot and select "Message"\n` +
//                     //             `2. Send: \`/wallet create ${name}\`\n\n` +
//                     //             `This ensures your wallet details remain completely private.`,
//                     //         ephemeral: true
//                     //     });
//                     //     return;
//                     // }
//
//                     const result = await sniperooService.createWallet(interaction.user.id, name);
//                     console.log(`Result: ${JSON.stringify(result)}`);
//                     if (isWalletData(result)) {
//                         await interaction.reply({
//                             content: `✅ Wallet "${name}" created successfully!\n\n` +
//                                 `⚠️ **CRITICAL SECURITY WARNING**\n` +
//                                 `━━━━━━━━━━━━━━━━━━━━━━\n` +
//                                 `🔑 **Public Key:** \`${result.walletAddress}\`\n` +
//                                 `🔐 **Private Key:** ||${result.walletPk}||\n\n` +
//                                 `⚠️ **PLEASE READ CAREFULLY:**\n` +
//                                 `• Never share your private key with anyone\n` +
//                                 `• Store these details securely offline\n` +
//                                 `• This is the ONLY time you'll see the private key\n` +
//                                 `• Anyone with your private key can access your funds\n` +
//                                 `• For maximum security, store these details in a secure password manager\n\n` +
//                                 `💡 **Tip:** Take a screenshot or copy these details NOW!`
//                         });
//                     } else {
//                         await interaction.reply({
//                             content: `❌ ${result.error}\nPlease try again or contact support if the issue persists.`,
//                             ephemeral: true
//                         });
//                     }
//                 } else if (interaction.options.getSubcommand() === 'import') {
//                     const privateKey = interaction.options.getString('private_key', true);
//                     const result = await sniperooService.importWallet(interaction.user.id, privateKey);
//                     if (isWalletData(result)) {
//                         await interaction.reply({
//                             content: `✅ Wallet imported successfully!\n\nPublic Key: \`${result.walletAddress}\``,
//                             ephemeral: true
//                         });
//                     } else {
//                         await interaction.reply({
//                             content: `❌ ${result.error}\nPlease try again or contact support if the issue persists.`,
//                             ephemeral: true
//                         });
//                     }
//                 }
//                 break;
//
//             case 'buy':
//                 const tokenAddress = interaction.options.getString('token_address', true);
//                 const success = await sniperooService.buyToken(tokenAddress, interaction.user.id);
//                 if (success) {
//                     const config = await sniperooService.getUserConfig(interaction.user.id);
//                     if (config) {
//                         // Create buttons for quick actions
//                         const buttons = [
//                             new ButtonBuilder()
//                                 .setLabel('🌊 Pump')
//                                 .setStyle(ButtonStyle.Link)
//                                 .setURL(`https://pump.fun/${tokenAddress}`),
//                             new ButtonBuilder()
//                                 .setLabel('👽 GMGN')
//                                 .setStyle(ButtonStyle.Link)
//                                 .setURL(`https://gmgn.ai/sol/token/${tokenAddress}`),
//                             new ButtonBuilder()
//                                 .setLabel('🐂 BullX')
//                                 .setStyle(ButtonStyle.Link)
//                                 .setURL(`https://neo.bullx.io/terminal?chainId=1399811149&address=${tokenAddress}`),
//                             new ButtonBuilder()
//                                 .setLabel('⭐ Photon')
//                                 .setStyle(ButtonStyle.Link)
//                                 .setURL(`https://photon-sol.tinyastro.io/en/r/@Strobe/${tokenAddress}`),
//                             new ButtonBuilder()
//                                 .setLabel('🌌 Axiom')
//                                 .setStyle(ButtonStyle.Link)
//                                 .setURL(`https://axiom.trade/t/${tokenAddress}`)
//                         ];
//
//                         const secondRowButtons = [
//                             new ButtonBuilder()
//                                 .setLabel('🔄 Raydium')
//                                 .setStyle(ButtonStyle.Link)
//                                 .setURL(`https://raydium.io/swap/?inputCurrency=sol&outputCurrency=${tokenAddress}`),
//                             new ButtonBuilder()
//                                 .setLabel('🦅 Birdeye') 
//                                 .setStyle(ButtonStyle.Link)
//                                 .setURL(`https://birdeye.so/token/${tokenAddress}?chain=solana`),
//                             new ButtonBuilder()
//                                 .setLabel('📊 DexScreener')
//                                 .setStyle(ButtonStyle.Link)
//                                 .setURL(`https://dexscreener.com/solana/${tokenAddress}`)
//                         ];
//
//                         await interaction.reply({
//                             content: `✅ Buy order placed successfully!\n\n` +
//                                 `Token: \`${tokenAddress}\`\n` +
//                                 `Amount: ${config.buyAmount} SOL\n` +
//                                 `Auto-sell: ${config.autoSell ? 'Enabled' : 'Disabled'}\n` +
//                                 `Take Profit: ${config.takeProfit}%\n` +
//                                 `Stop Loss: ${config.stopLoss}%`,
//                             components: [
//                                 new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons),
//                                 new ActionRowBuilder<ButtonBuilder>().addComponents(...secondRowButtons)
//                             ]
//                         });
//                     }
//                 } else {
//                     await interaction.reply({
//                         content: 'Failed to place buy order. Please try again.',
//                         ephemeral: true
//                     });
//                 }
//                 break;
//
//             case 'sell':
//                 const sellTokenAddress = interaction.options.getString('token_address', true);
//                 const percentage = interaction.options.getNumber('percentage', true);
//                 const sellSuccess = await sniperooService.sellToken(sellTokenAddress, percentage, interaction.user.id);
//                 if (sellSuccess) {
//                     await interaction.reply({
//                         content: `✅ Sell order placed successfully!\n\nToken: \`${sellTokenAddress}\`\nPercentage: ${percentage}%`,
//                         ephemeral: true
//                     });
//                 } else {
//                     await interaction.reply({
//                         content: 'Failed to place sell order. Please try again.',
//                         ephemeral: true
//                     });
//                 }
//                 break;
//
//             case 'config':
//                 if (interaction.options.getSubcommand() === 'view') {
//                     const config = await sniperooService.getUserConfig(interaction.user.id);
//                     if (config) {
//                         await interaction.reply({
//                             content: `📊 Your Configuration:\n\n` +
//                                 `Auto Buy: ${config.autoBuy ? '✅' : '❌'}\n` +
//                                 `Auto Sell: ${config.autoSell ? '✅' : '❌'}\n` +
//                                 `Take Profit: ${config.takeProfit}%\n` +
//                                 `Stop Loss: ${config.stopLoss}%`,
//                             ephemeral: true
//                         });
//                     } else {
//                         await interaction.reply({
//                             content: 'No configuration found. Use `/config set` to configure your settings.',
//                             ephemeral: true
//                         });
//                     }
//                 } else if (interaction.options.getSubcommand() === 'set') {
//                     const autoBuy = interaction.options.getBoolean('autobuy', true);
//                     const amount = interaction.options.getNumber('amount', true);
//                     const takeProfit = interaction.options.getNumber('takeprofit', true);
//                     const stopLoss = interaction.options.getNumber('stoploss', true);
//                     const autoSell = interaction.options.getBoolean('autosell', true);
//
//                     const configUpdate: Partial<UserConfig> = {
//                         userId: interaction.user.id,
//                         autoBuy,
//                         autoSell,
//                         takeProfit,
//                         stopLoss,
//                         buyAmount: amount
//                     };
//
//                     const success = await sniperooService.updateUserConfig(interaction.user.id, configUpdate);
//                     if (success) {
//                         await interaction.reply({
//                             content: `✅ Configuration updated successfully!\n\n` +
//                                 `Auto Buy: ${autoBuy ? '✅' : '❌'}\n` +
//                                 `Auto Sell: ${autoSell ? '✅' : '❌'}\n` +
//                                 `Take Profit: ${takeProfit}%\n` +
//                                 `Stop Loss: ${stopLoss}%`,
//                             ephemeral: true
//                         });
//                     } else {
//                         await interaction.reply({
//                             content: 'Failed to update configuration. Please try again.',
//                             ephemeral: true
//                         });
//                     }
//                 }
//                 break;
//         }
//     } catch (error) {
//         console.error('Error handling slash command:', error);
//         await interaction.reply({
//             content: 'An error occurred while processing your request.',
//             ephemeral: true
//         });
//     }
// });

export interface TokenData {
    price?: string;
    marketCap?: string;
}

export interface VolumeLiquidityData {
    volume1h?: string;
    volume24h?: string;
    liquidity?: string;
}

// Helper function to format numbers with commas and no suffixes
function formatNumber(value: string | number | undefined): string {
    if (value === undefined) return 'Unknown';
    const num = typeof value === 'string' ? parseFloat(value.replace(/[^0-9.]/g, '')) : value;
    if (isNaN(num)) return 'Unknown';
    return `$${num.toLocaleString('en-US', {maximumFractionDigits: 2})}`;
}

// function formatPrice(price: string | number | undefined): string {
//     if (!price) return 'Unknown';
    
//     const numPrice = Number(price);
    
//     // Convert to full decimal format
//     if (numPrice < 1) {
//         // Convert to string to avoid scientific notation
//         const priceString = numPrice.toFixed(20);
//         // Remove trailing zeros after decimal
//         const trimmedPrice = priceString.replace(/\.?0+$/, '');
//         return `$${trimmedPrice}`;
//     }
    
//     // For numbers >= 1, use regular formatting
//     return `$${numPrice.toLocaleString(undefined, {
//         minimumFractionDigits: 2,
//         maximumFractionDigits: 8
//     })}`;
// }

export async function getTokenPriceHistory(tokenMint: string): Promise<{
    items: Array<{
        unixTime: number;
        value: number;
    }>;
    success: boolean;
}> {
    try {
        // Get current timestamp
        const currentTime = Math.floor(Date.now() / 1000);
        // Start from 24 hours ago by default
        const startTime = currentTime - (24 * 60 * 60);

        const response = await axios.get(
            `https://public-api.birdeye.so/defi/history_price`, {
                params: {
                    address: tokenMint,
                    address_type: 'token',
                    type: '15m',
                    time_from: startTime,
                    time_to: currentTime
                },
                headers: {
                    'X-API-KEY': process.env.BIRDEYE_API_KEY,
                    'x-chain': 'solana',
                    'accept': 'application/json'
                }
            }
        );

        if (!response.data.success) {
            throw new Error('Failed to fetch price history');
        }

        return {
            items: response.data.data.items,
            success: true
        };
    } catch (error) {
        console.error('Error fetching price history:', error);
        return {
            items: [],
            success: false
        };
    }
}

async function fetchTokenData(tokenMint: string): Promise<TokenData> {
    const metrics = {
      start: performance.now(),
      total: 0
    };
  
    try {
      const tokenData = await getTokenMarketData(tokenMint);
      
      metrics.total = performance.now() - metrics.start;
      
      if (!tokenData) {
        console.log(`⚠️ Failed to fetch token data (${metrics.total.toFixed(2)}ms)`);
        return {};
      }
      
      console.log(`\n📊 Token Data Fetch:
  • Total Time: ${metrics.total.toFixed(2)}ms
  • Price: ${formatPrice(tokenData.price)}
  • Total Supply: ${tokenData.totalSupply}
  • Market Cap: ${formatMarketCap(tokenData.marketCap)}`);
  
      // Only return data if we have valid values
      if (tokenData.marketCap > 0) {
        return {
          price: formatPrice(tokenData.price),
          marketCap: formatMarketCap(tokenData.marketCap)
        };
      }
  
      return {};
    } catch (error) {
      metrics.total = performance.now() - metrics.start;
      console.error(`❌ Error fetching token data (${metrics.total.toFixed(2)}ms):`, error);
      return {};
    }
  }

  async function getTokenVolumeAndLiquidity(tokenMint: string): Promise<VolumeLiquidityData> {
    try {
      const tokenData = await getTokenMarketData(tokenMint);
      
      if (!tokenData) {
        return {};
      }
      
      return {
        volume24h: formatVolume(tokenData.volume24h),
        liquidity: formatLiquidity(tokenData.liquidity),
      };
    } catch (error) {
      console.error('Error getting token volume and liquidity:', error);
      return {};
    }
  }

export interface TrenchBundleData {
    ticker?: string;
    bonded?: boolean;
    totalBundles?: number;
    holdingBundles?: number;
    totalSolSpent?: number;
    holdingPercentage?: number;
}

export async function fetchTrenchData(tokenMint: string): Promise<TrenchBundleData> {
    try {
        const response = await axios.get(
            `https://trench.bot/api/bundle/bundle_advanced/${tokenMint}`
        );

        // Count holding bundles (bundles with holding_amount > 0)
        const holdingBundles = Object.values(response.data.bundles).filter(
            (bundle: any) => bundle.holding_amount > 0
        ).length;

        return {
            ticker: response.data.ticker,
            bonded: response.data.bonded,
            totalBundles: response.data.total_bundles,
            holdingBundles: holdingBundles,
            totalSolSpent: response.data.total_sol_spent,
            holdingPercentage: response.data.total_holding_percentage
        };
    } catch (error) {
        console.error('Error fetching Trench data:', error);
        return {};
    }
}

async function calculateMarketCap(tokenMint: string): Promise<number> {
    try {
      const tokenData = await getTokenMarketData(tokenMint);
      return tokenData?.marketCap || 0;
    } catch (error) {
      console.error('Error calculating market cap:', error);
      return 0;
    }
  }

function getEasternTime(): string {
    const options: Intl.DateTimeFormatOptions = {
        timeZone: 'America/New_York',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
    };

    return new Date().toLocaleString('en-US', options);
}

// Add function to check bonding curve status
async function checkBondingCurveStatus(tokenMint: string): Promise<boolean> {
    try {
        // Get bonding curve PDA
        const [bondingCurvePDA] = PublicKey.findProgramAddressSync(
            [
                Buffer.from("bonding-curve"),
                new PublicKey(tokenMint).toBuffer()
            ],
            new PublicKey(PUMP_FUN_PROGRAM)
        );

        // Fetch raw account data
        const accountInfo = await connection.getAccountInfo(bondingCurvePDA);
        if (!accountInfo) {
            return false;
        }

        // Check complete status (byte at offset 48)
        return accountInfo.data.readUInt8(48) === 1;
    } catch (error) {
        console.error('Error checking bonding curve status:', error);
        return false;
    }
}

// Helper function to delay execution
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Helper function to fetch latest price with retry
async function fetchLatestPrice(tokenMint: string, retryCount = 3): Promise<number> {
  const RETRY_DELAY = 1000; // 1 second delay
  let attempts = 0;
  
  while (attempts < retryCount) {
    try {
      if (attempts > 0) {
        console.log(`Retrying latest price fetch for ${tokenMint} (attempt ${attempts + 1}/${retryCount})...`);
        await sleep(RETRY_DELAY);
      }
      
      const response = await axios.get(
        `https://solana-gateway.moralis.io/token/mainnet/${tokenMint}/price`,
        {
          headers: {
            'accept': 'application/json',
            'X-API-Key': process.env.MORALIS_API_KEY || ''
          },
          timeout: 10000 // 10 seconds timeout
        }
      );
      
      // Check if we got valid price data
      if (response.data && response.data.usdPrice && response.data.usdPrice > 0) {
        console.log(`Successfully fetched latest price data for ${tokenMint}: $${response.data.usdPrice}`);
        return response.data.usdPrice;
      } else {
        console.warn(`Received invalid latest price data for ${tokenMint}: ${JSON.stringify(response.data)}`);
        // Treat this as an error and retry
        throw new Error('Invalid latest price data received');
      }
    } catch (error) {
      console.error(`Error fetching latest price for ${tokenMint} (attempt ${attempts + 1}/${retryCount}):`, error);
      attempts++;
      
      if (attempts >= retryCount) {
        console.error(`All ${retryCount} latest price fetch attempts failed for ${tokenMint}`);
        return 0;
      }
    }
  }
  
  return 0;
}

// Add this constant at the top of the file
const MINIMUM_MARKET_CAP = 15000; // $15k minimum threshold

// Modify the doubleCheckMarketCap function to be more thorough
async function doubleCheckMarketCap(tokenMint: string, retryCount = 3): Promise<number> {
    try {
        console.log(`🔄 Double-checking market cap for ${tokenMint}...`);
        let highestMarketCap = 0;

        // Make multiple attempts to get the most accurate market cap
        for (let i = 0; i < retryCount; i++) {
            if (i > 0) {
                console.log(`Attempt ${i + 1}/${retryCount} to verify market cap...`);
                await sleep(2000); // Wait 2 seconds between attempts
            }

            const [tokenData, latestPrice] = await Promise.all([
                getTokenMarketData(tokenMint),
                fetchLatestPrice(tokenMint)
            ]);

            const PUMPFUN_TOTAL_SUPPLY = 1_000_000_000;
            const marketCapFromPrice = latestPrice * PUMPFUN_TOTAL_SUPPLY;
            const marketCapFromData = tokenData?.marketCap || 0;

            console.log(`
            Market Cap Check (Attempt ${i + 1}):
            • From Price: $${marketCapFromPrice.toLocaleString()}
            • From Data: $${marketCapFromData.toLocaleString()}
            `);

            // Use the higher value between the two calculations
            const currentMarketCap = Math.max(marketCapFromPrice, marketCapFromData);
            highestMarketCap = Math.max(highestMarketCap, currentMarketCap);
        }

        console.log(`✅ Final verified market cap for ${tokenMint}: $${highestMarketCap.toLocaleString()}`);
        return highestMarketCap;
    } catch (error) {
        console.error(`❌ Error double-checking market cap for ${tokenMint}:`, error);
        return 0;
    }
}

export async function sendTokenAlert(tokenMint: string, rugCheckPassed: boolean, prefetchedData?: any) {
    const metrics = {
        start: performance.now(),
        total: 0
    };

    if (!channel) {
        console.log('❌ Cannot send message - channel not found');
        return;
    }

    // Check if this is a Pump.fun token - use prefetched data if available
    const isPumpToken = prefetchedData?.isPumpToken !== undefined 
        ? prefetchedData.isPumpToken 
        : tokenMint.toLowerCase().endsWith('pump');
    
    console.log(`Token ${tokenMint} is ${isPumpToken ? 'a Pump.fun token' : 'not a Pump.fun token'}`);
    
    // Skip non-Pump.fun tokens
    if (!isPumpToken) {
        console.log(`⏭️ Skipping alert for non-Pump.fun token: ${tokenMint}`);
        return;
    }

    try {
        // Variables to store data
        let tokenData, trenchData, sniperData, marketCap, price;
        
        // Use prefetched data if available, otherwise fetch new data
        if (prefetchedData && prefetchedData.tokenData && prefetchedData.trenchData) {
            console.log(`Using prefetched data for ${tokenMint}`);
            tokenData = prefetchedData.tokenData;
            trenchData = prefetchedData.trenchData;
            sniperData = prefetchedData.sniperData;
            
            // Use prefetched market cap if available, or use tokenData's marketCap
            if (prefetchedData.marketCap !== undefined) {
                console.log(`Using prefetched market cap: $${prefetchedData.marketCap.toLocaleString()}`);
                marketCap = prefetchedData.marketCap;
                
                // Skip market cap verification when we have prefetched data
                console.log(`🔍 Skipping market cap verification for faster alerting`);
            } else if (tokenData?.marketCap) {
                console.log(`Using market cap from token data: $${tokenData.marketCap.toLocaleString()}`);
                marketCap = tokenData.marketCap;
            } else {
                // Only verify market cap if we don't have it from prefetched data
                console.log(`🔍 Verifying market cap before proceeding...`);
                marketCap = await doubleCheckMarketCap(tokenMint);
            }
            
            // Get the latest price right before sending the alert
            if (prefetchedData.price !== undefined) {
                console.log(`Using prefetched price data for ${tokenMint}`);
                price = prefetchedData.price;
            } else {
                console.log(`Fetching latest price for ${tokenMint} before sending alert...`);
                price = await fetchLatestPrice(tokenMint);
            }
        } else {
            // No prefetched data, fetch everything as usual
            console.log(`🔍 Verifying market cap before proceeding...`);
            marketCap = await doubleCheckMarketCap(tokenMint);
    
            // If market cap is below minimum threshold, skip the alert
            if (marketCap < MINIMUM_MARKET_CAP) {
                console.log(`⚠️ Market cap ($${marketCap.toLocaleString()}) is below minimum threshold ($${MINIMUM_MARKET_CAP.toLocaleString()}). Skipping alert.`);
                return;
            }
    
            // Fetch all necessary data in parallel, but handle failures independently
            const [tokenDataResult, trenchResult, sniperDataResult] = await Promise.allSettled([
                getTokenMarketData(tokenMint),
                fetchTrenchData(tokenMint),
                fetchSniperData(tokenMint)
            ]);
            
            // Safely extract data from results
            tokenData = tokenDataResult.status === 'fulfilled' ? tokenDataResult.value : null;
            trenchData = trenchResult.status === 'fulfilled' ? trenchResult.value : {
                holdingBundles: 0,
                totalBundles: 0,
                holdingPercentage: 0,
                totalSolSpent: null,
                ticker: null
            };
            sniperData = sniperDataResult.status === 'fulfilled' ? sniperDataResult.value : null;
            
            // Get the latest price right before sending the alert
            console.log(`Fetching latest price for ${tokenMint} before sending alert...`);
            price = await fetchLatestPrice(tokenMint);
        }
        
        // If market cap is below minimum threshold, skip the alert
        if (marketCap < MINIMUM_MARKET_CAP) {
            console.log(`⚠️ Market cap ($${marketCap.toLocaleString()}) is below minimum threshold ($${MINIMUM_MARKET_CAP.toLocaleString()}). Skipping alert.`);
            return;
        }
        
        console.log(`Latest verified data for ${tokenMint}:
        - Price: ${price}
        - Market Cap: $${marketCap.toLocaleString()}`);
        
        // Get token name and ticker from Moralis data if available
        const tokenName = tokenData?.metadata?.name || trenchData.ticker?.toUpperCase() || 'UNKNOWN';
        const tokenSymbol = tokenData?.metadata?.symbol || trenchData.ticker?.toUpperCase() || 'UNKNOWN';
        const tokenLogo = tokenData?.metadata?.logo || null;
        const moralisLink = tokenData?.metadata?.links?.moralis || null;
        
        // Create first row of buttons
        const firstRowButtons = [
            new ButtonBuilder()
                .setLabel('🌊 Pump')
                .setStyle(ButtonStyle.Link)
                .setURL(`https://pump.fun/${tokenMint}`),
            new ButtonBuilder()
                .setLabel('👽 GMGN')
                .setStyle(ButtonStyle.Link)
                .setURL(`https://gmgn.ai/sol/token/${tokenMint}`),
            new ButtonBuilder()
                .setLabel('🐂 BullX')
                .setStyle(ButtonStyle.Link)
                .setURL(`https://neo.bullx.io/terminal?chainId=1399811149&address=${tokenMint}`),
            new ButtonBuilder()
                .setLabel('⭐ Photon')
                .setStyle(ButtonStyle.Link)
                .setURL(`https://photon-sol.tinyastro.io/en/r/@Strobe/${tokenMint}`),
            new ButtonBuilder()
                .setLabel('🌌 Axiom')
                .setStyle(ButtonStyle.Link)
                .setURL(`https://axiom.trade/t/${tokenMint}`)
        ];
        
        // Create second row of buttons
        const secondRowButtons = [
            new ButtonBuilder()
                .setLabel('🔄 Raydium')
                .setStyle(ButtonStyle.Link)
                .setURL(`https://raydium.io/swap/?inputCurrency=sol&outputCurrency=${tokenMint}`),
            new ButtonBuilder()
                .setLabel('🦅 Birdeye') 
                .setStyle(ButtonStyle.Link)
                .setURL(`https://birdeye.so/token/${tokenMint}?chain=solana`),
            new ButtonBuilder()
                .setLabel('📊 DexScreener')
                .setStyle(ButtonStyle.Link)
                .setURL(`https://dexscreener.com/solana/${tokenMint}`)
        ];
        
        // Add Moralis link if available
        if (moralisLink) {
            secondRowButtons.push(
                new ButtonBuilder()
                    .setLabel('Moralis')
                    .setStyle(ButtonStyle.Link)
                    .setURL(moralisLink)
                    .setEmoji('🔍')
            );
        }
        
        const detectedTime = getEasternTime();
        
        // Prepare sniper data section if available
        let sniperSection = '';
        if (sniperData && sniperData.totalSnipers > 0) {
            sniperSection = `
**🤖 Sniper Analysis**
━━━━━━━━━━━━━━━━━━━━━━
🎯 **Total Snipers:** ${sniperData.totalSnipers}
💰 **Profitable:** ${sniperData.profitableSnipers} (${sniperData.profitablePercentage.toFixed(1)}%)
📈 **Avg Profit:** ${sniperData.averageProfitPercentage.toFixed(1)}%
💵 **Total Sniped:** ${formatNumber(sniperData.totalSnipedUsd || 0)}
💸 **Total Sold:** ${formatNumber(sniperData.totalSoldUsd || 0)}
💎 **Total Profit:** ${formatNumber(sniperData.totalProfitUsd || 0)}
⏱️ **Quickest Sell:** ${sniperData.quickestSellBlocksAfter ? `${sniperData.quickestSellBlocksAfter} blocks` : 'N/A'}
`;
        }
        
        // Create complete message with all available data
        const message = {
            embeds: [{
                color: 0x2ecc71,
                title: `🚀 New Token Launch Detected: ${tokenSymbol}`,
                description: `
\`\`\`
Token: ${tokenMint}
\`\`\`

**💹 Market Analysis**
━━━━━━━━━━━━━━━━━━━━━━
💰 **Market Cap:** ${marketCap > 0 ? formatMarketCap(marketCap) : 'Unknown'}
💧 **Liquidity:** ${tokenData?.liquidity ? formatLiquidity(tokenData.liquidity) : 'Unknown'}
📊 **24H Volume:** ${tokenData?.volume24h ? formatVolume(tokenData.volume24h) : 'Unknown'}

**🎯 Quick Stats**
━━━━━━━━━━━━━━━━━━━━━━
📦 **Bundles:** ${trenchData.holdingBundles || '0'}/${trenchData.totalBundles || '0'}
📦 **Percentage:** ${trenchData.holdingPercentage || '0'}%
💵 **SOL Spent:** ${trenchData.totalSolSpent ? `◎${trenchData.totalSolSpent}` : 'Unknown'}
🛡️ **Security:** ${rugCheckPassed ? '✅ PASSED' : '⚠️ CAUTION'}
${sniperSection}
> 💡 *DYOR - Trade at your own risk*`,
                footer: {
                    text: `🕒 Detected at ${detectedTime} EST`,
                    icon_url: 'https://pump.fun/favicon.ico'
                },
                // Add thumbnail if token logo exists
                ...(tokenLogo ? { thumbnail: { url: tokenLogo } } : {})
            }],
            components: [
                new ActionRowBuilder<ButtonBuilder>().addComponents(...firstRowButtons),
                new ActionRowBuilder<ButtonBuilder>().addComponents(...secondRowButtons)
            ]
        };

        // Store token data with verified market cap
        if (isPumpToken && tokenData) {
            await storeTokenAlert({
                tokenAddress: tokenMint,
                tokenSymbol: tokenData?.metadata?.symbol || undefined,
                tokenName: tokenData?.metadata?.name || undefined,
                initialMarketCap: marketCap, // Use verified market cap
                initialPrice: price,
                bundlePercentage: trenchData.holdingPercentage || undefined
            });
        }

        await channel.send(message);

        metrics.total = performance.now() - metrics.start;
        console.log(`✨ Alert sent in ${metrics.total.toFixed(2)}ms for ${tokenMint}`);

    } catch (error) {
        console.error('Error in sendTokenAlert:', error);
    }
}

client.on('error', (error) => {
    console.error('Discord client error:', error);
});

client.on('messageCreate', async (message) => {
    if (message.content.toLowerCase() === '!callstats') {
        try {
            const analyzer = new CallStatsAnalyzer(message.channel as TextChannel);
            const stats = await analyzer.getStatistics();
            const embed = analyzer.createStatsEmbed(stats);
            
            await message.reply({ embeds: [embed] });
        } catch (error) {
            console.error('Error handling callstats command:', error);
            await message.reply('Error fetching call statistics. Please try again later.');
        }
    }
});

client.on('messageCreate', async (message: Message) => {
    if (message.author.bot) return;

    // Check if the message is in a DM channel
    const isDM = message.channel.type === 1; // ChannelType.DM is 1

    // Handle DMs
    if (isDM) {
        try {
            // Check if the message is a command
            if (message.content.startsWith('/')) {
                // Handle slash commands in DMs
                const command = message.content.slice(1).split(' ')[0];
                const args = message.content.slice(1).split(' ').slice(1);

                switch (command) {
                    case 'wallet':
                        if (args[0] === 'create') {
                            const name = args[1];
                            if (!name) {
                                await message.reply('Wallet name is required. Usage: /wallet create <name>');
                                return;
                            }
                            const result = await sniperooService.createWallet(message.author.id, name);
                            if (isWalletData(result)) {
                                await message.reply({
                                    content: `✅ Wallet "${name}" created successfully!\n\n` +
                                        `⚠️ **CRITICAL SECURITY WARNING**\n` +
                                        `━━━━━━━━━━━━━━━━━━━━━━\n` +
                                        `🔑 **Public Key:** \`${result.walletAddress}\`\n` +
                                        `🔐 **Private Key:** ||${result.walletPk}||\n\n` +
                                        `⚠️ **PLEASE READ CAREFULLY:**\n` +
                                        `• Never share your private key with anyone\n` +
                                        `• Store these details securely offline\n` +
                                        `• This is the ONLY time you'll see the private key\n` +
                                        `• Anyone with your private key can access your funds\n` +
                                        `• For maximum security, store these details in a secure password manager\n\n` +
                                        `💡 **Tip:** Take a screenshot or copy these details NOW!`
                                });
                            } else {
                                await message.reply({
                                    content: `❌ ${result.error}\nPlease try again or contact support if the issue persists.`
                                });
                            }
                        } else if (args[0] === 'import') {
                            const privateKey = args[1];
                            if (!privateKey) {
                                await message.reply('Private key is required. Usage: /wallet import <private_key>');
                                return;
                            }

                            const result = await sniperooService.importWallet(message.author.id, privateKey);
                            if (isWalletData(result)) {
                                await message.reply({
                                    content: `✅ Wallet imported successfully!\n\nPublic Key: \`${result.walletAddress}\``
                                });
                            } else {
                                await message.reply({
                                    content: `❌ ${result.error}\nPlease try again or contact support if the issue persists.`
                                });
                            }
                        }
                        break;

                    case 'buy':
                        const tokenAddress = args[0];
                        if (!tokenAddress) {
                            await message.reply('Token address is required. Usage: /buy <token_address>');
                            return;
                        }

                        const success = await sniperooService.buyToken(tokenAddress, message.author.id);
                        if (success) {
                            const config = await sniperooService.getUserConfig(message.author.id);
                            if (config) {
                                // Create buttons for quick actions
                                const buttons = [
                                    new ButtonBuilder()
                                        .setLabel('🌊 Pump')
                                        .setStyle(ButtonStyle.Link)
                                        .setURL(`https://pump.fun/${tokenAddress}`),
                                    new ButtonBuilder()
                                        .setLabel('👽 GMGN')
                                        .setStyle(ButtonStyle.Link)
                                        .setURL(`https://gmgn.ai/sol/token/${tokenAddress}`),
                                    new ButtonBuilder()
                                        .setLabel('🐂 BullX')
                                        .setStyle(ButtonStyle.Link)
                                        .setURL(`https://neo.bullx.io/terminal?chainId=1399811149&address=${tokenAddress}`),
                                    new ButtonBuilder()
                                        .setLabel('⭐ Photon')
                                        .setStyle(ButtonStyle.Link)
                                        .setURL(`https://photon-sol.tinyastro.io/en/r/@Strobe/${tokenAddress}`),
                                    new ButtonBuilder()
                                        .setLabel('🌌 Axiom')
                                        .setStyle(ButtonStyle.Link)
                                        .setURL(`https://axiom.trade/t/${tokenAddress}`)
                                ];

                                const secondRowButtons = [
                                    new ButtonBuilder()
                                        .setLabel('🔄 Raydium')
                                        .setStyle(ButtonStyle.Link)
                                        .setURL(`https://raydium.io/swap/?inputCurrency=sol&outputCurrency=${tokenAddress}`),
                                    new ButtonBuilder()
                                        .setLabel('🦅 Birdeye') 
                                        .setStyle(ButtonStyle.Link)
                                        .setURL(`https://birdeye.so/token/${tokenAddress}?chain=solana`),
                                    new ButtonBuilder()
                                        .setLabel('📊 DexScreener')
                                        .setStyle(ButtonStyle.Link)
                                        .setURL(`https://dexscreener.com/solana/${tokenAddress}`)
                                ];

                                await message.reply({
                                    content: `✅ Buy order placed successfully!\n\n` +
                                        `Token: \`${tokenAddress}\`\n` +
                                        `Amount: ${config.buyAmount} SOL\n` +
                                        `Auto-sell: ${config.autoSell ? 'Enabled' : 'Disabled'}\n` +
                                        `Take Profit: ${config.takeProfit}%\n` +
                                        `Stop Loss: ${config.stopLoss}%`,
                                    components: [
                                        new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons),
                                        new ActionRowBuilder<ButtonBuilder>().addComponents(...secondRowButtons)
                                    ]
                                });
                            }
                        } else {
                            await message.reply('Failed to place buy order. Please try again.');
                        }
                        break;

                    case 'sell':
                        const sellTokenAddress = args[0];
                        const percentage = parseFloat(args[1]);
                        if (!sellTokenAddress || !percentage) {
                            await message.reply('Token address and percentage are required. Usage: /sell <token_address> <percentage>');
                            return;
                        }

                        const sellSuccess = await sniperooService.sellToken(sellTokenAddress, percentage, message.author.id);
                        if (sellSuccess) {
                            await message.reply({
                                content: `✅ Sell order placed successfully!\n\nToken: \`${sellTokenAddress}\`\nPercentage: ${percentage}%`
                            });
                        } else {
                            await message.reply('Failed to place sell order. Please try again.');
                        }
                        break;

                    case 'config':
                        if (args[0] === 'view') {
                            const config = await sniperooService.getUserConfig(message.author.id);
                            if (config) {
                                await message.reply({
                                    content: `📊 Your Configuration:\n\n` +
                                        `Auto Buy: ${config.autoBuy ? '✅' : '❌'}\n` +
                                        `Auto Sell: ${config.autoSell ? '✅' : '❌'}\n` +
                                        `Take Profit: ${config.takeProfit}%\n` +
                                        `Stop Loss: ${config.stopLoss}%`
                                });
                            } else {
                                await message.reply('No configuration found. Use `/config set` to configure your settings.');
                            }
                        } else if (args[0] === 'set') {
                            const autoBuy = args[1] === 'true';
                            const amount = parseFloat(args[2]);
                            const takeProfit = parseFloat(args[3]);
                            const stopLoss = parseFloat(args[4]);
                            const autoSell = args[5] === 'true';

                            if (isNaN(amount) || isNaN(takeProfit) || isNaN(stopLoss)) {
                                await message.reply('Invalid values provided. Usage: /config set <autobuy> <amount> <takeprofit> <stoploss> <autosell>');
                                return;
                            }

                            const configUpdate: Partial<UserConfig> = {
                                userId: message.author.id,
                                autoBuy,
                                autoSell,
                                takeProfit,
                                stopLoss,
                                buyAmount: amount
                            };

                            const success = await sniperooService.updateUserConfig(message.author.id, configUpdate);
                            if (success) {
                                await message.reply({
                                    content: `✅ Configuration updated successfully!\n\n` +
                                        `Auto Buy: ${autoBuy ? '✅' : '❌'}\n` +
                                        `Auto Sell: ${autoSell ? '✅' : '❌'}\n` +
                                        `Take Profit: ${takeProfit}%\n` +
                                        `Stop Loss: ${stopLoss}%`
                                });
                            } else {
                                await message.reply('Failed to update configuration. Please try again.');
                            }
                        }
                        break;

                    default:
                        await message.reply('Unknown command. Available commands:\n' +
                            '`/wallet create` - Create a new wallet\n' +
                            '`/wallet import <private_key>` - Import an existing wallet\n' +
                            '`/buy <token_address>` - Buy a token\n' +
                            '`/sell <token_address> <percentage>` - Sell a token\n' +
                            '`/config view` - View your configuration\n' +
                            '`/config set <autobuy> <amount> <takeprofit> <stoploss> <autosell>` - Set your configuration'
                        );
                }
            }
        } catch (error) {
            console.error('Error handling DM:', error);
            await message.reply('An error occurred while processing your request.');
        }
    }
});

async function getTokenSupplyAndDecimals(mintAddress: string) {
    try {
        const mintPubkey = new PublicKey(mintAddress);
        const mintInfo = await getMint(connection, mintPubkey);
        
        return {
            totalSupply: Number(mintInfo.supply),
            decimals: mintInfo.decimals
        };
    } catch (error) {
        console.error('Error fetching token supply:', error);
        return {
            totalSupply: 1_000_000_000,
            decimals: 9
        };
    }
}

// Helper function to fetch swap data
async function fetchSwapData(tokenMint: string): Promise<any> {
    try {
        const response = await axios.get(
            `https://solana-gateway.moralis.io/token/mainnet/${tokenMint}/swaps?limit=50`,
            {
                headers: {
                    'accept': 'application/json',
                    'X-API-Key': process.env.MORALIS_API_KEY || ''
                },
                timeout: 5000
            }
        );
        
        const swaps = response.data.result || [];
        
        if (swaps.length === 0) {
            return null;
        }
        
        // Define interface for swap data
        interface SwapData {
            bought?: {
                address: string;
                usdPrice?: number;
            };
            sold?: {
                address: string;
                usdPrice?: number;
            };
            walletAddress: string;
        }
        
        // Process swap data
        let buySwaps = 0;
        let sellSwaps = 0;
        let totalSwapSize = 0;
        let largestSwap = 0;
        const uniqueWallets = new Set();
        
        swaps.forEach((swap: SwapData) => {
            // Determine if it's a buy or sell
            if (swap.bought && swap.bought.address.toLowerCase() === tokenMint.toLowerCase()) {
                buySwaps++;
            } else if (swap.sold && swap.sold.address.toLowerCase() === tokenMint.toLowerCase()) {
                sellSwaps++;
            }
            
            // Calculate swap size in USD
            const swapSize = (swap.bought?.usdPrice || 0) + (swap.sold?.usdPrice || 0);
            totalSwapSize += swapSize;
            largestSwap = Math.max(largestSwap, swapSize);
            
            // Track unique wallets
            uniqueWallets.add(swap.walletAddress);
        });
        
        return {
            recentSwaps: swaps.length,
            buySwaps,
            sellSwaps,
            buyRatio: buySwaps / (buySwaps + sellSwaps || 1),
            averageSwapSize: totalSwapSize / swaps.length,
            largestSwap,
            uniqueWallets: uniqueWallets.size
        };
    } catch (error) {
        console.error('Error fetching swap data:', error);
        return null;
    }
}

export async function handleAICommand(message: any, tokenMint: string) {
    try {
        console.log('🤖 Fetching AI analysis for:', tokenMint);
        
        // Send initial loading message with degen humor
        const loadingEmbed = {
            color: 0x9933FF, // Purple for loading
            title: '🤖 STROBE AI - ANALYZING TOKEN',
            description: `
⚡ **Scanning ${tokenMint.slice(0, 6)}...${tokenMint.slice(-4)}** ⚡

*Checking if this is the next 100x or just another Solana rug...*

${['Counting paper hands...', 'Measuring degen energy...', 'Calculating ape index...', 'Scanning for exit liquidity...', 'Looking for diamond hands...'][Math.floor(Math.random() * 5)]}

*Please wait while I analyze this potentially life-changing opportunity (or total dumpster fire)*
            `,
            footer: {
                text: "Powered by Strobe AI - The degen's best friend",
                icon_url: 'https://pump.fun/favicon.ico'
            }
        };
        
        const initialResponse = await message.reply({ embeds: [loadingEmbed] });
        
        // Wait for 2 seconds for dramatic effect
        await new Promise(resolve => setTimeout(resolve, 2000));
        const priceHistory = await getTokenPriceHistory(tokenMint);
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Fetch all data in parallel
        const [
            tokenData, 
            trenchData, 
            isBonded, 
            rugCheckPassed, 
            volumeLiquidity,
            sniperDataResult,
            swapDataResult,
            latestPrice
        ] = await Promise.all([
            fetchTokenData(tokenMint),
            fetchTrenchData(tokenMint),
            checkBondingCurveStatus(tokenMint),
            getRugCheckConfirmed(tokenMint),
            getTokenVolumeAndLiquidity(tokenMint),
            fetchSniperData(tokenMint),
            fetchSwapData(tokenMint),
            fetchLatestPrice(tokenMint)
        ]);

        const { totalSupply, decimals } = await getTokenSupplyAndDecimals(tokenMint);
        
        // Use latest price if available
        const currentPrice = latestPrice > 0 ? latestPrice : 0;
        
        // Calculate market cap with latest price
        const marketCap = currentPrice * totalSupply;
        
        // Format market cap without 'M' suffix
        const formattedMarketCap = formatMarketCapValue(marketCap);
        
        // Convert sniperData to the expected format or undefined if null
        const sniperData = sniperDataResult ? {
            totalSnipers: sniperDataResult.totalSnipers,
            profitableSnipers: sniperDataResult.profitableSnipers,
            profitablePercentage: sniperDataResult.profitablePercentage,
            averageProfitPercentage: sniperDataResult.averageProfitPercentage,
            totalSnipedUsd: sniperDataResult.totalSnipedUsd,
            totalSoldUsd: sniperDataResult.totalSoldUsd,
            totalProfitUsd: sniperDataResult.totalProfitUsd,
            quickestSellBlocksAfter: sniperDataResult.quickestSellBlocksAfter
        } : undefined;
        
        // Convert swapData to the expected format or undefined if null
        const swapData = swapDataResult ? {
            recentSwaps: swapDataResult.recentSwaps,
            buySwaps: swapDataResult.buySwaps,
            sellSwaps: swapDataResult.sellSwaps,
            buyRatio: swapDataResult.buyRatio,
            averageSwapSize: swapDataResult.averageSwapSize,
            largestSwap: swapDataResult.largestSwap,
            uniqueWallets: swapDataResult.uniqueWallets
        } : undefined;
        
        const analysisData: TokenAnalysisData = {
            tokenMint,
            ticker: trenchData.ticker?.toUpperCase() || tokenMint.slice(0, 4),
            marketCap: formattedMarketCap,
            currentPrice,
            initialPrice: priceHistory.items[0]?.value || 0,
            liquidity: volumeLiquidity.liquidity || '0',
            volume24h: volumeLiquidity.volume24h || '0',
            totalBundles: trenchData.totalBundles || 0,
            holdingBundles: trenchData.holdingBundles || 0,
            totalSolSpent: trenchData.totalSolSpent?.toString() || '0',
            holdingPercentage: trenchData.holdingPercentage?.toString() || '0',
            isBonded,
            rugCheckPassed,
            priceHistory: priceHistory.items || [],
            totalSupply,
            decimals,
            priceChangePercentage24h: tokenData && 'priceChangePercentage24h' in tokenData ? (tokenData.priceChangePercentage24h as number) : 0,
            sniperData,
            swapData
        };

        // Update with "analyzing" message
        await initialResponse.edit({
            embeds: [{
                color: 0xFFA500, // Orange for processing
                title: '🧠 STROBE AI - DEEP ANALYSIS IN PROGRESS',
                description: `
**Analyzing ${trenchData.ticker || tokenMint.slice(0, 6)}...**

💰 Market Cap: ${formattedMarketCap}
💧 Liquidity: ${formatNumber(volumeLiquidity.liquidity || 'Unknown')}
🔒 Security: ${rugCheckPassed ? '✅ PASSED' : '⚠️ FAILED'}

*Crunching numbers and consulting with the degen gods...*
*${Math.floor(Math.random() * 69) + 42}% complete...*
                `,
                footer: {
                    text: `Analysis for ${tokenMint}`,
                    icon_url: 'https://pump.fun/favicon.ico'
                }
            }]
        });

        // Get Grok analysis
        const analysis = await analyzeTokenWithGrok(analysisData);
        
        // Check if this is a dead token analysis
        const isDeadToken = analysis.includes('DEAD TOKEN ALERT');
        
        // Format the analysis sections with better styling
        let formattedAnalysis = '';
        
        if (isDeadToken) {
            // For dead tokens, just show the dead token alert and summary
            const deadTokenAlert = analysis.split('DEAD TOKEN ALERT')[1].split('ANALYSIS_SUMMARY')[0].trim();
            const analysisSummary = analysis.split('ANALYSIS_SUMMARY')[1].trim();
            
            // Add some degen humor for dead tokens
            const deadTokenMemes = [
                "Even my ex-girlfriend didn't dump this hard 📉",
                "This token is so dead, it's getting rejected at the cemetery 💀",
                "Congratulations! You found the exit liquidity 🎉",
                "Not even CPR can save this one 🚑",
                "This chart looks like my dating life - all downhill 📉"
            ];
            
            const randomMeme = deadTokenMemes[Math.floor(Math.random() * deadTokenMemes.length)];
            
            formattedAnalysis = `**Token Data:**
${trenchData.ticker} (${tokenMint})
💰 **Market Cap:** ${formattedMarketCap}
💧 **Liquidity:** ${formatNumber(volumeLiquidity.liquidity || 'Unknown')}
👨‍💻 **Dev Stats:** ${trenchData.holdingBundles}/${trenchData.totalBundles} bundles, ${formatNumber(trenchData.totalSolSpent)} SOL spent
🔒 **Security:** ${rugCheckPassed ? 'PASSED' : 'FAILED'}, Bonded: ${isBonded ? 'Yes' : 'No'}

**💀 DEAD TOKEN ALERT**
\`\`\`
${deadTokenAlert}

${randomMeme}
\`\`\`

**🧟 ANALYSIS_SUMMARY**
\`\`\`
${analysisSummary}
\`\`\`

> *"Sir, this is a Wendy's. We don't serve dead tokens here."*`;
        } else {
            // For active tokens, format all sections
            const marketCapLevels = analysis.split('MARKET_CAP_LEVELS')[1].split('FIBONACCI_LEVELS')[0].trim();
            const fibonacciLevels = analysis.split('FIBONACCI_LEVELS')[1].split('SNIPER_ACTIVITY')[0].trim();
            const sniperActivity = analysis.split('SNIPER_ACTIVITY')[1].split('SWAP_ACTIVITY')[0].trim();
            const swapActivity = analysis.split('SWAP_ACTIVITY')[1].split('SOCIAL_POSTS')[0].trim();
            const socialPosts = analysis.split('SOCIAL_POSTS')[1].split('ANALYSIS_SUMMARY')[0].trim();
            const analysisSummary = analysis.split('ANALYSIS_SUMMARY')[1].trim();
            
            // Add some degen humor for active tokens
            const activeTokenMemes = [
                "Not financial advice, but my hamster says buy 🐹",
                "Wen lambo? Perhaps soon, perhaps never 🏎️",
                "Remember: 1 SOL = 1 SOL, but this token = pure degen energy ⚡",
                "My technical analysis: line go up = good, line go down = bad 📊",
                "This is either going to 100x or 0. No in-between. This is the way 🚀"
            ];
            
            const randomMeme = activeTokenMemes[Math.floor(Math.random() * activeTokenMemes.length)];
            
            formattedAnalysis = `**Token Data:**
${trenchData.ticker} (${tokenMint})
💰 **Market Cap:** ${formattedMarketCap}
💧 **Liquidity:** ${formatNumber(volumeLiquidity.liquidity || 'Unknown')}
👨‍💻 **Dev Stats:** ${trenchData.holdingBundles}/${trenchData.totalBundles} bundles, ${formatNumber(trenchData.totalSolSpent)} SOL spent
🔒 **Security:** ${rugCheckPassed ? '✅ PASSED' : '⚠️ FAILED'}, Bonded: ${isBonded ? 'Yes' : 'No'}

**📈 MARKET_CAP_LEVELS**
\`\`\`
${marketCapLevels}
\`\`\`

**📐 FIBONACCI_LEVELS**
\`\`\`
${fibonacciLevels}
\`\`\`

**🤖 SNIPER_ACTIVITY**
\`\`\`
${sniperActivity}
\`\`\`

**💱 SWAP_ACTIVITY**
\`\`\`
${swapActivity}
\`\`\`

**🐦 SOCIAL_POSTS**
\`\`\`
${socialPosts}
\`\`\`

**📊 ANALYSIS_SUMMARY**
\`\`\`
${analysisSummary}
\`\`\`

> *${randomMeme}*`;
        }
        
        // Create buttons for quick actions
        const buttons = [
            new ButtonBuilder()
                .setLabel('Trade on Jupiter')
                .setStyle(ButtonStyle.Link)
                .setURL(`https://jup.ag/swap/SOL-${tokenMint}`)
                .setEmoji('🪐'),
            new ButtonBuilder()
                .setLabel('View on Birdeye')
                .setStyle(ButtonStyle.Link)
                .setURL(`https://birdeye.so/token/${tokenMint}?chain=solana`)
                .setEmoji('👁️'),
            new ButtonBuilder()
                .setLabel('View on Solscan')
                .setStyle(ButtonStyle.Link)
                .setURL(`https://solscan.io/token/${tokenMint}`)
                .setEmoji('🔍')
        ];
        
        // Update the message with the full analysis
        await initialResponse.edit({
            embeds: [{
                color: isDeadToken ? 0xff0000 : 0x2ecc71, // Red for dead tokens, green for active
                title: isDeadToken ? '💀 STROBE AI ANALYSIS - DEAD TOKEN' : '🤖 STROBE AI ANALYSIS',
                description: formattedAnalysis,
                footer: {
                    text: `Analysis by Strobe AI - The degen's best friend | ${getEasternTime()} EST`,
                    icon_url: 'https://pump.fun/favicon.ico'
                }
            }],
            components: [
                new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)
            ]
        });

    } catch (error) {
        console.error('Error in AI analysis:', error);
        await message.reply({
            embeds: [{
                color: 0xFF0000,
                title: '❌ ANALYSIS FAILED',
                description: `
Failed to analyze token: ${tokenMint}

*Even AI has its limits when dealing with Solana tokens...*
*Try again later or find a different degen play!*
                `,
                footer: {
                    text: 'Error: ' + (error instanceof Error ? error.message : String(error)),
                    icon_url: 'https://pump.fun/favicon.ico'
                }
            }]
        });
    }
}

// Helper function to format market cap with commas and no suffixes
function formatMarketCapValue(marketCap: number): string {
    return `$${marketCap.toLocaleString('en-US', {maximumFractionDigits: 2})}`;
}

client.login(process.env.DISCORD_BOT_TOKEN)
    .then(() => console.log('🔓 Bot logged in successfully'))
    .catch(error => console.error('❌ Failed to log in:', error)); 

