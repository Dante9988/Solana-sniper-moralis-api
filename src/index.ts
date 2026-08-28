import WebSocket from "ws"; // Node.js websocket library
import { WebSocketRequest } from "./types"; // Typescript Types for type safety
import { config } from "./config"; // Configuration parameters for our bot
import { isApiServerEnabled } from "./apiServerGate";
import { fetchTransactionDetails, createSwapTransaction, getRugCheckConfirmed, fetchAndSaveSwapDetails, fetchTokenMintFromTx } from "./transactions";
import { validateEnv } from "./utils/env-validator";
import player from "play-sound";
import { sendTokenAlert, fetchTrenchData } from './discord/discord';
import { performance } from 'perf_hooks';
import express from 'express';
import { Connection, PublicKey } from "@solana/web3.js";
import { MintsDataReponse } from "./types";
import { checkTokenPnL, startPeriodicChecks } from './services/tokenTrackingService';
import { client } from './discord/discord';
import { jupiterService } from './services/jupiterService';
import { telegramBot } from './telegram/telegramBot';
import { pumpSwapService, verifyPumpFunMigration } from './services/pumpswapService';
import { formatMarketCap, formatVolume, getTokenMarketData } from "./services/tokenDataService";
import { fetchSniperData } from "./services/sniperDataService";
import { scheduleDailyTopTokensReport } from './services/dailyTopTokensService';
import axios from 'axios';
import { initApiServer } from './api';
import { broadcastTokenAlert, TokenAlertData } from './api';

// Define minimum market cap threshold
const MINIMUM_MARKET_CAP = 15000; // $15k minimum threshold

