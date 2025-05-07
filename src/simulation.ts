import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();
const prisma = new PrismaClient();

// Trading parameters - with enhanced dynamic settings for improved profitability
const BASE_STOP_LOSS_PERCENTAGE = 25; // Base stop loss
const MAX_STOP_LOSS_PERCENTAGE = 30; // Maximum allowed stop loss for volatile tokens
const INITIAL_BREAKEVEN_MOVE_PERCENTAGE = 45; // When to first move stop to breakeven (lowered for quicker protection)
const INITIAL_INVESTMENT = 1.0; // 1 SOL per trade

// Smart entry parameters - wait for dump
const WAIT_FOR_DUMP = true; // Enable the wait-for-dump entry strategy
const DUMP_ENTRY_THRESHOLD = 50; // Only enter after token has dumped 50% from peak
const MAX_ENTRY_WAIT_HOURS = 6; // Maximum hours to wait for a dump before giving up
const MIN_DUMP_THRESHOLD = 30; // Minimum dump required if MAX_ENTRY_WAIT_HOURS is reached

// Modified profit taking strategy for dump-entry trades
const DUMP_PROFIT_TARGETS = [
  { percentage: 50, sellPercentage: 50 }, // At 50% profit, sell 50% of position (first major TP)
  { percentage: 80, sellPercentage: 15 }, // At 80% profit, sell another 15%
  { percentage: 120, sellPercentage: 15 }, // At 120% profit, sell another 15%
];

// Linear trailing sell parameters
const ENABLE_LINEAR_TRAILING_SELLS = true; // Enable linear selling after hitting targets
const LINEAR_SELL_INCREMENT = 5; // Sell 5% of remaining position for every 5% gain
const MAX_LINEAR_SELLS = 4; // Maximum number of linear sells to execute

// Optimized profit taking strategy - earlier first target and more aggressive scaling
const PROFIT_TARGETS = [
  { percentage: 15, sellPercentage: 20 },  // First target at 15% (lowered from 20%), sell 20% of position
  { percentage: 40, sellPercentage: 30 },  // Second target at 40% (lowered from 50%), sell 30% of position
  { percentage: 85, sellPercentage: 20 },  // Third target at 85% (lowered from 100%), sell 20% of position
];

// Improved trailing take profit - more aggressive for big runners
const TRAILING_PROFIT_INCREMENT = 8; // After hitting all targets, sell 10% every 8% gain (lowered from 10%)
const TRAILING_PROFIT_ACCELERATION = true; // Accelerate trailing takes on strong momentum

// Advanced parameters for the enhanced strategy
const VOLATILITY_STOP_ADJUSTMENT = true; // Enable dynamic stop-loss based on token volatility
const ENABLE_TREND_DETECTION = true; // Detect trend direction for smarter exits
const MOVE_STOP_INCREMENTALLY = true; // Move stop loss in increments as profit increases

interface TokenPricePoint {
  tokenAddress: string;
  tokenSymbol: string;
  price: number;
  timestamp: Date;
}

interface TradingResult {
  tokenAddress: string;
  tokenSymbol: string;
  initialPrice: number;
  lowestPrice: number;
  highestPrice: number;
  finalPrice: number;
  maxDrawdown: number;
  maxGain: number;
  hitStopLoss: boolean;
  movedToBreakeven: boolean;
  profitTargetsHit: number; // How many profit targets were hit
  finalSellPercentage: number; // Total percentage of position sold
  profit: number;
  profitPercentage: number;
  outcome: 'PROFIT' | 'LOSS' | 'BREAKEVEN';
  exitReason: string; // Description of how the trade ended
}

/**
 * Fetches historical price data for a token
 */
async function fetchTokenPriceHistory(
  tokenAddress: string, 
  startTime: Date, 
  endTime: Date
): Promise<TokenPricePoint[]> {
  try {
    const timeFrom = Math.floor(startTime.getTime() / 1000);
    const timeTo = Math.floor(endTime.getTime() / 1000);

    const response = await axios.get(
      `https://public-api.birdeye.so/defi/history_price?address=${tokenAddress}&address_type=token&type=1m&time_from=${timeFrom}&time_to=${timeTo}`,
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
      console.log(`No price history found for ${tokenAddress}`);
      return [];
    }

    const priceHistory = response.data.data.items;
    const prices: TokenPricePoint[] = priceHistory.map((item: any) => ({
      tokenAddress,
      tokenSymbol: '', // Will fill in later
      price: item.value,
      timestamp: new Date(item.unixTime * 1000)
    }));

    return prices;
  } catch (error) {
    console.error(`Error fetching price history for ${tokenAddress}:`, error);
    return [];
  }
}

/**
 * Calculate volatility score based on price movements
 * Higher score = more volatile
 */
