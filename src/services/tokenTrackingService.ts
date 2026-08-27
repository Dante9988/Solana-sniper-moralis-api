import { PrismaClient, TokenAlert } from '@prisma/client';
import { getTokenMarketData } from './tokenDataService';
import { Client, TextChannel, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import axios from 'axios';
import { getMoralisPrice, getMoralisSwaps } from './moralisClient';
import path from 'path';
import { createCanvas, loadImage } from 'canvas';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();
const PUMPFUN_TOTAL_SUPPLY = 1_000_000_000; // 1 billion tokens
const BACKGROUND_IMAGE = './src/services/purple.png';

interface TokenAlertData {
  tokenAddress: string;
  tokenSymbol?: string;
  tokenName?: string;
  initialMarketCap: number;
  initialPrice: number;
  bundlePercentage?: number;
}

interface SwapData {
  exchangeName: string;
  bought?: {
    address: string;
    usdPrice: number;
    amount: string;
    usdAmount: number;
  };
  sold?: {
    address: string;
    usdPrice: number;
    amount: string;
    usdAmount: number;
  };
  blockTimestamp: string;
}

interface DailyProfitSummary {
  totalProfitUSD: number;
  totalLossUSD: number;
  netProfitUSD: number;
  profitableTrades: number;
  lossTrades: number;
  totalTrades: number;
  averagePnL: number;
  winRate: number;
}

async function getHighestMarketCap(tokenAddress: string): Promise<{ 
  highestMarketCap: number; 
  timestamp: string | null;
  price: number;
}> {
  try {
    let allSwaps: SwapData[] = [];
    let nextCursor: string | undefined = undefined;
    const limit = 100; // Moralis API limit
    let foundMigrationPoint = false;
    
    // Keep fetching pages until we find migration point
    while (!foundMigrationPoint) {
      const response = await getMoralisSwaps(tokenAddress, limit, nextCursor);
      if (response.status === 'UNAVAILABLE') break;

      if (!response.data.result || response.data.result.length === 0) {
        console.log('No more swaps found');
        break;
      }

      const swaps = response.data.result as unknown as SwapData[];
      
      // Find the last (oldest) Pump.fun swap in this batch
      let lastPumpFunIndex = -1;
      for (let index = swaps.length - 1; index >= 0; index -= 1) {
        if (swaps[index].exchangeName === 'Pump.Fun') { lastPumpFunIndex = index; break; }
      }
      
      if (lastPumpFunIndex !== -1) {
        console.log('Found last Pump.fun swap in this batch - collecting newer Raydium swaps');
        // Collect all Raydium swaps that came after (are newer than) this Pump.fun swap
        const newerSwaps = swaps.slice(0, lastPumpFunIndex);
        const raydiumSwaps = newerSwaps.filter((s: SwapData) => s.exchangeName === 'Raydium');
        allSwaps.push(...raydiumSwaps);
        foundMigrationPoint = true;
        break;
      } else {
        // If no Pump.fun swap found in this batch, collect any Raydium swaps
        // (we might still find older Pump.fun swaps in next pages)
        const raydiumSwaps = swaps.filter((s: SwapData) => s.exchangeName === 'Raydium');
        allSwaps.push(...raydiumSwaps);
      }

      // Get cursor for next page if needed
      nextCursor = response.data.cursor ?? undefined;
      
      // Stop if we found migration point or no more pages
      if (foundMigrationPoint || !nextCursor) {
        break;
      }
    }

    if (allSwaps.length === 0) {
      console.log(`No post-migration Raydium swaps found for ${tokenAddress}`);
      return { highestMarketCap: 0, timestamp: null, price: 0 };
    }

    let highestMarketCap = 0;
    let highestPrice = 0;
    let highestPriceTimestamp = null;

    allSwaps.forEach((swap: SwapData) => {
      // For buy transactions
      if (swap.bought?.address === tokenAddress && swap.sold?.usdAmount && swap.bought?.amount) {
        const price = swap.sold.usdAmount / parseFloat(swap.bought.amount);
        const marketCap = price * PUMPFUN_TOTAL_SUPPLY;
        
        if (marketCap > highestMarketCap) {
          highestMarketCap = marketCap;
          highestPrice = price;
          highestPriceTimestamp = swap.blockTimestamp;
        }
      }
      
      // For sell transactions
      if (swap.sold?.address === tokenAddress && swap.bought?.usdAmount && swap.sold?.amount) {
        const price = swap.bought.usdAmount / parseFloat(swap.sold.amount);
        const marketCap = price * PUMPFUN_TOTAL_SUPPLY;
        
        if (marketCap > highestMarketCap) {
          highestMarketCap = marketCap;
          highestPrice = price;
          highestPriceTimestamp = swap.blockTimestamp;
        }
      }
    });

    console.log(`
    🔍 Historical Market Cap Analysis for ${tokenAddress} (Post-migration Raydium only):
    • Found Migration Point: ${foundMigrationPoint}
    • Total Post-migration Raydium Swaps: ${allSwaps.length}
    • Highest Token Price: $${highestPrice}
    • Highest Market Cap: $${highestMarketCap.toLocaleString()}
    • Timestamp: ${highestPriceTimestamp}
    `);
    
    return { 
      highestMarketCap, 
      timestamp: highestPriceTimestamp,
      price: highestPrice
    };
  } catch (error) {
    console.error('Error fetching historical swap data:', error);
    return { highestMarketCap: 0, timestamp: null, price: 0 };
  }
}

export async function storeTokenAlert(data: TokenAlertData) {
  try {
    const newToken = await prisma.tokenAlert.create({
      data: {
        tokenAddress: data.tokenAddress,
        tokenSymbol: data.tokenSymbol,
        tokenName: data.tokenName,
        initialMarketCap: data.initialMarketCap,
        initialPrice: data.initialPrice,
        bundlePercentage: data.bundlePercentage || 0,
        alertTimestamp: new Date(),
        pnlAlerted: false,
        checked: false
      }
    });
    
    console.log(`
    ✅ Stored new token alert:
    • Address: ${newToken.tokenAddress}
    • Symbol: ${newToken.tokenSymbol}
    • Initial MC: $${newToken.initialMarketCap}
    • Timestamp: ${newToken.alertTimestamp}
    • PnL Alerted: ${newToken.pnlAlerted}
    • Checked: ${newToken.checked}
    `);
  } catch (error) {
    console.error('Error storing token alert:', error);
  }
}

async function checkTokenPriceHistory(token: TokenAlert): Promise<{ 
  highestPrice: number;
  highestMarketCap: number;
  timestamp: number | null;
}> {
  try {
    const timeFrom = Math.floor(token.alertTimestamp.getTime() / 1000); // Convert to unix timestamp
    const timeTo = 10000000000; // Maximum timestamp as specified in the API example

    const response = await axios.get(
      `https://public-api.birdeye.so/defi/history_price?address=${token.tokenAddress}&address_type=token&type=1m&time_from=${timeFrom}&time_to=${timeTo}`,
      {
        headers: {
          'X-API-KEY': process.env.BIRDEYE_API_KEY || '',
          'accept': 'application/json',
          'x-chain': 'solana'
        },
        timeout: 10000
      }
    );

    if (!response.data?.success || !response.data?.data?.items?.length) {
      console.log(`No price history found for ${token.tokenAddress}`);
      return { highestPrice: 0, highestMarketCap: 0, timestamp: null };
    }

    // Find highest price from history
    const priceHistory = response.data.data.items;
    let highestPrice = 0;
    let highestTimestamp = null;

    priceHistory.forEach((item: { unixTime: number; value: number }) => {
      if (item.value > highestPrice) {
        highestPrice = item.value;
        highestTimestamp = item.unixTime;
      }
    });

    const highestMarketCap = highestPrice * PUMPFUN_TOTAL_SUPPLY;

    console.log(`
    🔍 Price History Analysis for ${token.tokenAddress}:
    • Initial Price: $${token.initialPrice}
    • Highest Price: $${highestPrice}
    • Initial MC: $${token.initialMarketCap.toLocaleString()}
    • Highest MC: $${highestMarketCap.toLocaleString()}
    • Timestamp: ${new Date(highestTimestamp! * 1000).toISOString()}
    `);

    return { 
      highestPrice,
      highestMarketCap,
      timestamp: highestTimestamp
    };

  } catch (error) {
    console.error('Error fetching price history:', error);
    return { highestPrice: 0, highestMarketCap: 0, timestamp: null };
  }
}

export async function checkTokenPnL(discordClient: Client) {
  try {
    const eightHoursAgo = new Date(Date.now() - 8 * 60 * 60 * 1000);
    
    // First, let's check how many total tokens we have in DB
    const totalTokens = await prisma.tokenAlert.count();
    console.log(`Total tokens in DB: ${totalTokens}`);

    // Check how many tokens are within 8 hours
    const tokensWithinTimeWindow = await prisma.tokenAlert.count({
      where: {
        alertTimestamp: {
          gte: eightHoursAgo,
          lte: new Date()
        }
      }
    });
    console.log(`Tokens within 8 hour window: ${tokensWithinTimeWindow}`);

    // Now get tokens that haven't been PnL alerted
    const tokens = await prisma.tokenAlert.findMany({
      where: {
        pnlAlerted: false,
        alertTimestamp: {
          gte: eightHoursAgo,
          lte: new Date()
        }
      },
      orderBy: {
        alertTimestamp: 'asc'
      }
    });

    console.log(`
    🔍 Database Query Details:
    • Time Window: ${eightHoursAgo.toISOString()} to ${new Date().toISOString()}
    • Total Tokens in DB: ${totalTokens}
    • Tokens Within Time Window: ${tokensWithinTimeWindow}
    • Tokens to Check PnL: ${tokens.length}
    `);

    // If we have no tokens, let's check why
    if (tokens.length === 0) {
      // Check if all tokens are already alerted
      const allAlertedCount = await prisma.tokenAlert.count({
        where: {
          pnlAlerted: true,
          alertTimestamp: {
            gte: eightHoursAgo,
            lte: new Date()
          }
        }
      });
      
      console.log(`
      ⚠️ No tokens to check because:
      • Already PnL Alerted: ${allAlertedCount}
      • Outside Time Window: ${totalTokens - tokensWithinTimeWindow}
      `);
    }

    // Import Telegram bot functions
    const { telegramBot } = await import('../telegram/telegramBot');
    
    for (const token of tokens) {
      try {
        // Get highest price from Birdeye history
        const priceData = await checkTokenPriceHistory(token);
        
        if (priceData.highestMarketCap === 0) {
          console.log(`No price data found for ${token.tokenAddress}`);
          continue;
        }

        // Calculate PnL percentage based on market caps
        const pnlPercentage = ((priceData.highestMarketCap - token.initialMarketCap) / token.initialMarketCap) * 100;

        // Log for debugging
        console.log(`
        Token Check Details:
        • Address: ${token.tokenAddress}
        • Age: ${Math.round((Date.now() - token.alertTimestamp.getTime()) / (60 * 1000))} minutes
        • Initial MC: $${token.initialMarketCap.toLocaleString()}
        • Highest MC: $${priceData.highestMarketCap.toLocaleString()}
        • PnL: ${pnlPercentage.toFixed(2)}%
        `);

        // Update token data regardless of PnL percentage
        await prisma.tokenAlert.update({
          where: { id: token.id },
          data: {
            checked: true,
            currentMarketCap: priceData.highestMarketCap,
            currentPrice: priceData.highestPrice,
            pnlPercentage,
            checkTimestamp: new Date()
          }
        });

        // If PnL is >= 50%, send alerts
        if (pnlPercentage >= 50) {
          console.log(`PnL is ${pnlPercentage.toFixed(2)}% - sending alerts to Discord and Telegram`);
          
          // Calculate profit in SOL (same for both Discord and Telegram)
          const initialSolInvestment = 1.000;
          const returnedSol = initialSolInvestment + (initialSolInvestment * (pnlPercentage / 100));
          const solPrice = await getSolPrice();
          const profitUsd = (returnedSol - initialSolInvestment) * solPrice;
          
          // Create PnL data object
          const pnlData = {
            ...token,
            currentMarketCap: priceData.highestMarketCap,
            highestPriceTimestamp: priceData.timestamp ? new Date(priceData.timestamp * 1000).toISOString() : null,
            pnlPercentage
          };
          
          // Generate the PnL image once for both platforms
          const customImage = await createPnLImage({
            pnlPercentage: pnlPercentage,
            tokenSymbol: token.tokenSymbol || 'TOKEN',
            initialMarketCap: token.initialMarketCap,
            currentMarketCap: priceData.highestMarketCap,
            initialSol: initialSolInvestment,
            returnedSol
          });
          
          // Send Discord alert
          await sendPnLAlert(discordClient, pnlData, customImage);
          
          // Send Telegram alert using the same PnL image
          try {
            console.log(`Sending PnL alert to Telegram for ${token.tokenAddress}`);
            
            // Check if telegramBot is available
            if (telegramBot) {
              // Get channel config from Telegram
              const { getChannelConfig } = await import('../telegram/commands/toggleChannel');
              const channelConfig = getChannelConfig();
              
              if (channelConfig.channelId && channelConfig.enabled) {
                // Send PnL image to Telegram using the dedicated method
                await telegramBot.sendPnLAlertWithImage(
                  channelConfig.channelId,
                  token.tokenAddress,
                  token.tokenSymbol || 'TOKEN',
                  pnlPercentage,
                  customImage
                );
                console.log(`Successfully sent PnL alert to Telegram channel for ${token.tokenAddress}`);
              } else {
                console.log(`Telegram channel not enabled or configured, skipping PnL alert`);
              }
            } else {
              console.log(`Telegram bot not available`);
            }
          } catch (telegramError) {
            console.error(`Error sending PnL alert to Telegram:`, telegramError);
          }

          // Mark as PnL alerted
          await prisma.tokenAlert.update({
            where: { id: token.id },
            data: { pnlAlerted: true }
          });
        }
      } catch (error) {
        console.error(`Error processing PnL for ${token.tokenAddress}:`, error);
      }
    }
  } catch (error) {
    console.error('Error in checkTokenPnL:', error);
  }
}

/**
 * Get the current price of SOL in USD
 */
async function getSolPrice(): Promise<number> {
  try {
    const response = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
      { timeout: 5000 }
    );
    
    if (response.data && response.data.solana && response.data.solana.usd) {
      console.log(`Current SOL price: $${response.data.solana.usd}`);
      return response.data.solana.usd;
    console.log('Attempting to fetch SOL price...');
    const response = await getMoralisPrice('So11111111111111111111111111111111111111112');

    if (response.status === 'AVAILABLE' && response.data.usdPrice) {
      console.log(`SOL price fetched successfully: $${response.data.usdPrice}`);
      return response.data.usdPrice;
    }
    
    // Fallback to a reasonable default if API fails
    console.warn('Could not get SOL price from CoinGecko, using fallback price');
    return 170; // Default fallback price
  } catch (error) {
    console.error('Error fetching SOL price:', error);
    return 170; // Default fallback price
  }
}

async function createPnLImage(data: {
  pnlPercentage: number;
  tokenSymbol: string;
  initialMarketCap: number;
  currentMarketCap: number;
  initialSol: number;
  returnedSol: number;
}): Promise<Buffer> {
  try {
    console.log('Creating PnL Image with data:', {
        pnlPercentage: data.pnlPercentage,
        tokenSymbol: data.tokenSymbol,
        initialMarketCap: data.initialMarketCap,
        currentMarketCap: data.currentMarketCap,
        initialSol: data.initialSol,
        returnedSol: data.returnedSol
    });

    const canvas = createCanvas(1200, 675);
    const ctx = canvas.getContext('2d');

    // Create dark purple-black background gradient - fullscreen
    const baseGradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    baseGradient.addColorStop(0, '#1a0b2e');
    baseGradient.addColorStop(1, '#0d0517');
    ctx.fillStyle = baseGradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw diamond pattern overlay for subtle texture
    ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
    const gridSize = 30;
    for (let i = 0; i < canvas.width; i += gridSize) {
      for (let j = 0; j < canvas.height; j += gridSize) {
        // Create a diamond pattern
        ctx.beginPath();
        ctx.moveTo(i, j - gridSize/2);
        ctx.lineTo(i + gridSize/2, j);
        ctx.lineTo(i, j + gridSize/2);
        ctx.lineTo(i - gridSize/2, j);
        ctx.closePath();
        ctx.fill();
      }
    }

    // Add subtle glow effect
    const glowGradient = ctx.createRadialGradient(
      canvas.width * 0.3, canvas.height * 0.4, 0,
      canvas.width * 0.3, canvas.height * 0.4, 600
    );
    glowGradient.addColorStop(0, 'rgba(145, 70, 255, 0.15)');
    glowGradient.addColorStop(1, 'rgba(25, 10, 45, 0)');
    ctx.fillStyle = glowGradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Left margin for all text elements
    const leftMargin = 120;

    // Draw token symbol - left aligned instead of centered
    ctx.font = 'bold 70px Arial';
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('$' + data.tokenSymbol, leftMargin, 120);
    
    // Draw "CURRENT PROFIT" label - left aligned
    ctx.font = '24px Arial';
    ctx.fillStyle = '#9B9B9B';
    ctx.fillText('CURRENT PROFIT', leftMargin, 220);
    
    // Calculate profit value and format it
    const profitAmount = (data.returnedSol - data.initialSol) * await getSolPrice();
    const formattedProfit = profitAmount >= 0 
      ? `$${Math.abs(Math.round(profitAmount))}` 
      : `$-${Math.abs(Math.round(profitAmount))}`;
    
    // Draw profit amount - larger and left aligned
    // Use green for positive, red for negative
    ctx.font = 'bold 100px Arial'; // Bigger font size
    ctx.fillStyle = profitAmount >= 0 ? '#4CAF50' : '#F44336';
    ctx.fillText(formattedProfit, leftMargin, 250);
    
    // Draw PNL percentage - left aligned
    ctx.font = 'bold 40px Arial'; // Slightly bigger
    ctx.fillStyle = profitAmount >= 0 ? '#4CAF50' : '#F44336';
    ctx.fillText(`+${data.pnlPercentage.toFixed(2)}%`, leftMargin, 360);
    
    // Create section for bought/hold/sold values - spaced horizontally
    const columnWidth = 300; // Width between columns
    const labelY = 450;
    const valueY = 490;
    
    // TOTAL BOUGHT - left aligned
    ctx.font = '22px Arial';
    ctx.fillStyle = '#9B9B9B';
    ctx.fillText('TOTAL BOUGHT', leftMargin, labelY);
    ctx.font = 'bold 32px Arial';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(`${data.initialSol.toFixed(1)} SOL`, leftMargin, valueY);
    
    // TOTAL HOLD - in the middle
    ctx.font = '22px Arial';
    ctx.fillStyle = '#9B9B9B';
    ctx.fillText('TOTAL HOLD', leftMargin + columnWidth, labelY);
    ctx.font = 'bold 32px Arial';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText('0 SOL', leftMargin + columnWidth, valueY);
    
    // TOTAL SOLD - on the right
    ctx.font = '22px Arial';
    ctx.fillStyle = '#9B9B9B';
    ctx.fillText('TOTAL SOLD', leftMargin + 2*columnWidth, labelY);
    ctx.font = 'bold 32px Arial';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(`${data.returnedSol.toFixed(1)} SOL`, leftMargin + 2*columnWidth, valueY);
    
    // Draw "Powered by Moralis" text at bottom left
    ctx.font = '20px Arial';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.fillText('Powered by Moralis', leftMargin, canvas.height - 60);
    
    // Draw STROBE branding in bottom right
    ctx.textAlign = 'right';
    ctx.font = 'bold 40px Arial';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText('STROBE', canvas.width - 80, canvas.height - 60);
    
    // Reset text alignment for future drawing operations
    ctx.textAlign = 'left';
    
    // Convert canvas to buffer
    return canvas.toBuffer('image/png');
  } catch (error) {
    console.error('Error creating PnL image:', error);
    throw error;
  }
}

async function sendPnLAlert(discordClient: Client, data: any, customImage: Buffer) {
  try {
    const channel = discordClient.channels.cache.get(
      process.env.PNL_DISCORD_CHANNEL_ID!
    ) as TextChannel;

    if (!channel) {
      console.error('PnL channel not found!');
      return;
    }

    const initialSolInvestment = 1.000;
    const returnedSol = initialSolInvestment + (initialSolInvestment * (data.pnlPercentage / 100));

    console.log('PnL Alert Input Data:', {
        pnlPercentage: data.pnlPercentage,
        tokenSymbol: data.tokenSymbol,
        initialMarketCap: data.initialMarketCap,
        currentMarketCap: data.currentMarketCap,
        initialSol: initialSolInvestment,
        returnedSol,
        tokenAddress: data.tokenAddress
    });

    const embed = new EmbedBuilder()
      .setColor('#9B59B6')
      .setImage('attachment://pnl-background.png')
      .setDescription(`🔗 Contract: ${data.tokenAddress}`)
      .setFooter({ 
        text: `Powered by Moralis` 
      });

    const row = new ActionRowBuilder<ButtonBuilder>()
      .addComponents(
        new ButtonBuilder()
          .setLabel('View on Birdeye')
          .setStyle(ButtonStyle.Link)
          .setURL(`https://birdeye.so/token/${data.tokenAddress}?chain=solana`)
      );

    await channel.send({ 
      files: [{
        attachment: customImage,
        name: 'pnl-background.png'
      }],
      embeds: [embed],
      components: [row]
    });

    // Log details for verification
    console.log(`
    ✅ PnL Alert Details for ${data.tokenAddress}:
    • Initial Market Cap: $${data.initialMarketCap.toLocaleString()}
    • Peak Market Cap: $${data.currentMarketCap.toLocaleString()}
    • PnL %: ${data.pnlPercentage.toFixed(2)}%
    • Initial Investment: ${initialSolInvestment} SOL
    • Returned Amount: ${returnedSol.toFixed(3)} SOL
    `);

  } catch (error) {
    console.error('Error sending PnL alert:', error);
  }
}

// Add this new function to manually trigger daily summary
export async function triggerDailySummary(discordClient: Client) {
  console.log('🔄 Manually triggering daily profit summary and top calls report...');
  try {
    // Send daily summary
    await sendDailySummaryAlert(discordClient);
    console.log('✅ Daily summary sent successfully');
    
    // Also send top calls report together with summary
    try {
      const { generateCustomTimeRangeReport } = await import('./dailyTopTokensService');
      const { telegramBot } = await import('../telegram/telegramBot');
      
      console.log('🏆 Now sending top calls report...');
      await generateCustomTimeRangeReport(discordClient, telegramBot);
      console.log('✅ Top calls report sent successfully');
    } catch (topCallsError) {
      console.error('❌ Failed to send top calls report:', topCallsError);
    }
  } catch (error) {
    console.error('❌ Failed to send daily summary:', error);
  }
}

export function startPeriodicChecks(discordClient: Client) {
  // Run PnL checks every 15 minutes
  setInterval(async () => {
    try {
      console.log('🔄 Running PnL checks...');
      await checkTokenPnL(discordClient);
    } catch (error) {
      console.error('Error in periodic PnL check:', error);
    }
  }, 15 * 60 * 1000);

  // Check for daily summary and top calls at 12:00:00 AM EST
  setInterval(async () => {
    try {
      const now = new Date();
      const estTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
      
      // Check if it's 12:00:00 AM EST (midnight)
      if (estTime.getHours() === 0 && estTime.getMinutes() === 0 && estTime.getSeconds() === 0) {
        console.log('🕒 Time to post daily summary and top calls report!');
        
        // Import the necessary functions
        const { generateCustomTimeRangeReport } = await import('./dailyTopTokensService');
        const { telegramBot } = await import('../telegram/telegramBot');
        
        // Run both reports together
        console.log('📊 Running daily profit summary...');
        await sendDailySummaryAlert(discordClient);
        
        console.log('🏆 Running top calls report...');
        await generateCustomTimeRangeReport(discordClient, telegramBot);
      }
    } catch (error) {
      console.error('Error in daily summary and top calls check:', error);
    }
  }, 1000); // Check every second for more precise timing

  console.log(`
  🔄 Started periodic checks:
  • PnL checks: Every 15 minutes
  • Daily summary + Top calls: Every day at 12:00:00 AM EST
  • Current EST time: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}
  `);
}

async function calculateDailyProfits(): Promise<DailyProfitSummary> {
  try {
    // Get current EST time
    const now = new Date();
    const estTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    
    // Calculate start of current day in EST (00:00:00.000)
    const startOfDayEST = new Date(estTime);
    startOfDayEST.setHours(0, 0, 0, 0);
    
    // Calculate end of current day in EST (23:59:59.999)
    const endOfDayEST = new Date(estTime);
    endOfDayEST.setHours(23, 59, 59, 999);

    console.log(`
    🕒 Calculating profits for current EST day:
    • Current UTC time: ${now.toISOString()}
    • Current EST time: ${estTime.toISOString()}
    • Start of day EST: ${startOfDayEST.toISOString()}
    • End of day EST: ${endOfDayEST.toISOString()}
    • Your local time: ${now.toLocaleString()}
    `);

    // Get all tokens that were alerted today in EST
    const tokens = await prisma.tokenAlert.findMany({
      where: {
        checked: true,
        currentMarketCap: { not: null },
        pnlPercentage: { not: null },
        alertTimestamp: {
          gte: startOfDayEST,
          lte: endOfDayEST
        }
      },
      orderBy: {
        alertTimestamp: 'asc'
      }
    });

    console.log(`Found ${tokens.length} tokens alerted today for calculation`);

    let totalProfitUSD = 0;
    let totalLossUSD = 0;
    let profitableTrades = 0;
    let lossTrades = 0;
    const solPrice = await getSolPrice();
    const initialInvestment = 1.000; // 1 SOL per trade

    for (const token of tokens) {
      if (!token.pnlPercentage) continue;

      const returnedSol = initialInvestment + (initialInvestment * (token.pnlPercentage / 100));
      const profitUSD = (returnedSol - initialInvestment) * solPrice;

      console.log(`
      Token ${token.tokenAddress}:
      • Alert Time (EST): ${new Date(token.alertTimestamp).toLocaleString('en-US', { timeZone: 'America/New_York' })}
      • Check Time (EST): ${token.checkTimestamp ? new Date(token.checkTimestamp).toLocaleString('en-US', { timeZone: 'America/New_York' }) : 'N/A'}
      • Initial MC: $${token.initialMarketCap.toLocaleString()}
      • Current MC: $${token.currentMarketCap?.toLocaleString() || 'N/A'}
      • PnL: ${token.pnlPercentage.toFixed(2)}%
      • Profit/Loss: $${profitUSD.toFixed(2)}
      `);

      if (profitUSD > 0) {
        totalProfitUSD += profitUSD;
        profitableTrades++;
      } else {
        totalLossUSD += Math.abs(profitUSD);
        lossTrades++;
      }
    }

    const totalTrades = profitableTrades + lossTrades;
    const netProfitUSD = totalProfitUSD - totalLossUSD;
    const averagePnL = totalTrades > 0 ? netProfitUSD / totalTrades : 0;
    const winRate = totalTrades > 0 ? (profitableTrades / totalTrades) * 100 : 0;

    console.log(`
    📊 Today's Summary (EST):
    • Time Window: ${startOfDayEST.toLocaleString('en-US', { timeZone: 'America/New_York' })} to ${endOfDayEST.toLocaleString('en-US', { timeZone: 'America/New_York' })}
    • Total Trades: ${totalTrades}
    • Profitable: ${profitableTrades}
    • Losses: ${lossTrades}
    • Net Profit: $${netProfitUSD.toFixed(2)}
    • Win Rate: ${winRate.toFixed(1)}%
    • SOL Price Used: $${solPrice}
    `);

    return {
      totalProfitUSD,
      totalLossUSD,
      netProfitUSD,
      profitableTrades,
      lossTrades,
      totalTrades,
      averagePnL,
      winRate
    };
  } catch (error) {
    console.error('Error calculating daily profits:', error);
    throw error;
  }
}

async function createDailySummaryImage(data: DailyProfitSummary): Promise<Buffer> {
  try {
    const canvas = createCanvas(1200, 675);
    const ctx = canvas.getContext('2d');

    // Create dark purple background
    ctx.fillStyle = '#1a0b2e';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Add subtle gradient overlay
    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, 'rgba(45, 27, 78, 0.5)');
    gradient.addColorStop(1, 'rgba(61, 43, 110, 0.5)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Title
    ctx.font = 'bold 48px Arial';
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'left';
    ctx.fillText('Daily Trading Summary', 40, 60);

    // Date
    ctx.font = '24px Arial';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.fillText(new Date().toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    }), 40, 100);

    // Net Profit/Loss
    ctx.font = 'bold 72px Arial';
    ctx.fillStyle = data.netProfitUSD >= 0 ? '#4CAF50' : '#F44336';
    ctx.fillText(
      `${data.netProfitUSD >= 0 ? '+' : ''}$${data.netProfitUSD.toLocaleString(undefined, {maximumFractionDigits: 2})}`,
      40, 180
    );

    // Win Rate Bar
    const winRateY = 220;
    ctx.font = '24px Arial';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.fillText('Win Rate', 40, winRateY);
    
    // Progress bar background
    const barWidth = 300;
    const barHeight = 30;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.fillRect(40, winRateY + 10, barWidth, barHeight);
    
    // Progress bar fill
    const fillWidth = (barWidth * data.winRate) / 100;
    const barGradient = ctx.createLinearGradient(40, 0, 40 + fillWidth, 0);
    barGradient.addColorStop(0, '#4CAF50');
    barGradient.addColorStop(1, '#81C784');
    ctx.fillStyle = barGradient;
    ctx.fillRect(40, winRateY + 10, fillWidth, barHeight);
    
    // Win Rate percentage
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'right';
    ctx.fillText(`${data.winRate.toFixed(1)}%`, 40 + barWidth + 50, winRateY + 30);

    // Stats boxes
    const boxY = 300;
    const boxHeight = 100;
    const boxSpacing = 20;
    const boxes = [
      {
        title: 'Total Trades',
        value: data.totalTrades.toString(),
        color: 'rgba(255, 255, 255, 0.1)'
      },
      {
        title: 'Profitable',
        value: `${data.profitableTrades} trades`,
        color: 'rgba(76, 175, 80, 0.1)'
      },
      {
        title: 'Losses',
        value: `${data.lossTrades} trades`,
        color: 'rgba(244, 67, 54, 0.1)'
      }
    ];

    const boxWidth = (canvas.width - 80 - (boxSpacing * 2)) / 3;
    boxes.forEach((box, i) => {
      const x = 40 + (i * (boxWidth + boxSpacing));
      
      // Box background
      ctx.fillStyle = box.color;
      ctx.fillRect(x, boxY, boxWidth, boxHeight);
      
      // Box content
      ctx.textAlign = 'left';
      ctx.font = '24px Arial';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.fillText(box.title, x + 20, boxY + 35);
      
      ctx.font = 'bold 32px Arial';
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(box.value, x + 20, boxY + 75);
    });

    // Bottom stats
    const bottomY = 450;
    const bottomStats = [
      {
        title: 'Total Profit',
        value: `$${data.totalProfitUSD.toLocaleString(undefined, {maximumFractionDigits: 2})}`
      },
      {
        title: 'Total Loss',
        value: `$${data.totalLossUSD.toLocaleString(undefined, {maximumFractionDigits: 2})}`
      },
      {
        title: 'Average PnL',
        value: `$${data.averagePnL.toLocaleString(undefined, {maximumFractionDigits: 2})}`
      }
    ];

    bottomStats.forEach((stat, i) => {
      const x = 40 + (i * (boxWidth + boxSpacing));
      ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
      ctx.fillRect(x, bottomY, boxWidth, boxHeight);
      
      ctx.textAlign = 'left';
      ctx.font = '24px Arial';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.fillText(stat.title, x + 20, bottomY + 35);
      
      ctx.font = 'bold 32px Arial';
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(stat.value, x + 20, bottomY + 75);
    });

    // STROBE branding
    ctx.font = 'bold 36px Arial';
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'right';
    ctx.fillText('STROBE', canvas.width - 40, canvas.height - 40);

    // Current time
    ctx.font = '24px Arial';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.textAlign = 'left';
    ctx.fillText(`Today at ${new Date().toLocaleString('en-US', { 
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: 'numeric',
      hour12: true
    })}`, 40, canvas.height - 40);

    return canvas.toBuffer('image/png');
  } catch (error) {
    console.error('Error creating daily summary image:', error);
    throw error;
  }
}