// Helper function to delay execution
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Implement fetchLatestPrice function
async function fetchLatestPrice(tokenMint: string, retryCount = 3): Promise<number> {
  const RETRY_DELAY = 200; // 200ms delay
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
          timeout: 1000 // 1 second timeout
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

// Implement doubleCheckMarketCap function with a faster version for our needs
async function doubleCheckMarketCap(tokenMint: string, retryCount = 1): Promise<number> {
    try {
        console.log(`🔄 Quick market cap check for ${tokenMint}...`);
        
        // We'll only do one check for speed - we've optimized for faster alerts
        const [tokenData, latestPrice] = await Promise.all([
            getTokenMarketData(tokenMint),
            fetchLatestPrice(tokenMint)
        ]);

        const PUMPFUN_TOTAL_SUPPLY = 1_000_000_000;
        const marketCapFromPrice = latestPrice * PUMPFUN_TOTAL_SUPPLY;
        const marketCapFromData = tokenData?.marketCap || 0;

        console.log(`
        Market Cap Check:
        • From Price: $${marketCapFromPrice.toLocaleString()}
        • From Data: $${marketCapFromData.toLocaleString()}
        `);

        // Use the higher value between the two calculations
        const marketCap = Math.max(marketCapFromPrice, marketCapFromData);
        console.log(`✅ Verified market cap for ${tokenMint}: $${marketCap.toLocaleString()}`);
        
        return marketCap;
    } catch (error) {
        console.error(`❌ Error checking market cap for ${tokenMint}:`, error);
        return 0;
    }
}
import { dispatchTokenIntelligence } from "./services/tokenIntelligenceDispatch";

const audioPlayer = player({});

// Regional Variables
let activeTransactions = 0;
const MAX_CONCURRENT = config.tx.concurrent_transactions;

const connection = new Connection(process.env.HELIUS_HTTPS_URI || "");

// Add at the top with other regional variables
const processedSignatures = new Set<string>();
const MAX_PROCESSED_SIGNATURES = 1000; // Keep last 1000 signatures

// Performance metrics object
/*
const metrics = {
    websocket: {
        connections: 0,
        reconnects: 0,
        lastReconnect: null as Date | null,
    },
    transactions: {
        total: 0,
        successful: 0,
        failed: 0,
        skipped: 0,
        avgProcessingTime: 0,
        maxProcessingTime: 0,
        minProcessingTime: Infinity,
    },
    rugCheck: {
        total: 0,
        passed: 0,
        failed: 0,
        avgCheckTime: 0,
    },
    swaps: {
        attempted: 0,
        successful: 0,
        failed: 0,
        avgSwapTime: 0,
    },
    errors: {
        count: 0,
        lastError: null as string | null,
        lastErrorTime: null as Date | null,
    },
    performance: {
        lastMinute: {
            transactions: 0,
            startTime: Date.now(),
        },
        memoryUsage: process.memoryUsage(),
        uptime: 0,
    }
};
*/

// Setup Express server for metrics
// Completely removed metrics server to avoid running on any port

// Single safe Telegram bot initialization
(async () => {
  try {
    // Check if the bot is already initialized
    const isInitialized = (telegramBot as any).isInitialized;
    if (isInitialized) {
      console.log('📱 TELEGRAM: Bot is already initialized, skipping initialization');
      return;
    }
    
    console.log('📱 TELEGRAM: Starting single safe bot initialization...');
    await telegramBot.initialize();
    console.log('📱 TELEGRAM: Bot successfully initialized');
  } catch (error) {
    console.error('📱 TELEGRAM: Safe initialization error:', error);
  }
})();

// Function used to open our websocket connection
function sendSubscribeRequest(ws: WebSocket): void {
  // Create a subscription for each enabled pool
  config.liquidity_pool
    .filter(pool => pool.enabled)
    .forEach(pool => {
      const subscriptionMessage = {
        jsonrpc: "2.0",
        id: pool.id,
        method: "logsSubscribe",
        params: [
          {
            mentions: [pool.program],
          },
          {
            commitment: "processed",
          },
        ],
      };
      ws.send(JSON.stringify(subscriptionMessage));
    });
}

export let rugCheckPassed: boolean;

// Function to check if logs contain a Create_pool with >80 WSOL
function isHighWsolPoolCreation(logs: string[]): boolean {
    // Look for Create_pool instruction in any enabled pool
    const poolLog = logs.find(log => 
        typeof log === "string" && 
        config.liquidity_pool
            .filter(pool => pool.enabled)
            .some(pool => pool.instruction && log.includes(pool.instruction))
    );

    if (!poolLog) return false;

    // Extract WSOL amount
    const wsolMatch = poolLog.match(/and ([\d,.]+) WSOL/);
    if (!wsolMatch) return false;

    // Check if WSOL amount > 80
    const wsolAmount = parseFloat(wsolMatch[1].replace(/,/g, ''));
    return !isNaN(wsolAmount) && wsolAmount > 80;
}

// Function to extract token mint from Create_pool logs
function getTokenMintFromLogs(logs: string[]): string | null {
    try {
        // Find the Create_pool log from any enabled pool
        const poolLog = logs.find(log => 
            typeof log === "string" && 
            config.liquidity_pool
                .filter(pool => pool.enabled)
                .some(pool => pool.instruction && log.includes(pool.instruction))
        );

        if (!poolLog) return null;

        // Extract token amount and symbol
        const tokenMatch = poolLog.match(/Create_pool ([\d,.]+ [A-Z0-9]+)/);
        if (!tokenMatch) return null;

        // Find transfer log with this token
        const transferLog = logs.find(log =>
            typeof log === "string" && 
            log.includes("Transfer") &&
            log.includes(tokenMatch[1])
        );

        if (!transferLog) return null;

        // Extract mint address
        const mintMatch = transferLog.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
        return mintMatch ? mintMatch[0] : null;

    } catch (error) {
        console.error('Error extracting token mint:', error);
        return null;
    }
}

// Function used to handle the transaction once a new pool creation is found
async function processTransaction(signature: string): Promise<void> {
  const start = performance.now();
  
  try {
    // Output logs
    console.log("=============================================");
    console.log("🔎 New High-WSOL Pool Creation Found");
    console.log("🔃 Fetching transaction details ...");

    // Fetch the transaction details with retry
    let data = null;
    let retryCount = 0;
    const maxRetries = 3;
    
    while (!data && retryCount < maxRetries) {
      try {
        data = await fetchTokenMintFromTx(signature, connection);
        if (!data) {
          retryCount++;
          await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
        }
      } catch (error) {
        console.error(`Error fetching transaction details (attempt ${retryCount + 1}/${maxRetries}):`, error);
        retryCount++;
        if (retryCount < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
        }
      }
    }

    if (!data) {
      // metrics.transactions.failed++;
      console.log("⛔ Transaction aborted. No data returned after retries.");
      return;
    }

    // Ensure required data is available
    if (!data.solMint || !data.tokenMint) {
      console.log("⛔ Transaction aborted. Missing required data.");
      return;
    }

    // Check if this is a Pump.fun token
    const isPumpToken = data.tokenMint.toLowerCase().endsWith('pump');
    console.log(`Token ${data.tokenMint} is ${isPumpToken ? 'a Pump.fun token' : 'not a Pump.fun token'}`);
    
    // Skip rug check for non-Pump.fun tokens
    if (!isPumpToken) {
      console.log(`⏭️ Skipping rug check for non-Pump.fun token: ${data.tokenMint}`);
      
      // Output logs
      console.log("Token found");
      console.log("👽 GMGN: https://gmgn.ai/sol/token/" + data.tokenMint);
      console.log("😈 BullX: https://neo.bullx.io/terminal?chainId=1399811149&address=" + data.tokenMint);
      console.log("🌌 Axiom: https://axiom.trade/t/" + data.tokenMint);
      
      // Try to fetch token metadata for better Telegram alerts
      let tokenName = "Unknown";
      let tokenSymbol = "Unknown";
      let liquidityInSol = 0;
      let marketData = {
        marketCap: 'Unknown',
        volume24h: 'Unknown',
        bundles: 'Unknown',
        percentage: 'Unknown',
        solSpent: 'Unknown'
      };

      try {
        console.log(`Fetching token metadata for ${data.tokenMint}...`);
        const tokenData = await getTokenMarketData(data.tokenMint);
        if (tokenData) {
          tokenName = tokenData.metadata?.name || "Unknown";
          tokenSymbol = tokenData.metadata?.symbol || "Unknown";
          
          // Get market data
          if (tokenData.marketCap) {
            marketData.marketCap = formatMarketCap(tokenData.marketCap);
          }
          if (tokenData.volume24h) {
            marketData.volume24h = formatVolume(tokenData.volume24h);
          }
          if (tokenData.liquidity && tokenData.price) {
            liquidityInSol = tokenData.liquidity / tokenData.price;
          }
          
          console.log(`Token metadata fetched: ${tokenName} (${tokenSymbol})`);
        }
      } catch (error) {
        console.error(`Error fetching token metadata:`, error);
        // Continue with default values
      }
      
      // Instead of calling Discord-only function, call the function that handles both Discord and Telegram
      //await sendTokenAlert(data.tokenMint, false);
      await sendTokenAlerts(
        data.tokenMint,        // tokenAddress
        tokenName,             // tokenName
        tokenSymbol,           // tokenSymbol
        signature,             // transaction signature
        liquidityInSol,        // liquidityInSol
        false,                 // rugCheckPassed
        marketData             // marketData
      );
      
      console.log("🟢 Resuming looking for new tokens..\n");
      return;
    }

    // Track rug check metrics (only for Pump.fun tokens)
    // metrics.rugCheck.total++;
    const rugCheckStart = performance.now();
    const isRugCheckPassed = await getRugCheckConfirmed(data.tokenMint);
    rugCheckPassed = isRugCheckPassed;
    
    const rugCheckTime = performance.now() - rugCheckStart;
    /*
    metrics.rugCheck.avgCheckTime = 
        (metrics.rugCheck.avgCheckTime * (metrics.rugCheck.total - 1) + rugCheckTime) 
        / metrics.rugCheck.total;
    */

    if (!isRugCheckPassed) {
      // metrics.rugCheck.failed++;
      console.log(`🚫 Rug Check failed for token: ${data.tokenMint}`);
      console.log("🚫 Rug Check not passed! Transaction aborted.");
      return;
    }
    // metrics.rugCheck.passed++;

    // Output logs
    console.log("Token found");
    console.log("👽 GMGN: https://gmgn.ai/sol/token/" + data.tokenMint);
    console.log("😈 BullX: https://neo.bullx.io/terminal?chainId=1399811149&address=" + data.tokenMint);
    console.log("🌌 Axiom: https://axiom.trade/t/" + data.tokenMint);

    // Try to fetch token metadata for better Telegram alerts
    let tokenName = "Unknown";
    let tokenSymbol = "Unknown";
    let liquidityInSol = 0;
    let marketData = {
      marketCap: 'Unknown',
      volume24h: 'Unknown',
      bundles: 'Unknown',
      percentage: 'Unknown',
      solSpent: 'Unknown'
    };

    try {
      console.log(`Fetching token metadata for ${data.tokenMint}...`);
      const tokenData = await getTokenMarketData(data.tokenMint);
      if (tokenData) {
        tokenName = tokenData.metadata?.name || "Unknown";
        tokenSymbol = tokenData.metadata?.symbol || "Unknown";
        
        // Get market data
        if (tokenData.marketCap) {
          marketData.marketCap = formatMarketCap(tokenData.marketCap);
        }
        if (tokenData.volume24h) {
          marketData.volume24h = formatVolume(tokenData.volume24h);
        }
        if (tokenData.liquidity && tokenData.price) {
          liquidityInSol = tokenData.liquidity / tokenData.price;
        }
        
        console.log(`Token metadata fetched: ${tokenName} (${tokenSymbol})`);
      }
    } catch (error) {
      console.error(`Error fetching token metadata:`, error);
      // Continue with default values
    }

    // Call function that handles both Discord and Telegram alerts
    await sendTokenAlerts(
      data.tokenMint,          // tokenAddress
      tokenName,               // tokenName
      tokenSymbol,             // tokenSymbol
      signature,               // transaction signature
      liquidityInSol,          // liquidityInSol
      isRugCheckPassed,        // rugCheckPassed
      marketData               // marketData
    );

    // Check if simulation mode is enabled
    if (config.rug_check.simulation_mode) {
      console.log("👀 Token not swapped. Simulation mode is enabled.");
      console.log("🟢 Resuming looking for new tokens..\n");
      return;
    }

    // Add initial delay before first buy
    await new Promise((resolve) => setTimeout(resolve, config.tx.swap_tx_initial_delay));

    // Create Swap transaction with retry
    let tx = null;
    retryCount = 0;
    
    while (!tx && retryCount < maxRetries) {
      try {
        tx = await createSwapTransaction(data.solMint, data.tokenMint);
        if (!tx) {
          retryCount++;
          await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
        }
      } catch (error) {
        console.error(`Error creating swap transaction (attempt ${retryCount + 1}/${maxRetries}):`, error);
        retryCount++;
        if (retryCount < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
        }
      }
    }

    if (!tx) {
      console.log("⛔ Transaction aborted. Failed to create swap transaction after retries.");
      console.log("🟢 Resuming looking for new tokens...\n");
      return;
    }

    // Output logs
    console.log("🚀 Swapping SOL for Token.");
    console.log("Swap Transaction: ", "https://solscan.io/tx/" + tx);

    // Fetch and store the transaction for tracking purposes
    const saveConfirmation = await fetchAndSaveSwapDetails(tx);
    if (!saveConfirmation) {
      console.log("❌ Warning: Transaction not saved for tracking! Track Manually!");
    }

    const processingTime = performance.now() - start;
    /*
    metrics.transactions.avgProcessingTime = 
        (metrics.transactions.avgProcessingTime * (metrics.transactions.total - 1) + processingTime) 
        / metrics.transactions.total;
    metrics.transactions.maxProcessingTime = Math.max(metrics.transactions.maxProcessingTime, processingTime);
    metrics.transactions.minProcessingTime = Math.min(metrics.transactions.minProcessingTime, processingTime);
    */

    // We've already sent alerts above, so we can skip this duplicated alert logic
    // This entire block is redundant since we're already sending alerts earlier
    /* 
    // Send token alerts to both Discord and Telegram
    if (rugCheckPassed && data.tokenMint) {
        try {
            // Fetch all necessary data in parallel for both Discord and Telegram
            const [tokenDataResult, trenchDataResult, sniperDataResult] = await Promise.allSettled([
                getTokenMarketData(data.tokenMint),
                fetchTrenchData(data.tokenMint),
                fetchSniperData(data.tokenMint)
            ]);
            
            // Safely extract data from results
            const tokenData = tokenDataResult.status === 'fulfilled' ? tokenDataResult.value : null;
            const trenchDataValue = trenchDataResult.status === 'fulfilled' ? trenchDataResult.value : {
                holdingBundles: 0,
                totalBundles: 0,
                holdingPercentage: 0,
                totalSolSpent: 0,
                ticker: null
            };
            const sniperData = sniperDataResult.status === 'fulfilled' ? sniperDataResult.value : null;
            
            // Get token name and ticker from Moralis data if available
            const tokenName = tokenData?.metadata?.name || trenchDataValue.ticker?.toUpperCase() || 'UNKNOWN';
            const tokenSymbol = tokenData?.metadata?.symbol || trenchDataValue.ticker?.toUpperCase() || 'UNKNOWN';
            
            // Format data for market stats
            const liquidityInSol = tokenData?.liquidity ? tokenData.liquidity / tokenData.price : 0;
            
            // Create market data for Telegram
            const marketData = {
                marketCap: tokenData?.marketCap ? formatMarketCap(tokenData.marketCap) : '$50.33K',
                volume24h: tokenData?.volume24h ? formatVolume(tokenData.volume24h) : '$2.44K',
                bundles: trenchDataValue && trenchDataValue.holdingBundles && trenchDataValue.totalBundles 
                    ? `${trenchDataValue.holdingBundles}/${trenchDataValue.totalBundles}` 
                    : '24/63',
                percentage: trenchDataValue && trenchDataValue.holdingPercentage 
                    ? `${trenchDataValue.holdingPercentage}%` 
                    : '27.52%',
                solSpent: trenchDataValue && trenchDataValue.totalSolSpent 
                    ? `◎${trenchDataValue.totalSolSpent}` 
                    : '◎169.62'
            };
            
            console.log(`Sending alerts with real market data for ${data.tokenMint}:`, marketData);
            
            // Send alerts with the fetched data
            await sendTokenAlerts(
                data.tokenMint,
                tokenName,
                tokenSymbol,
                signature,
                liquidityInSol,
                rugCheckPassed,
                marketData
            );
        } catch (error) {
            console.error("Error fetching token market data:", error);
            
            // Fallback to default values if we couldn't fetch real data
            const tokenName = "Unknown Token";
            const tokenSymbol = "UNKNOWN";
            const liquidityInSol = 0;
            
            // Default market data
            const marketData = {
                marketCap: '$50.33K',
                volume24h: '$2.44K',
                bundles: '24/63',
                percentage: '27.52%',
                solSpent: '◎169.62'
            };
            
            await sendTokenAlerts(
                data.tokenMint,
                tokenName,
                tokenSymbol,
                signature,
                liquidityInSol,
                rugCheckPassed,
                marketData
            );
        }
    }
    */

  } catch (error) {
    console.error("Error processing transaction:", error);
    /*
    metrics.transactions.failed++;
    metrics.errors.count++;
    metrics.errors.lastError = error instanceof Error ? error.message : 'Unknown error';
    metrics.errors.lastErrorTime = new Date();
    */
    throw error; // Re-throw to be caught by the caller
  }
}

// Websocket Handler for listening to the Solana logSubscribe method
let init = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_INTERVAL = 5000; // 5 seconds

async function websocketHandler(): Promise<void> {
  const env = validateEnv();
  let ws: WebSocket | null = new WebSocket(env.HELIUS_WSS_URI);
  
  if (!init) console.clear();
  // metrics.websocket.connections++;

  // Reset reconnect attempts when successfully connected
  ws.on("open", () => {
    reconnectAttempts = 0;
    if (ws) {
      sendSubscribeRequest(ws);
      console.log("\n🔓 WebSocket is open and listening for high-WSOL pool creations.");
      init = true;
    }
  });

  // Add ping/pong to keep connection alive
  const pingInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, 30000); // Send ping every 30 seconds

  ws.on("pong", () => {
    // Connection is still alive
  });

  // Logic for the message event for the .on event listener
  ws.on("message", async (data: WebSocket.Data) => {
    const messageStart = performance.now();
    
    try {
      const jsonString = data.toString();
      const parsedData = JSON.parse(jsonString);

      // Handle subscription response
      if (parsedData.result !== undefined && !parsedData.error) {
        console.log("✅ Subscription confirmed");
        return;
      }

      if (parsedData.error) {
        /*
        metrics.errors.count++;
        metrics.errors.lastError = parsedData.error;
        metrics.errors.lastErrorTime = new Date();
        */
        console.error("🚫 RPC Error:", parsedData.error);
        return;
      }

      const logs = parsedData?.params?.result?.value?.logs;
      const signature = parsedData?.params?.result?.value?.signature;

      if (!Array.isArray(logs) || !signature || typeof signature !== "string") return;

      // Check for duplicate signature
      if (processedSignatures.has(signature)) {
        console.log(`⏭️ Skipping duplicate transaction: ${signature}`);
        return;
      }

      // Add signature to processed set
      processedSignatures.add(signature);
      if (processedSignatures.size > MAX_PROCESSED_SIGNATURES) {
        const firstSignature = processedSignatures.values().next().value;
        if (firstSignature) {
          processedSignatures.delete(firstSignature);
        }
      }

      // Check for pool creation instructions from any enabled pool, keeping
      // a reference to which pool matched (needed to classify the
      // intelligence event's source below without changing this filter's
      // existing behavior).
      const matchedPool = config.liquidity_pool
        .filter(pool => pool.enabled)
        .find(pool =>
          typeof pool.instruction === "string" &&
          logs.some((log: string) => typeof log === "string" && log.includes(pool.instruction as string))
        );

      if (!matchedPool) return;

      console.log(`Detected pool creation/migration transaction: ${signature}`);
      console.log(`Solscan: https://solscan.io/tx/${signature}`);
      
      // Get token mint from transaction
      const tokenData = await fetchTokenMintFromTx(signature, connection);
      if (!tokenData) {
        console.log("⏭️ Could not extract token mint from transaction");
        return;
      }

      console.log("🔎 Detected new pool initialization");
      console.log(`Token Mint: ${tokenData.tokenMint}`);
      console.log(`Transaction: https://solscan.io/tx/${signature}`);

      // Non-blocking: dispatch to the token intelligence pipeline alongside
      // (not instead of) the existing alert/trading flow below. Does not
      // await, does not share the activeTransactions gate, and cannot throw
      // back into this handler.
      if (tokenData.tokenMint) {
        dispatchTokenIntelligence(signature, tokenData.tokenMint, matchedPool.program, parsedData?.params?.result?.value);
      }

      // Verify if we have reached the max concurrent transactions
      if (activeTransactions >= MAX_CONCURRENT) {
        // metrics.transactions.skipped++;
        console.log("⏳ Max concurrent transactions reached, skipping...");
        return;
      }

      activeTransactions++;

      const processStart = performance.now();
      
      try {
        await processTransaction(signature);
        // metrics.transactions.successful++;
        
        const processingTime = performance.now() - processStart;
        /*
        metrics.transactions.avgProcessingTime = 
            (metrics.transactions.avgProcessingTime * (metrics.transactions.total - 1) + processingTime) 
            / metrics.transactions.total;
        metrics.transactions.maxProcessingTime = Math.max(metrics.transactions.maxProcessingTime, processingTime);
        metrics.transactions.minProcessingTime = Math.min(metrics.transactions.minProcessingTime, processingTime);
        */
      } catch (error) {
        /*
        metrics.transactions.failed++;
        metrics.errors.count++;
        metrics.errors.lastError = error instanceof Error ? error.message : 'Unknown error';
        metrics.errors.lastErrorTime = new Date();
        */
        console.error("Error processing transaction:", error);
      } finally {
        activeTransactions--;
      }

      // Update performance metrics
      // metrics.performance.lastMinute.transactions++;

      // Log performance stats every minute
      /*
      if (Date.now() - metrics.performance.lastMinute.startTime > 60000) {
        console.log(`
📊 Last Minute Performance:
• Transactions Processed: ${metrics.performance.lastMinute.transactions}
• Average Processing Time: ${metrics.transactions.avgProcessingTime.toFixed(2)}ms
• Success Rate: ${((metrics.transactions.successful / metrics.transactions.total) * 100).toFixed(2)}%
• Memory Usage: ${(metrics.performance.memoryUsage.heapUsed / 1024 / 1024).toFixed(2)}MB
        `);

        metrics.performance.lastMinute.transactions = 0;
        metrics.performance.lastMinute.startTime = Date.now();
      }
      */

    } catch (error) {
      /*
      metrics.errors.count++;
      metrics.errors.lastError = error instanceof Error ? error.message : 'Unknown error';
      metrics.errors.lastErrorTime = new Date();
      */
      console.error("💥 Error processing message:", error);
    }
  });

  ws.on("close", () => {
    clearInterval(pingInterval);
    // metrics.websocket.reconnects++;
    // metrics.websocket.lastReconnect = new Date();
    
    console.log("📴 WebSocket connection closed, cleaning up...");
    if (ws) {
      ws.removeAllListeners();
      ws = null;
    }

    reconnectAttempts++;
    if (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
      const delay = RECONNECT_INTERVAL * Math.pow(2, reconnectAttempts - 1); // Exponential backoff
      console.log(`🔄 Attempting to reconnect (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}) in ${delay/1000} seconds...`);
      setTimeout(websocketHandler, delay);
    } else {
      console.error("❌ Max reconnection attempts reached. Please check your connection or contact support.");
      process.exit(1); // Exit the process to allow process manager to restart
    }
  });

  // Add specific error handling
  ws.on("error", (err: Error) => {
    /*
    metrics.errors.count++;
    metrics.errors.lastError = err.message;
    metrics.errors.lastErrorTime = new Date();
    */
    console.error("WebSocket error:", err);
    
    // Force close the connection on error to trigger reconnect
    if (ws) {
      ws.terminate();
    }
  });
}