function calculateVolatilityScore(pricePoints: TokenPricePoint[], lookbackPeriod: number = 15): number {
  if (pricePoints.length < lookbackPeriod) {
    return 1.0; // Default score if not enough data
  }
  
  // Get a sample of price points for volatility calculation
  const prices = pricePoints.slice(0, lookbackPeriod).map(p => p.price);
  
  // Calculate mean price
  const mean = prices.reduce((sum, price) => sum + price, 0) / prices.length;
  
  // Calculate standard deviation
  const squaredDiffs = prices.map(price => {
    const diff = price - mean;
    return diff * diff;
  });
  const variance = squaredDiffs.reduce((sum, diff) => sum + diff, 0) / prices.length;
  const stdDev = Math.sqrt(variance);
  
  // Normalize volatility score between 0.7 and 1.3
  // Higher score = more conservative stop loss (higher %)
  const volatilityRatio = stdDev / mean;
  const normalizedScore = 1 + Math.min(Math.max(volatilityRatio * 10, -0.3), 0.3);
  
  return normalizedScore;
}

/**
 * Detect if price is in an uptrend by analyzing recent movements
 */
function detectUptrend(pricePoints: TokenPricePoint[], lookbackPeriod: number = 10): boolean {
  if (pricePoints.length < lookbackPeriod) {
    return false; // Not enough data to determine trend
  }
  
  const recentPrices = pricePoints.slice(0, lookbackPeriod).map(p => p.price);
  
  // Simple trend detection: check if price is generally increasing
  let increasingCandles = 0;
  
  for (let i = 1; i < recentPrices.length; i++) {
    if (recentPrices[i] > recentPrices[i-1]) {
      increasingCandles++;
    }
  }
  
  // Return true if majority of candles are increasing
  return increasingCandles > (lookbackPeriod / 2);
}

/**
 * Simulates a trade based on our enhanced trading rules
 */