async function sendDailySummaryAlert(discordClient: Client) {
  try {
    const profits = await calculateDailyProfits();
    const summaryImage = await createDailySummaryImage(profits);
    
    const channel = discordClient.channels.cache.get(
      process.env.DISCORD_PNL_SUMMARY_CHANNEL_ID!
    ) as TextChannel;

    if (!channel) {
      console.error('Summary channel not found!');
      return;
    }

    // Send the main summary image first
    const mainEmbed = new EmbedBuilder()
      .setColor(profits.netProfitUSD >= 0 ? '#4CAF50' : '#F44336')
      .setImage('attachment://daily-summary.png')
      .setTimestamp();

    await channel.send({
      files: [{
        attachment: summaryImage,
        name: 'daily-summary.png'
      }],
      embeds: [mainEmbed]
    });

    // Get trade details and split into chunks
    const tradeDetails = await formatTradeDetails();
    const chunks = splitTradeDetails(tradeDetails);

    // Send each chunk as a separate embed
    for (const [index, chunk] of chunks.entries()) {
      const detailEmbed = new EmbedBuilder()
        .setColor('#9B59B6')
        .setDescription(chunk)
        .setFooter({ 
          text: `Trade Details ${index + 1}/${chunks.length} • ${new Date().toLocaleString('en-US', { 
            timeZone: 'America/New_York',
            month: 'long',
            day: 'numeric',
            year: 'numeric'
          })} EST`,
          iconURL: 'https://pump.fun/favicon.ico'
        });

      await channel.send({ embeds: [detailEmbed] });
    }

    console.log(`
    ✅ Daily Summary Alert Sent to Summary Channel:
    • Channel ID: ${process.env.DISCORD_PNL_SUMMARY_CHANNEL_ID}
    • Net Profit/Loss: $${profits.netProfitUSD.toLocaleString()}
    • Total Trades: ${profits.totalTrades}
    • Win Rate: ${profits.winRate.toFixed(1)}%
    • Average PnL: $${profits.averagePnL.toLocaleString()}
    • Number of detail embeds: ${chunks.length}
    `);

  } catch (error) {
    console.error('Error sending daily summary alert:', error);
  }
}

