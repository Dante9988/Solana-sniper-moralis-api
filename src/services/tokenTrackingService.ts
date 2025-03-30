import { PrismaClient, TokenAlert } from '@prisma/client';
import { getTokenMarketData } from './tokenDataService';
import { Client, TextChannel, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import axios from 'axios';
import path from 'path';
import { createCanvas, loadImage } from 'canvas';

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
      const queryParams: string = new URLSearchParams({
        order: 'DESC', // Newest first
        limit: limit.toString(),
        ...(nextCursor && { cursor: nextCursor })
      }).toString();

      console.log(`Making request with params: ${queryParams}`);

      let response: any;
      try {
        response = await axios.get(
          `https://solana-gateway.moralis.io/token/mainnet/${tokenAddress}/swaps?${queryParams}`,
        {
          headers: {
            'accept': 'application/json',
            'X-API-Key': process.env.MORALIS_API_KEY || ''
          },
          timeout: 10000
        }
      )
    } catch (error) {
      console.error('Error fetching swaps:', error);
      break;
    }

      if (!response.data.result || response.data.result.length === 0) {
        console.log('No more swaps found');
        break;
      }

      const swaps = response.data.result;
      
      // Find the last (oldest) Pump.fun swap in this batch
      const lastPumpFunIndex = swaps.findLastIndex((swap: SwapData) => swap.exchangeName === 'Pump.Fun');
      
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
      nextCursor = response.data.cursor;
      
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

        // If PnL is >= 50%, send Discord alert
        if (pnlPercentage >= 50) {
          await sendPnLAlert(discordClient, {
            ...token,
            currentMarketCap: priceData.highestMarketCap,
            highestPriceTimestamp: priceData.timestamp ? new Date(priceData.timestamp * 1000).toISOString() : null,
            pnlPercentage
          });

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

async function getSolPrice(): Promise<number> {
  try {
    console.log('Attempting to fetch SOL price...');
    const response = await axios.get(
      'https://solana-gateway.moralis.io/token/mainnet/So11111111111111111111111111111111111111112/price',
      {
        headers: {
          'accept': 'application/json',
          'X-API-Key': process.env.MORALIS_API_KEY || ''
        },
        timeout: 10000
      }
    );

    if (response.data && response.data.usdPrice) {
      console.log(`SOL price fetched successfully: $${response.data.usdPrice}`);
      return response.data.usdPrice;
    }

    throw new Error('Invalid SOL price data received');
  } catch (error) {
    console.error('Error fetching SOL price:', error);
    return 240; // Fallback price if API fails
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

    // Create rich background with multiple gradients
    // Base gradient
    const baseGradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    baseGradient.addColorStop(0, '#1a0b2e');
    baseGradient.addColorStop(0.5, '#2d1b4e');
    baseGradient.addColorStop(1, '#3d2b6e');
    ctx.fillStyle = baseGradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Add diagonal light beam effect
    const beamGradient = ctx.createLinearGradient(
      canvas.width, 0,
      0, canvas.height
    );
    beamGradient.addColorStop(0, 'rgba(255, 255, 255, 0.1)');
    beamGradient.addColorStop(0.5, 'rgba(255, 255, 255, 0)');
    beamGradient.addColorStop(1, 'rgba(255, 255, 255, 0.05)');
    ctx.fillStyle = beamGradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Add subtle dot matrix pattern
    ctx.fillStyle = 'rgba(255, 255, 255, 0.025)';
    for (let i = 0; i < canvas.width; i += 15) {
      for (let j = 0; j < canvas.height; j += 15) {
        ctx.beginPath();
        ctx.arc(i, j, 0.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Add top-right corner glow
    const cornerGlow = ctx.createRadialGradient(
      canvas.width, 0,
      0,
      canvas.width - 100, 100,
      400
    );
    cornerGlow.addColorStop(0, 'rgba(255, 255, 255, 0.1)');
    cornerGlow.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = cornerGlow;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw token symbol with shadow
    ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
    ctx.shadowBlur = 15;
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 100px Arial';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('$' + data.tokenSymbol, 60, 50);
    ctx.shadowBlur = 0;

    // Calculate profit in USD
    const profitAmount = (data.returnedSol - data.initialSol) * await getSolPrice();

    // Draw profit section with enhanced styling
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.font = '36px Arial';
    ctx.fillText('CURRENT PROFIT', 60, 180);

    // Draw profit amount with shadow
    ctx.shadowColor = 'rgba(76, 175, 80, 0.3)';
    ctx.shadowBlur = 15;
    ctx.font = 'bold 110px Arial';
    ctx.fillStyle = '#4CAF50';
    ctx.fillText(`$${profitAmount.toLocaleString(undefined, {maximumFractionDigits: 0})}`, 60, 220);

    // Draw percentage with glow effect
    ctx.shadowColor = 'rgba(76, 175, 80, 0.4)';
    ctx.font = 'bold 60px Arial';
    ctx.fillText(`+${data.pnlPercentage.toFixed(2)}%`, 60, 340);
    ctx.shadowBlur = 0;

    // Add decorative line
    const lineGradient = ctx.createLinearGradient(60, 0, canvas.width - 60, 0);
    lineGradient.addColorStop(0, 'rgba(255, 255, 255, 0.1)');
    lineGradient.addColorStop(0.5, 'rgba(255, 255, 255, 0.2)');
    lineGradient.addColorStop(1, 'rgba(255, 255, 255, 0.1)');
    ctx.strokeStyle = lineGradient;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(60, 420);
    ctx.lineTo(canvas.width - 60, 420);
    ctx.stroke();

    // Draw investment details with enhanced layout
    const columns = [
      { title: 'TOTAL BOUGHT', value: `${data.initialSol.toFixed(1)} SOL` },
      { title: 'TOTAL HOLD', value: '0 SOL' },
      { title: 'TOTAL SOLD', value: `${data.returnedSol.toFixed(1)} SOL` }
    ];

    columns.forEach((col, index) => {
      const x = 60 + (index * (canvas.width - 120) / 3);
      
      // Draw column title
      ctx.font = '32px Arial';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.textAlign = 'left';
      ctx.fillText(col.title, x, 460);

      // Draw value with shadow
      ctx.shadowColor = 'rgba(0, 0, 0, 0.2)';
      ctx.shadowBlur = 10;
      ctx.font = 'bold 44px Arial';
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(col.value, x, 510);
      ctx.shadowBlur = 0;
    });

    // Add metallic chip card effect
    const chipX = canvas.width - 180;
    const chipY = canvas.height - 180;
    const chipSize = 70;
    
    // Chip background
    const chipGradient = ctx.createLinearGradient(chipX, chipY, chipX + chipSize, chipY + chipSize);
    chipGradient.addColorStop(0, 'rgba(255, 255, 255, 0.1)');
    chipGradient.addColorStop(1, 'rgba(255, 255, 255, 0.05)');
    ctx.fillStyle = chipGradient;
    ctx.fillRect(chipX, chipY, chipSize, chipSize);
    
    // Chip border
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 2;
    ctx.strokeRect(chipX, chipY, chipSize, chipSize);
    ctx.strokeRect(chipX + 10, chipY + 10, chipSize - 20, chipSize - 20);

    // Draw platform branding with enhanced style
    ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
    ctx.shadowBlur = 10;
    ctx.font = 'bold 48px Arial';
    ctx.textAlign = 'right';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText('STROBE', canvas.width - 60, canvas.height - 60);

    return canvas.toBuffer('image/png');
  } catch (error) {
    console.error('Error creating PnL image:', error);
    throw error;
  }
}

async function sendPnLAlert(discordClient: Client, data: any) {
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

    const customImage = await createPnLImage({
      pnlPercentage: data.pnlPercentage,
      tokenSymbol: data.tokenSymbol || 'TOKEN',
      initialMarketCap: data.initialMarketCap,
      currentMarketCap: data.currentMarketCap,
      initialSol: initialSolInvestment,
      returnedSol
    });

    const embed = new EmbedBuilder()
      .setColor('#9B59B6')
      .setImage('attachment://pnl-background.png')
      .setDescription(`🔗 Contract: ${data.tokenAddress}`)
      .setFooter({ 
        text: `Referral Code: ${data.tokenAddress.slice(0, 6)}` 
      });

    const row = new ActionRowBuilder<ButtonBuilder>()
      .addComponents(
        new ButtonBuilder()
          .setLabel('Trade Now')
          .setStyle(ButtonStyle.Link)
          .setURL(`https://pump.fun/${data.tokenAddress}`)
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
  console.log('🔄 Manually triggering daily profit summary...');
  try {
    await sendDailySummaryAlert(discordClient);
    console.log('✅ Daily summary sent successfully');
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

  // Check for daily summary at 23:59:59 PM EST
  setInterval(async () => {
    try {
      const now = new Date();
      const estTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
      
      // Check if it's 23:59:59 PM EST
      if (estTime.getHours() === 23 && estTime.getMinutes() === 59 && estTime.getSeconds() === 59) {
        console.log('🕒 Time to post daily PNL summary!');
        await sendDailySummaryAlert(discordClient);
      }
    } catch (error) {
      console.error('Error in daily summary check:', error);
    }
  }, 1000); // Check every second for more precise timing

  console.log(`
  🔄 Started periodic checks:
  • PnL checks: Every 15 minutes
  • Daily summary: Every day at 23:59:59 PM EST
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

    // Create the main summary embed with image
    const summaryEmbed = new EmbedBuilder()
      .setColor(profits.netProfitUSD >= 0 ? '#4CAF50' : '#F44336')
      .setImage('attachment://daily-summary.png')
      .setDescription(`
||**🔍 Detailed Trade Breakdown**
━━━━━━━━━━━━━━━━━━━━━━
${await formatTradeDetails()}||

> 💡 *Click the spoiler tag above to expand trade details*`)
      .setFooter({ 
        text: `Daily Summary • ${new Date().toLocaleString('en-US', { 
          timeZone: 'America/New_York',
          month: 'long',
          day: 'numeric',
          year: 'numeric'
        })} EST`,
        iconURL: 'https://pump.fun/favicon.ico'
      })
      .setTimestamp();

    await channel.send({
      files: [{
        attachment: summaryImage,
        name: 'daily-summary.png'
      }],
      embeds: [summaryEmbed]
    });

    console.log(`
    ✅ Daily Summary Alert Sent to Summary Channel:
    • Channel ID: ${process.env.DISCORD_PNL_SUMMARY_CHANNEL_ID}
    • Net Profit/Loss: $${profits.netProfitUSD.toLocaleString()}
    • Total Trades: ${profits.totalTrades}
    • Win Rate: ${profits.winRate.toFixed(1)}%
    • Average PnL: $${profits.averagePnL.toLocaleString()}
    `);

  } catch (error) {
    console.error('Error sending daily summary alert:', error);
  }
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