function simulateTrade(
  tokenSymbol: string,
  tokenAddress: string,
  pricePoints: TokenPricePoint[],
  initialPrice: number
): TradingResult {
  if (pricePoints.length === 0) {
    return {
      tokenAddress,
      tokenSymbol,
      initialPrice,
      lowestPrice: initialPrice,
      highestPrice: initialPrice,
      finalPrice: initialPrice,
      maxDrawdown: 0,
      maxGain: 0,
      hitStopLoss: false,
      movedToBreakeven: false,
      profitTargetsHit: 0,
      finalSellPercentage: 0,
      profit: 0,
      profitPercentage: 0,
      outcome: 'BREAKEVEN',
      exitReason: 'No price data'
    };
  }

  // Sort price points by timestamp
  pricePoints.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  // First price observed (token alert price)
  const initialAlertPrice = initialPrice;
  
  // Variables for tracking dump entry parameters
  let highestPriceBeforeDump = initialAlertPrice;
  let entryExecuted = false;
  let entryPrice = initialAlertPrice; // Default, but will be updated if WAIT_FOR_DUMP is true
  let entryIndex = 0; // Index at which we entered the trade
  let entryTime: Date | null = null;
  
  // If using wait-for-dump strategy, find entry point
  if (WAIT_FOR_DUMP) {
    let dumpFound = false;
    let hoursWaited = 0;
    let prevHighestPrice = initialAlertPrice;
    
    // First find the highest price after alert
    for (let i = 0; i < pricePoints.length; i++) {
      const currentPrice = pricePoints[i].price;
      
      // Update highest price seen so far
      if (currentPrice > prevHighestPrice) {
        prevHighestPrice = currentPrice;
      }
      
      // Calculate time passed since first price point
      if (i > 0) {
        const timeDiff = pricePoints[i].timestamp.getTime() - pricePoints[0].timestamp.getTime();
        hoursWaited = timeDiff / (1000 * 60 * 60);
      }
      
      // Check if we've found a dump matching our criteria
      const currentDumpPercentage = ((prevHighestPrice - currentPrice) / prevHighestPrice) * 100;
      
      // If we've reached max wait time, lower our dump requirement
      const effectiveDumpThreshold = hoursWaited >= MAX_ENTRY_WAIT_HOURS ? 
        MIN_DUMP_THRESHOLD : DUMP_ENTRY_THRESHOLD;
      
      if (currentDumpPercentage >= effectiveDumpThreshold) {
        // We found a suitable entry point after a dump
        dumpFound = true;
        entryPrice = currentPrice;
        entryIndex = i;
        entryTime = pricePoints[i].timestamp;
        highestPriceBeforeDump = prevHighestPrice;
        break;
      }
      
      // If we've waited too long and still no entry, skip this token
      if (hoursWaited > MAX_ENTRY_WAIT_HOURS * 1.5) {
        // No suitable entry found within our timeframe
        return {
          tokenAddress,
          tokenSymbol,
          initialPrice: initialAlertPrice,
          lowestPrice: initialAlertPrice,
          highestPrice: initialAlertPrice,
          finalPrice: initialAlertPrice,
          maxDrawdown: 0,
          maxGain: 0,
          hitStopLoss: false,
          movedToBreakeven: false,
          profitTargetsHit: 0,
          finalSellPercentage: 0,
          profit: 0,
          profitPercentage: 0,
          outcome: 'BREAKEVEN',
          exitReason: 'No suitable entry found (no dump)'
        };
      }
    }
    
    // If we never found a suitable dump, return without trading
    if (!dumpFound) {
      return {
        tokenAddress,
        tokenSymbol,
        initialPrice: initialAlertPrice,
        lowestPrice: initialAlertPrice,
        highestPrice: initialAlertPrice,
        finalPrice: initialAlertPrice,
        maxDrawdown: 0,
        maxGain: 0,
        hitStopLoss: false,
        movedToBreakeven: false,
        profitTargetsHit: 0,
        finalSellPercentage: 0,
        profit: 0,
        profitPercentage: 0,
        outcome: 'BREAKEVEN',
        exitReason: 'No suitable entry found (no dump)'
      };
    }
    
    // We found a suitable entry point, continue with simulation from this point
    entryExecuted = true;
  } else {
    // If not using wait-for-dump, use original entry logic
    entryPrice = initialAlertPrice;
    entryIndex = 0;
    entryExecuted = true;
    entryTime = pricePoints[0].timestamp;
  }
  
  // If we didn't find a valid entry point, return default result
  if (!entryExecuted) {
    return {
      tokenAddress,
      tokenSymbol,
      initialPrice: initialAlertPrice,
      lowestPrice: initialAlertPrice,
      highestPrice: initialAlertPrice,
      finalPrice: initialAlertPrice,
      maxDrawdown: 0,
      maxGain: 0,
      hitStopLoss: false,
      movedToBreakeven: false,
      profitTargetsHit: 0,
      finalSellPercentage: 0,
      profit: 0,
      profitPercentage: 0,
      outcome: 'BREAKEVEN',
      exitReason: 'No valid entry found'
    };
  }
  
  // Calculate volatility-adjusted stop loss
  let stopLossPercentage = BASE_STOP_LOSS_PERCENTAGE;
  if (VOLATILITY_STOP_ADJUSTMENT) {
    // Use only price points after our entry for volatility calculation
    const relevantPricePoints = pricePoints.slice(entryIndex);
    const volatilityScore = calculateVolatilityScore(relevantPricePoints);
    stopLossPercentage = Math.min(
      BASE_STOP_LOSS_PERCENTAGE * volatilityScore, 
      MAX_STOP_LOSS_PERCENTAGE
    );
  }
  
  // Set initial stop loss and breakeven levels
  let stopLossPrice = entryPrice * (1 - stopLossPercentage / 100);
  const initialBreakevenTrigger = entryPrice * (1 + INITIAL_BREAKEVEN_MOVE_PERCENTAGE / 100);
  
  let lowestPrice = entryPrice;
  let highestPrice = entryPrice;
  let finalPrice = entryPrice;
  let highestGainPercentage = 0;
  
  let hitStopLoss = false;
  let movedToBreakeven = false;
  let remainingPosition = 1.0; // Start with 100% of position
  let accumulatedCash = 0; // Cash received from selling portions
  let profitTargetsHit = 0;
  let exitReason = 'End of simulation period';
  
  // Choose which profit targets to use based on entry strategy
  const profitTargets = WAIT_FOR_DUMP ? 
    DUMP_PROFIT_TARGETS.map(target => ({
      ...target,
      hit: false,
      price: entryPrice * (1 + target.percentage / 100)
    })) :
    PROFIT_TARGETS.map(target => ({
      ...target,
      hit: false,
      price: entryPrice * (1 + target.percentage / 100)
    }));
  
  // Track trailing sell status
  let lastTrailingTarget = profitTargets[profitTargets.length - 1].percentage;
  let nextTrailingPercentage = lastTrailingTarget + TRAILING_PROFIT_INCREMENT;
  
  // For linear trailing sells
  let linearSellsExecuted = 0;
  let nextLinearSellPercentage = profitTargets[0].percentage + LINEAR_SELL_INCREMENT;
  
  // Advanced parameters for tracking trade progress
  let consecutiveUpCandles = 0;
  let consecutiveDownCandles = 0;
  let previousPrice = entryPrice;
  let trailingStopPrice = 0; // Dynamic trailing stop
  
  let exitTime: Date | null = null;

  // Walk through price points to simulate the trade, starting from our entry point
  for (let i = entryIndex; i < pricePoints.length; i++) {
    const point = pricePoints[i];
    
    // If we've completely exited the trade, skip further price points
    if (remainingPosition === 0) {
      exitTime = point.timestamp;
      exitReason = 'Position fully sold';
      break;
    }

    const currentPrice = point.price;
    
    // Update highest and lowest prices
    if (currentPrice < lowestPrice) lowestPrice = currentPrice;
    if (currentPrice > highestPrice) {
      highestPrice = currentPrice;
      // Update highest gain percentage
      highestGainPercentage = ((highestPrice - entryPrice) / entryPrice) * 100;
      
      // Implement dynamic trailing stop for big winners
      if (highestGainPercentage > profitTargets[profitTargets.length - 1].percentage && trailingStopPrice === 0) {
        // Initialize trailing stop once we hit our final target
        trailingStopPrice = highestPrice * 0.85; // Start with 15% trailing stop
      } else if (trailingStopPrice > 0) {
        // Move trailing stop up as price makes new highs
        const newTrailingStop = highestPrice * 0.85;
        if (newTrailingStop > trailingStopPrice) {
          trailingStopPrice = newTrailingStop;
        }
      }
    }
    
    // Update trend detection counters
    if (currentPrice > previousPrice) {
      consecutiveUpCandles++;
      consecutiveDownCandles = 0;
    } else if (currentPrice < previousPrice) {
      consecutiveDownCandles++;
      consecutiveUpCandles = 0;
    }
    previousPrice = currentPrice;
    
    // Check if we hit the regular stop loss
    if (currentPrice <= stopLossPrice) {
      hitStopLoss = true;
      finalPrice = stopLossPrice; // Assume we exit at stop price
      exitTime = point.timestamp;
      exitReason = 'Hit stop loss';
      
      // Sell remaining position at stop loss
      accumulatedCash += remainingPosition * stopLossPrice / entryPrice;
      remainingPosition = 0;
      break;
    }
    
    // Check if we hit the trailing stop (for big winners)
    if (trailingStopPrice > 0 && currentPrice <= trailingStopPrice) {
      hitStopLoss = true; // technically a trailing stop hit, but tracked as stop loss
      finalPrice = trailingStopPrice; // Assume we exit at trailing stop price
      exitTime = point.timestamp;
      exitReason = 'Hit trailing stop';
      
      // Sell remaining position at trailing stop
      accumulatedCash += remainingPosition * trailingStopPrice / entryPrice;
      remainingPosition = 0;
      break;
    }
    
    // Check if we need to move stop loss to breakeven
    if (!movedToBreakeven && currentPrice >= initialBreakevenTrigger) {
      stopLossPrice = entryPrice; // Move stop to breakeven
      movedToBreakeven = true;
    }
    
    // Incremental stop loss movement for larger winning trades
    if (MOVE_STOP_INCREMENTALLY && movedToBreakeven) {
      const currentGainPercentage = ((currentPrice - entryPrice) / entryPrice) * 100;
      
      // Move stop loss up incrementally for winning trades
      if (currentGainPercentage > 60 && stopLossPrice === entryPrice) {
        // At 60% gain, secure 20% profit
        stopLossPrice = entryPrice * 1.2;
      } else if (currentGainPercentage > 100 && stopLossPrice === entryPrice * 1.2) {
        // At 100% gain, secure 40% profit
        stopLossPrice = entryPrice * 1.4;
      }
    }
    
    // Check profit targets (in sequence)
    for (let i = 0; i < profitTargets.length; i++) {
      const target = profitTargets[i];
      
      // Skip targets we've already hit
      if (target.hit) continue;
      
      // Check if current price hits this target
      if (currentPrice >= target.price) {
        // Mark target as hit
        target.hit = true;
        profitTargetsHit++;
        
        // Calculate how much to sell
        const sellAmount = (target.sellPercentage / 100) * 1.0; // % of original position
        
        // Only sell if we have enough remaining
        const actualSellAmount = Math.min(sellAmount, remainingPosition);
        
        // Update remaining position
        remainingPosition -= actualSellAmount;
        
        // Add proceeds to accumulated cash
        accumulatedCash += actualSellAmount * currentPrice / entryPrice;
        
        // If this is the last target defined, set up for trailing sells
        if (i === profitTargets.length - 1) {
          nextTrailingPercentage = target.percentage + TRAILING_PROFIT_INCREMENT;
          
          // For linear sells, initialize after first target hit
          if (ENABLE_LINEAR_TRAILING_SELLS) {
            nextLinearSellPercentage = target.percentage + LINEAR_SELL_INCREMENT;
          }
        }
      }
    }
    
    // Handle linear trailing sells after first profit target is hit
    if (ENABLE_LINEAR_TRAILING_SELLS && profitTargetsHit >= 1 && remainingPosition > 0 && linearSellsExecuted < MAX_LINEAR_SELLS) {
      const currentGainPercentage = ((currentPrice - entryPrice) / entryPrice) * 100;
      
      // Check if we've hit the next linear sell percentage target
      if (currentGainPercentage >= nextLinearSellPercentage) {
        // Calculate what percentage of the REMAINING position to sell
        // This creates a more linear sell pattern
        const linearSellPercentage = 20; // Sell 20% of what remains
        const sellAmount = (linearSellPercentage / 100) * remainingPosition;
        
        // Update remaining position
        remainingPosition -= sellAmount;
        
        // Add proceeds to accumulated cash
        accumulatedCash += sellAmount * currentPrice / entryPrice;
        
        // Increment linear sell counter and set next target
        linearSellsExecuted++;
        nextLinearSellPercentage += LINEAR_SELL_INCREMENT;
      }
    }
    
    // Handle traditional trailing profit targets after all defined targets are hit
    if (profitTargetsHit === profitTargets.length && remainingPosition > 0) {
      const currentGainPercentage = ((currentPrice - entryPrice) / entryPrice) * 100;
      
      // Check if we've hit the next trailing target
      if (currentGainPercentage >= nextTrailingPercentage) {
        // Calculate trailing sell amount (10% of original position)
        const trailingSellPercentage = 10;
        const sellAmount = (trailingSellPercentage / 100) * 1.0;
        
        // Only sell if we have enough remaining
        const actualSellAmount = Math.min(sellAmount, remainingPosition);
        
        // Update remaining position
        remainingPosition -= actualSellAmount;
        
        // Add proceeds to accumulated cash
        accumulatedCash += actualSellAmount * currentPrice / entryPrice;
        
        // Calculate next trailing target, with potential acceleration
        let nextIncrement = TRAILING_PROFIT_INCREMENT;
        if (TRAILING_PROFIT_ACCELERATION && currentGainPercentage > 150) {
          // For big gains >150%, accelerate the trailing sells by reducing the increment
          nextIncrement = TRAILING_PROFIT_INCREMENT * 0.75;
        }
        
        nextTrailingPercentage += nextIncrement;
      }
    }
    
    // If we reached the end without exiting, update final price
    finalPrice = currentPrice;
  }
  
  // If we still have a position, calculate its value at the end
  let finalPositionValue = 0;
  if (remainingPosition > 0) {
    finalPositionValue = remainingPosition * finalPrice / entryPrice;
  }
  
  // Calculate total profit/loss
  const totalValue = accumulatedCash + finalPositionValue;
  const profit = (totalValue - 1.0) * INITIAL_INVESTMENT;
  const profitPercentage = (totalValue - 1.0) * 100;
  
  // Determine overall outcome
  let outcome: 'PROFIT' | 'LOSS' | 'BREAKEVEN' = 'BREAKEVEN';
  if (profitPercentage > 0) outcome = 'PROFIT';
  else if (profitPercentage < 0) outcome = 'LOSS';
  
  // Calculate max drawdown and max gain
  const maxDrawdown = ((entryPrice - lowestPrice) / entryPrice) * 100;
  const maxGain = ((highestPrice - entryPrice) / entryPrice) * 100;
  
  // Calculate the total percentage of the position that was sold
  const finalSellPercentage = (1.0 - remainingPosition) * 100;
  
  return {
    tokenAddress,
    tokenSymbol,
    initialPrice: entryPrice,
    lowestPrice,
    highestPrice,
    finalPrice,
    maxDrawdown,
    maxGain,
    hitStopLoss,
    movedToBreakeven,
    profitTargetsHit,
    finalSellPercentage,
    profit,
    profitPercentage,
    outcome,
    exitReason
  };
}