// Helper function to split trade details into chunks that fit Discord's limit
function splitTradeDetails(details: string): string[] {
  const trades = details.split('\n\n📊');
  const chunks: string[] = [];
  let currentChunk = '';

  // Add header to first chunk
  currentChunk = '**🔍 Detailed Trade Breakdown**\n━━━━━━━━━━━━━━━━━━━━━━\n';
  
  // Process each trade
  for (const trade of trades) {
    const tradeText = trade.startsWith('**Token') ? trade : '📊' + trade;
    
    // If adding this trade would exceed Discord's limit, start a new chunk
    if ((currentChunk + tradeText).length > 3800) { // Using 3800 to leave room for formatting
      chunks.push(currentChunk);
      currentChunk = '**🔍 Trade Details (Continued)**\n━━━━━━━━━━━━━━━━━━━━━━\n';
    }
    
    currentChunk += tradeText + '\n\n';
  }
  
  // Add the last chunk if it has content
  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks;
}

// Helper function to format trade details
async function formatTradeDetails(): Promise<string> {
  try {
    // Get current EST time
    const now = new Date();
    const estTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    
    // Calculate start/end of day in EST
    const startOfDayEST = new Date(estTime);
    startOfDayEST.setHours(0, 0, 0, 0);
    const endOfDayEST = new Date(estTime);
    endOfDayEST.setHours(23, 59, 59, 999);

    // Get all tokens that were alerted today in EST
    const tokens = await prisma.tokenAlert.findMany({
      where: {
        checked: true,
        currentMarketCap: { not: null },
        pnlPercentage: { not: null },
        alertTimestamp: {
          gte: startOfDayEST,
          lte: endOfDayEST
        }
      },
      orderBy: {
        alertTimestamp: 'asc'
      }
    });

    const solPrice = await getSolPrice();
    const initialInvestment = 1.000;
    let details = '';

    // Sort tokens by PnL percentage (highest to lowest)
    const tokenDetails = await Promise.all(tokens.map(async token => {
      if (!token.pnlPercentage) return null;
      const returnedSol = initialInvestment + (initialInvestment * (token.pnlPercentage / 100));
      const profitUSD = (returnedSol - initialInvestment) * solPrice;

      return {
        token,
        profitUSD,
        pnlPercentage: token.pnlPercentage
      };
    }));

    // Filter out null values and sort by PnL
    const sortedTokens = tokenDetails
      .filter(t => t !== null)
      .sort((a, b) => b!.pnlPercentage - a!.pnlPercentage);

    // Format each token's details
    for (const tokenDetail of sortedTokens) {
      if (!tokenDetail) continue;
      const { token, profitUSD } = tokenDetail;
      
      const alertTime = new Date(token.alertTimestamp).toLocaleString('en-US', { 
        timeZone: 'America/New_York',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
      });
      
      const checkTime = token.checkTimestamp ? new Date(token.checkTimestamp).toLocaleString('en-US', { 
        timeZone: 'America/New_York',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
      }) : 'N/A';

      details += `
📊 **Token ${token.tokenAddress.slice(0, 6)}...${token.tokenAddress.slice(-4)}**
━━━━━━━━━━━━━━━━━━━━━━
⏰ Alert Time: ${alertTime} EST
🔄 Check Time: ${checkTime} EST
💰 Initial MC: $${token.initialMarketCap.toLocaleString()}
📈 Final MC: $${token.currentMarketCap?.toLocaleString() || 'N/A'}
📊 PnL: ${token.pnlPercentage?.toFixed(2) || '0.00'}%
💵 Profit/Loss: ${profitUSD >= 0 ? '+' : ''}$${profitUSD.toFixed(2)}
🔗 [Trade Now](https://pump.fun/${token.tokenAddress})

`;
    }

    if (!details) {
      return '```No trades found for today.```';
    }

    return `\`\`\`
Time Window: ${startOfDayEST.toLocaleString('en-US', { 
  timeZone: 'America/New_York',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: true
})} EST to ${endOfDayEST.toLocaleString('en-US', { 
  timeZone: 'America/New_York',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: true
})} EST
\`\`\`
${details}`;

  } catch (error) {
    console.error('Error formatting trade details:', error);
    return '```Error retrieving trade details.```';
  }
}