// Start Socket Handler
websocketHandler().catch((err) => {
  console.error(err.message);
});

// Set up periodic PnL checking
startPeriodicChecks(client);

// Schedule daily top tokens reports
scheduleDailyTopTokensReport(client, telegramBot);

console.log('📊 PnL tracking system initialized');
console.log('🏆 Daily top tokens reporting scheduled');

async function handleWebsocketMessage(message: any) {
    try {
        const { params } = message;
        if (!params || !params.result || !params.result.value) return;

        const { signature, logs } = params.result.value;
        if (!Array.isArray(logs) || typeof signature !== "string") return;

        // Check for Create_pool instruction
        const createPoolLog = logs.find((log: string) => 
            typeof log === "string" && 
            log.includes("Program log: initialize2: InitializeInstruction2")
        );

        if (createPoolLog) {
            console.log("New pool detected!");
            console.log("Transaction:", `https://solscan.io/tx/${signature}`);

            // Extract token mint from logs
            const tokenMint = getTokenMintFromLogs(logs);
            if (!tokenMint) {
                console.log("Could not extract token mint from logs");
                return;
            }

            console.log("Token Mint:", tokenMint);

            // Auto-buy is inherently incompatible with the non-custodial signing
            // model used everywhere else in this bot (see ARCHITECTURE.md §8) —
            // there is no private key here to sign an unattended buy with. This
            // only logs candidates; it has never actually executed anything
            // (this whole function, handleWebsocketMessage, is dead code — it is
            // defined but never called anywhere in this file).
            const users = await jupiterService.getUsersWithAutoBuy();
            for (const user of users) {
                console.log(`Auto-buy is enabled for user ${user.userId} but requires their own wallet approval — no automatic execution is possible.`);
            }
        }
    } catch (error) {
        console.error("Error handling websocket message:", error);
    }
}