/**
 * Get tokens from a specific time range
 */
async function getTokensInTimeRange(startTime: Date, endTime: Date) {
  return prisma.tokenAlert.findMany({
    where: {
      alertTimestamp: {
        gte: startTime,
        lte: endTime
      }
    }
  });
}

/**
 * Main simulation function for a specific time range
 */
async function runSimulation(startTime: Date, endTime: Date) {
  console.log(`
  🔬 Running trading simulation:
  • Time range: ${startTime.toLocaleString()} to ${endTime.toLocaleString()}
  • Stop loss: ${BASE_STOP_LOSS_PERCENTAGE}% to ${MAX_STOP_LOSS_PERCENTAGE}%
  • ${WAIT_FOR_DUMP ? `Smart Entry: Wait for ${DUMP_ENTRY_THRESHOLD}% dump before entering` : 'Standard entry at alert price'}
  • Profit targets: ${WAIT_FOR_DUMP 
    ? DUMP_PROFIT_TARGETS.map(t => `${t.percentage}% (sell ${t.sellPercentage}%)`).join(', ') 
    : PROFIT_TARGETS.map(t => `${t.percentage}% (sell ${t.sellPercentage}%)`).join(', ')}
  • ${ENABLE_LINEAR_TRAILING_SELLS 
    ? `Linear sells: ${LINEAR_SELL_INCREMENT}% increments (max ${MAX_LINEAR_SELLS} sells)` 
    : `Trailing sells: ${TRAILING_PROFIT_INCREMENT}% increments (sell 10% each time)`}
  • Move to breakeven at: ${INITIAL_BREAKEVEN_MOVE_PERCENTAGE}%
  • Initial investment: ${INITIAL_INVESTMENT} SOL
  `);
  
  // Get tokens alerted in the specified time range
  const tokens = await getTokensInTimeRange(startTime, endTime);
  console.log(`Found ${tokens.length} tokens alerted in this time range`);
  
  if (tokens.length === 0) {
    console.log('No tokens found for simulation');
    return;
  }
  
  // Set end time for price history to current time if endTime is in the future
  const now = new Date();
  const priceHistoryEndTime = endTime > now ? now : endTime;
  
  // Add 24 hours to endTime for price history to simulate trading for a day
  const simulationEndTime = new Date(priceHistoryEndTime.getTime() + 24 * 60 * 60 * 1000);
  
  const results: TradingResult[] = [];
  const solPrice = await getSolPrice();
  
  // Track smart entry statistics
  let totalTokensEvaluated = 0;
  let entrySuccessCount = 0;
  let totalDumpPercentage = 0;
  let maxDumpPercentage = 0;
  let minDumpPercentage = 100;
  
  for (const token of tokens) {
    console.log(`Processing ${token.tokenSymbol || token.tokenAddress}...`);
    totalTokensEvaluated++;
    
    // Fetch historical price data
    const priceHistory = await fetchTokenPriceHistory(
      token.tokenAddress,
      token.alertTimestamp, // Start from when the token was alerted
      simulationEndTime // Simulate for 24 hours after end time
    );
    
    if (priceHistory.length === 0) {
      console.log(`No price data available for ${token.tokenSymbol || token.tokenAddress}`);
      continue;
    }
    
    // Fill in token symbol for price points
    priceHistory.forEach(point => {
      point.tokenSymbol = token.tokenSymbol || '';
    });
    
    // Simulate the trade
    const result = simulateTrade(
      token.tokenSymbol || '',
      token.tokenAddress,
      priceHistory,
      token.initialPrice
    );
    
    // If we're using wait-for-dump strategy, track entry success
    if (WAIT_FOR_DUMP) {
      // Check if we successfully entered a trade (result would have exitReason that's not about entry)
      if (!result.exitReason.includes('No suitable entry') && !result.exitReason.includes('No valid entry')) {
        entrySuccessCount++;
        
        // Calculate dump percentage (difference between initial price and entry price)
        const dumpPercentage = ((token.initialPrice - result.initialPrice) / token.initialPrice) * 100;
        totalDumpPercentage += dumpPercentage;
        
        // Track min/max dump percentages
        if (dumpPercentage > maxDumpPercentage) maxDumpPercentage = dumpPercentage;
        if (dumpPercentage < minDumpPercentage) minDumpPercentage = dumpPercentage;
      }
    }
    
    results.push(result);
    
    // Log individual result with enhanced details
    console.log(`
    Token: ${result.tokenSymbol || result.tokenAddress}
    ${WAIT_FOR_DUMP ? `Entry: ${result.exitReason.includes('No suitable entry') ? 'SKIPPED (no dump)' : 'ENTERED'}` : ''}
    ${WAIT_FOR_DUMP && !result.exitReason.includes('No suitable entry') ? `Entry Price: ${result.initialPrice.toFixed(8)} (${((token.initialPrice - result.initialPrice) / token.initialPrice * 100).toFixed(2)}% drop)` : ''}
    Outcome: ${result.outcome} (${result.profitPercentage.toFixed(2)}%)
    Profit/Loss: ${(result.profit * solPrice).toFixed(2)} USD
    Exit Reason: ${result.exitReason}
    Max Gain: ${result.maxGain.toFixed(2)}%
    Max Drawdown: ${result.maxDrawdown.toFixed(2)}%
    Hit Stop Loss: ${result.hitStopLoss ? 'Yes' : 'No'}
    Moved to Breakeven: ${result.movedToBreakeven ? 'Yes' : 'No'}
    Profit Targets Hit: ${result.profitTargetsHit} of ${WAIT_FOR_DUMP ? DUMP_PROFIT_TARGETS.length : PROFIT_TARGETS.length}
    Position Sold: ${result.finalSellPercentage.toFixed(1)}%
    `);
  }
  
  // Filter out tokens that didn't have an entry in wait-for-dump mode
  const tradedResults = WAIT_FOR_DUMP 
    ? results.filter(r => !r.exitReason.includes('No suitable entry') && !r.exitReason.includes('No valid entry'))
    : results;
  
  // Calculate overall statistics on traded tokens
  const totalTrades = tradedResults.length;
  const profitableTrades = tradedResults.filter(r => r.outcome === 'PROFIT').length;
  const lossTrades = tradedResults.filter(r => r.outcome === 'LOSS').length;
  const breakEvenTrades = tradedResults.filter(r => r.outcome === 'BREAKEVEN').length;
  
  const winRate = totalTrades > 0 ? (profitableTrades / totalTrades) * 100 : 0;
  
  const totalProfitSOL = tradedResults.reduce((sum, r) => sum + (r.outcome === 'PROFIT' ? r.profit : 0), 0);
  const totalLossSOL = tradedResults.reduce((sum, r) => sum + (r.outcome === 'LOSS' ? Math.abs(r.profit) : 0), 0);
  const netProfitSOL = totalProfitSOL - totalLossSOL;
  
  const totalProfitUSD = totalProfitSOL * solPrice;
  const totalLossUSD = totalLossSOL * solPrice;
  const netProfitUSD = netProfitSOL * solPrice;
  
  // Calculate profitability percentage
  const totalInvestmentSOL = totalTrades * INITIAL_INVESTMENT;
  const totalInvestmentUSD = totalInvestmentSOL * solPrice;
  const profitabilityPercentage = totalInvestmentSOL > 0 ? (netProfitSOL / totalInvestmentSOL) * 100 : 0;
  
  // Calculate final portfolio value
  const finalPortfolioValueSOL = totalInvestmentSOL + netProfitSOL;
  const finalPortfolioValueUSD = finalPortfolioValueSOL * solPrice;
  
  // Calculate what 10 SOL would become
  const tenSolScalingFactor = totalInvestmentSOL > 0 ? 10 / totalInvestmentSOL : 1;
  const tenSolFinalValue = finalPortfolioValueSOL * tenSolScalingFactor;
  
  // Categorize trades by profit/loss brackets
  const profitLossBrackets = {
    bigWins: tradedResults.filter(r => r.profitPercentage >= 50).length,
    mediumWins: tradedResults.filter(r => r.profitPercentage >= 20 && r.profitPercentage < 50).length,
    smallWins: tradedResults.filter(r => r.profitPercentage > 0 && r.profitPercentage < 20).length,
    breakEven: tradedResults.filter(r => r.profitPercentage === 0).length,
    smallLosses: tradedResults.filter(r => r.profitPercentage < 0 && r.profitPercentage > -10).length,
    mediumLosses: tradedResults.filter(r => r.profitPercentage <= -10 && r.profitPercentage > -15).length,
    bigLosses: tradedResults.filter(r => r.profitPercentage <= -15).length
  };
  
  const stoppedOutTrades = tradedResults.filter(r => r.hitStopLoss).length;
  const movedToBreakevenTrades = tradedResults.filter(r => r.movedToBreakeven).length;
  const firstTargetHitTrades = tradedResults.filter(r => r.profitTargetsHit >= 1).length;
  const secondTargetHitTrades = tradedResults.filter(r => r.profitTargetsHit >= 2).length;
  const thirdTargetHitTrades = tradedResults.filter(r => r.profitTargetsHit >= 3).length;
  
  // Entry strategy statistics
  const entrySuccessRate = totalTokensEvaluated > 0 ? (entrySuccessCount / totalTokensEvaluated) * 100 : 0;
  const avgDumpPercentage = entrySuccessCount > 0 ? totalDumpPercentage / entrySuccessCount : 0;
  
  // Print overall statistics with enhanced strategy metrics
  console.log(`
  📊 Simulation Results Summary:
  =============================
  
  🕒 Time Period: ${startTime.toLocaleString()} - ${endTime.toLocaleString()}
  
  ${WAIT_FOR_DUMP ? `
  🎯 Smart Entry Strategy Results:
  • Tokens Evaluated: ${totalTokensEvaluated}
  • Successful Entries: ${entrySuccessCount} (${entrySuccessRate.toFixed(1)}%)
  • Average Dump at Entry: ${avgDumpPercentage.toFixed(2)}%
  • Dump Range: ${minDumpPercentage.toFixed(2)}% to ${maxDumpPercentage.toFixed(2)}%
  • Tokens Skipped (no entry): ${totalTokensEvaluated - entrySuccessCount}
  ` : ''}
  
  💰 Profitability:
  • Total Profit: $${totalProfitUSD.toFixed(2)} (${totalProfitSOL.toFixed(2)} SOL)
  • Total Loss: $${totalLossUSD.toFixed(2)} (${totalLossSOL.toFixed(2)} SOL)
  • Net Profit: $${netProfitUSD.toFixed(2)} (${netProfitSOL.toFixed(2)} SOL)
  • Overall Profitability: ${profitabilityPercentage > 0 ? '+' : ''}${profitabilityPercentage.toFixed(2)}%
  
  💼 Portfolio Performance:
  • Initial Investment: ${totalInvestmentSOL.toFixed(2)} SOL ($${totalInvestmentUSD.toFixed(2)})
  • Final Value: ${finalPortfolioValueSOL.toFixed(2)} SOL ($${finalPortfolioValueUSD.toFixed(2)})
  • ROI: ${profitabilityPercentage > 0 ? '+' : ''}${profitabilityPercentage.toFixed(2)}%
  
  🔮 Projection:
  • 10 SOL would become: ${tenSolFinalValue.toFixed(2)} SOL ($${(tenSolFinalValue * solPrice).toFixed(2)})
  
  📊 Profit/Loss Distribution:
  • Big Wins (>50%): ${profitLossBrackets.bigWins} trades (${totalTrades > 0 ? (profitLossBrackets.bigWins/totalTrades*100).toFixed(1) : '0.0'}%)
  • Medium Wins (20-50%): ${profitLossBrackets.mediumWins} trades (${totalTrades > 0 ? (profitLossBrackets.mediumWins/totalTrades*100).toFixed(1) : '0.0'}%)
  • Small Wins (0-20%): ${profitLossBrackets.smallWins} trades (${totalTrades > 0 ? (profitLossBrackets.smallWins/totalTrades*100).toFixed(1) : '0.0'}%)
  • Break Even: ${profitLossBrackets.breakEven} trades (${totalTrades > 0 ? (profitLossBrackets.breakEven/totalTrades*100).toFixed(1) : '0.0'}%)
  • Small Losses (0-10%): ${profitLossBrackets.smallLosses} trades (${totalTrades > 0 ? (profitLossBrackets.smallLosses/totalTrades*100).toFixed(1) : '0.0'}%)
  • Medium Losses (10-15%): ${profitLossBrackets.mediumLosses} trades (${totalTrades > 0 ? (profitLossBrackets.mediumLosses/totalTrades*100).toFixed(1) : '0.0'}%)
  • Big Losses (>15%): ${profitLossBrackets.bigLosses} trades (${totalTrades > 0 ? (profitLossBrackets.bigLosses/totalTrades*100).toFixed(1) : '0.0'}%)
  
  📈 Trade Statistics:
  • Total Trades: ${totalTrades}
  • Profitable Trades: ${profitableTrades} (${totalTrades > 0 ? (profitableTrades/totalTrades*100).toFixed(1) : '0.0'}%)
  • Loss Trades: ${lossTrades} (${totalTrades > 0 ? (lossTrades/totalTrades*100).toFixed(1) : '0.0'}%)
  • Breakeven Trades: ${breakEvenTrades} (${totalTrades > 0 ? (breakEvenTrades/totalTrades*100).toFixed(1) : '0.0'}%)
  • Win Rate: ${winRate.toFixed(1)}%
  
  ⚙️ Strategy Performance:
  • Trades Stopped Out: ${stoppedOutTrades} (${totalTrades > 0 ? (stoppedOutTrades/totalTrades*100).toFixed(1) : '0.0'}%)
  • Trades Moved to Breakeven: ${movedToBreakevenTrades} (${totalTrades > 0 ? (movedToBreakevenTrades/totalTrades*100).toFixed(1) : '0.0'}%)
  • Hit First Target: ${firstTargetHitTrades} (${totalTrades > 0 ? (firstTargetHitTrades/totalTrades*100).toFixed(1) : '0.0'}%)
  • Hit Second Target: ${secondTargetHitTrades} (${totalTrades > 0 ? (secondTargetHitTrades/totalTrades*100).toFixed(1) : '0.0'}%)
  • Hit Third Target: ${thirdTargetHitTrades} (${totalTrades > 0 ? (thirdTargetHitTrades/totalTrades*100).toFixed(1) : '0.0'}%)
  
  💵 SOL Price Used: $${solPrice.toFixed(2)}
  `);
  
  // Additional analytics: best performing tokens
  const topPerformers = [...tradedResults]
    .sort((a, b) => b.profitPercentage - a.profitPercentage)
    .slice(0, 5);
  
  console.log(`
  🏆 Top Performing Tokens:
  `);
  
  topPerformers.forEach((token, index) => {
    console.log(`
    ${index + 1}. ${token.tokenSymbol || token.tokenAddress}
    • Profit: ${token.profitPercentage.toFixed(2)}% ($${(token.profit * solPrice).toFixed(2)})
    • Max Gain: ${token.maxGain.toFixed(2)}%
    `);
  });
  
  // Worst performing tokens
  const worstPerformers = [...tradedResults]
    .sort((a, b) => a.profitPercentage - b.profitPercentage)
    .slice(0, 5);
  
  console.log(`
  ⚠️ Worst Performing Tokens:
  `);
  
  worstPerformers.forEach((token, index) => {
    console.log(`
    ${index + 1}. ${token.tokenSymbol || token.tokenAddress}
    • Loss: ${token.profitPercentage.toFixed(2)}% ($${(token.profit * solPrice).toFixed(2)})
    • Max Drawdown: ${token.maxDrawdown.toFixed(2)}%
    `);
  });
}