// Function to test the daily summary
export async function testDailySummary(discordClient: Client) {
  await sendDailySummaryAlert(discordClient);
}

// Add a new function to get top performing tokens
export async function getTopPerformingTokens(limit = 10): Promise<any[]> {
  try {
    console.log(`📊 Fetching top ${limit} performing tokens...`);
    
    // Get tokens that have been checked and have PnL data
    const tokens = await prisma.tokenAlert.findMany({
      where: {
        checked: true
      },
      orderBy: {
        pnlPercentage: 'desc'
      },
      take: limit * 2 // Fetch more than needed to filter out invalid ones
    });
    
    // Filter out tokens with missing data and calculate additional metrics
    const topTokens = tokens
      .filter(token => 
        token.currentMarketCap !== null && 
        token.initialMarketCap !== null &&
        token.currentMarketCap > 0 &&
        token.initialMarketCap > 0
      )
      .map(token => {
        const initialMC = Number(token.initialMarketCap);
        const currentMC = Number(token.currentMarketCap);
        
        // Calculate growth percentage
        const growthPercentage = token.pnlPercentage || 
          ((currentMC - initialMC) / initialMC) * 100;
        
        return {
          tokenAddress: token.tokenAddress,
          tokenName: token.tokenName || 'Unknown',
          tokenSymbol: token.tokenSymbol || 'Unknown',
          initialMarketCap: initialMC,
          currentMarketCap: currentMC,
          growthPercentage: growthPercentage,
          alertTimestamp: token.alertTimestamp,
          checkTimestamp: token.checkTimestamp
        };
      })
      .sort((a, b) => b.growthPercentage - a.growthPercentage)
      .slice(0, limit);
    
    return topTokens;
  } catch (error) {
    console.error('Error fetching top performing tokens:', error);
    return [];
  }
} 