// Define an interface for prefetched data
interface PrefetchedTokenData {
  tokenData: any;
  trenchData: any;
  sniperData: any;
  isPumpToken: boolean;
  marketCap?: number;
  price?: number;
}

// Function to send token alerts to both Discord and Telegram
async function sendTokenAlerts(
    tokenAddress: string,
    tokenName: string,
    tokenSymbol: string,
    signature: string,
    liquidityInSol: number,
    rugCheckPassed: boolean = true,
    marketData = {
        marketCap: '',
        volume24h: '',
        bundles: '',
        percentage: '',
        solSpent: ''
    }
): Promise<void> {
    try {
        console.log(`🔍 Fetching complete token data for ${tokenAddress}...`);
        
        // Check if this is a Pump.fun token
        const isPumpToken = tokenAddress.toLowerCase().endsWith('pump');
        console.log(`Token ${tokenAddress} is ${isPumpToken ? 'a Pump.fun token' : 'not a Pump.fun token'}`);
        
        // Set migration token flag directly if enabled in config
        let isMigrationToken = false;
        
        // If PumpSwap is enabled, treat tokens as migration tokens
        if (config.pumpswap && config.pumpswap.enabled) {
            console.log(`👉 PumpSwap is enabled - treating as migration token`);
            isMigrationToken = true;
        }

        // Generate buy link 
        const buyLink = `https://jup.ag/swap/SOL-${tokenAddress}`;
        
        // For all tokens, fetch data once for both platforms
        console.log(`Fetching data for ${tokenAddress} (${isPumpToken ? 'Pump token' : 'non-Pump token'})...`);
        
        // First, verify market cap once for faster processing
        console.log(`🔍 Verifying market cap for ${tokenAddress} (single verification for all alerts)...`);
        const verifiedMarketCap = await doubleCheckMarketCap(tokenAddress);
        
        // If market cap is below minimum threshold, skip all alerts
        if (verifiedMarketCap < MINIMUM_MARKET_CAP) {
            console.log(`⚠️ Market cap ($${verifiedMarketCap.toLocaleString()}) is below minimum threshold ($${MINIMUM_MARKET_CAP.toLocaleString()}). Skipping all alerts.`);
            return;
        }
        
        // Get latest price once
        console.log(`Fetching latest price for ${tokenAddress} (single fetch for all alerts)...`);
        const latestPrice = await fetchLatestPrice(tokenAddress);
        
        // Fetch all necessary data in parallel
        const [tokenDataResult, trenchResult, sniperDataResult] = await Promise.allSettled([
            getTokenMarketData(tokenAddress),
            fetchTrenchData(tokenAddress),
            fetchSniperData(tokenAddress)
        ]);
        
        // Safely extract data from results
        const tokenData = tokenDataResult.status === 'fulfilled' ? tokenDataResult.value : null;
        const trenchData = trenchResult.status === 'fulfilled' ? trenchResult.value : {
            holdingBundles: 0,
            totalBundles: 0,
            holdingPercentage: 0,
            totalSolSpent: 0,
            ticker: null
        };
        const sniperData = sniperDataResult.status === 'fulfilled' ? sniperDataResult.value : null;
        
        // Get token name and ticker from trench data if available
        const enrichedTokenName = tokenData?.metadata?.name || trenchData.ticker?.toUpperCase() || tokenName;
        const enrichedTokenSymbol = tokenData?.metadata?.symbol || trenchData.ticker?.toUpperCase() || tokenSymbol;
        
        // Calculate liquidity if available
        let enrichedLiquidityInSol = liquidityInSol;
        if (tokenData?.liquidity && tokenData.price) {
            enrichedLiquidityInSol = tokenData.liquidity / tokenData.price;
        }
        
        // Prepare enriched market data
        const enrichedMarketData = {
            marketCap: verifiedMarketCap > 0 ? formatMarketCap(verifiedMarketCap) : marketData.marketCap,
            volume24h: tokenData?.volume24h ? formatVolume(tokenData.volume24h) : marketData.volume24h,
            bundles: trenchData && trenchData.holdingBundles && trenchData.totalBundles 
                ? `${trenchData.holdingBundles}/${trenchData.totalBundles}` 
                : marketData.bundles,
            percentage: trenchData && trenchData.holdingPercentage 
                ? `${trenchData.holdingPercentage}%` 
                : marketData.percentage,
            solSpent: trenchData && trenchData.totalSolSpent 
                ? `◎${trenchData.totalSolSpent}` 
                : marketData.solSpent
        };
        
        console.log(`Data fetched successfully for ${tokenAddress}:
        - Token Name: ${enrichedTokenName}
        - Token Symbol: ${enrichedTokenSymbol}
        - Liquidity: ${enrichedLiquidityInSol} SOL
        - Market Cap: $${verifiedMarketCap.toLocaleString()}
        - Price: ${latestPrice}
        - Volume: ${enrichedMarketData.volume24h}
        - Bundles: ${enrichedMarketData.bundles}
        - Percentage: ${enrichedMarketData.percentage}
        - SOL Spent: ${enrichedMarketData.solSpent}
        `);

        // Send Discord alert only for Pump tokens
        if (isPumpToken) {
            try {
                console.log(`🎮 DISCORD: Sending alert for Pump token: ${tokenAddress}`);
                
                // Prepare data to pass to Discord alert function - include market cap and price
                const prefetchedData: PrefetchedTokenData = {
                    tokenData,
                    trenchData,
                    sniperData,
                    isPumpToken,
                    marketCap: verifiedMarketCap,
                    price: latestPrice
                };
                
                await sendTokenAlert(
                    tokenAddress,
                    rugCheckPassed,
                    prefetchedData
                );
                console.log(`🎮 DISCORD: ✅ Successfully sent Discord alert for token: ${tokenAddress}`);
            } catch (error) {
                console.error('🎮 DISCORD: 💥 Error sending Discord alert:', error);
            }
        } else {
            console.log(`🎮 DISCORD: Skipping Discord alert for non-Pump token: ${tokenAddress}`);
        }

        // Send Telegram alert for all tokens
        try {
            console.log(`📱 TELEGRAM: Sending alert for token: ${tokenAddress}`);
            
            // Only proceed if token passes rug check
            if (!rugCheckPassed) {
                console.log(`📱 TELEGRAM: ⚠️ Token ${tokenAddress} did not pass rug check, skipping Telegram alert`);
                return;
            }
            
            // Send the complete enriched data to Telegram
            console.log(`📱 TELEGRAM: Calling sendTokenAlert with enriched data for ${tokenAddress}`);
            await telegramBot.sendTokenAlert(
                tokenAddress,
                enrichedTokenName,
                enrichedTokenSymbol,
                enrichedLiquidityInSol,
                buyLink,
                isMigrationToken,
                enrichedMarketData.marketCap,
                enrichedMarketData.volume24h,
                enrichedMarketData.bundles,
                enrichedMarketData.percentage,
                enrichedMarketData.solSpent
            );
            console.log(`📱 TELEGRAM: ✅ Successfully sent Telegram alert for token: ${tokenAddress}`);
        } catch (error) {
            console.error(`📱 TELEGRAM: 💥 Error sending Telegram alert:`, error);
        }
        
        // Broadcast token alert to WebSocket clients
        try {
            console.log(`🔌 WEBSOCKET: Broadcasting token alert for ${tokenAddress}`);
            
            // Create structured token alert data
            const tokenAlertData: TokenAlertData = {
                tokenAddress,
                tokenName: enrichedTokenName,
                tokenSymbol: enrichedTokenSymbol,
                price: latestPrice,
                marketCap: enrichedMarketData.marketCap,
                liquidityInSol: enrichedLiquidityInSol,
                volume24h: enrichedMarketData.volume24h,
                rugCheckPassed,
                timestamp: Date.now(),
                transactionSignature: signature,
                buyLink,
                isMigrationToken,
                bundles: enrichedMarketData.bundles,
                percentage: enrichedMarketData.percentage,
                solSpent: enrichedMarketData.solSpent
            };
            
            const broadcastResult = broadcastTokenAlert(tokenAlertData);
            console.log(`🔌 WEBSOCKET: ${broadcastResult ? '✅ Successfully broadcast' : '⚠️ No clients connected'} token alert for: ${tokenAddress}`);
        } catch (error) {
            console.error(`🔌 WEBSOCKET: 💥 Error broadcasting token alert:`, error);
        }
    } catch (error) {
        console.error(`💥 Error in sendTokenAlerts:`, error);
    }
}