/**
 * Get current SOL price
 */
async function getSolPrice(): Promise<number> {
  try {
    const response = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
      { timeout: 5000 }
    );
    
    if (response.data && response.data.solana && response.data.solana.usd) {
      return response.data.solana.usd;
    }
    
    // Fallback to a reasonable default if API fails
    return 170;
  } catch (error) {
    console.error('Error fetching SOL price:', error);
    return 170; // Default fallback price
  }
}

/**
 * Helper to parse date strings to EST time
 */
function parseESTDate(dateStr: string): Date {
  const date = new Date(dateStr);
  // Convert to EST string and back to Date to handle timezone
  return new Date(date.toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

/**
 * Get start of today in EST
 */
function getStartOfTodayEST(): Date {
  const now = new Date();
  const estNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  estNow.setHours(0, 0, 0, 0);
  return estNow;
}

/**
 * Get start of yesterday in EST
 */
function getStartOfYesterdayEST(): Date {
  const today = getStartOfTodayEST();
  today.setDate(today.getDate() - 1);
  return today;
}

/**
 * Get end of yesterday in EST
 */
function getEndOfYesterdayEST(): Date {
  const today = getStartOfTodayEST();
  today.setSeconds(today.getSeconds() - 1);
  return today;
}

/**
 * Main execution based on command line arguments
 */
async function main() {
  const args = process.argv.slice(2);
  
  // Default to yesterday if no time range specified
  let startTime: Date;
  let endTime: Date;
  
  if (args.length >= 1) {
    const timeRange = args[0].toLowerCase();
    
    if (timeRange === 'today') {
      startTime = getStartOfTodayEST();
      endTime = new Date(); // Current time
      console.log('Running simulation for today (so far)');
    } else if (timeRange === 'yesterday') {
      startTime = getStartOfYesterdayEST();
      endTime = getEndOfYesterdayEST();
      console.log('Running simulation for yesterday');
    } else if (timeRange === 'last24h') {
      endTime = new Date();
      startTime = new Date(endTime.getTime() - 24 * 60 * 60 * 1000);
      console.log('Running simulation for last 24 hours');
    } else if (args.length >= 2) {
      // Custom date range
      startTime = parseESTDate(args[0]);
      endTime = parseESTDate(args[1]);
      console.log(`Running simulation from ${startTime.toLocaleString()} to ${endTime.toLocaleString()}`);
    } else {
      console.error('Invalid time range. Use: today, yesterday, last24h, or provide start and end dates');
      process.exit(1);
    }
  } else {
    // Default to yesterday
    startTime = getStartOfYesterdayEST();
    endTime = getEndOfYesterdayEST();
    console.log('Running simulation for yesterday (default)');
  }
  
  await runSimulation(startTime, endTime);
  
  // Close Prisma client
  await prisma.$disconnect();
}

// Run the main function
main().catch(e => {
  console.error('Error running simulation:', e);
  process.exit(1);
}); 