async function main() {
  // Log the environment
  console.log(`
  🔷 Solana Sniper Bot Starting...
  ⚙️ Environment: ${process.env.NODE_ENV || 'development'}
  🚀 Web3 Provider: ${process.env.HELIUS_HTTPS_URI?.substring(0, 25)}...
  `);

  // Off by default (see ARCHITECTURE.md §8.3) — src/api/index.ts binds
  // 0.0.0.0 by default and, even with API_AUTH_TOKEN set, exposes wallet
  // and trading-request endpoints. Require an explicit opt-in.
  if (isApiServerEnabled()) {
    try {
      console.log('🔌 API_ENABLED=true — starting API server with bot...');
      initApiServer();
      console.log('✅ API server initialized successfully');
    } catch (error) {
      console.error('❌ Failed to initialize API server:', error);
      console.log('⚠️ Continuing bot startup without API server');
    }
  } else {
    console.log('🔌 API server not started (API_ENABLED is not "true"). Run with API_ENABLED=true, or separately with `npm run api:server` for the read-only status API.');
  }

  // Initialize Discord client
  try {
    await client.login(process.env.DISCORD_BOT_TOKEN);
    console.log('✅ Discord client initialized successfully');
  } catch (error) {
    console.error('Failed to initialize Discord client:', error);
  }

  // Telegram bot is already initialized at the top of the file
  // No need to initialize it again
  
  // Start periodic checks
  startPeriodicChecks(client);
  
  // Start WebSocket connection for listening to new tokens
  websocketHandler();
  
  // Schedule daily top tokens report
  scheduleDailyTopTokensReport(client, telegramBot);
}

// Start the bot
main().catch(console.error);