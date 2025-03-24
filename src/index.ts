import WebSocket from "ws"; // Node.js websocket library
import { WebSocketRequest } from "./types"; // Typescript Types for type safety
import { config } from "./config"; // Configuration parameters for our bot
import { fetchTransactionDetails, createSwapTransaction, getRugCheckConfirmed, fetchAndSaveSwapDetails, fetchTokenMintFromTx } from "./transactions";
import { validateEnv } from "./utils/env-validator";
import player from "play-sound";
import { sendTokenAlert } from './discord/discord';
import { performance } from 'perf_hooks';
import express from 'express';
import { Connection, PublicKey } from "@solana/web3.js";
import { MintsDataReponse } from "./types";
import { checkTokenPnL, startPeriodicChecks } from './services/tokenTrackingService';
import { client } from './discord/discord';
import { sniperooService } from './services/sniperooService';

const audioPlayer = player({});

// Regional Variables
let activeTransactions = 0;
const MAX_CONCURRENT = config.tx.concurrent_transactions;

const connection = new Connection(process.env.HELIUS_HTTPS_URI || "");

// Add at the top with other regional variables
const processedSignatures = new Set<string>();
const MAX_PROCESSED_SIGNATURES = 1000; // Keep last 1000 signatures

// Performance metrics object
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

// Setup Express server for metrics
const app = express();
app.get('/metrics', (req, res) => {
    metrics.performance.uptime = process.uptime();
    metrics.performance.memoryUsage = process.memoryUsage();
    res.json(metrics);
});

const metricsPort = process.env.METRICS_PORT || 3030;
app.listen(metricsPort, () => {
    console.log(`📊 Metrics server running on port ${metricsPort}`);
});

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
      metrics.transactions.failed++;
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
      
      // Send Discord notification for non-Pump tokens (will be filtered in sendTokenAlert)
      await sendTokenAlert(data.tokenMint, false);
      
      console.log("🟢 Resuming looking for new tokens..\n");
      return;
    }

    // Track rug check metrics (only for Pump.fun tokens)
    metrics.rugCheck.total++;
    const rugCheckStart = performance.now();
    const isRugCheckPassed = await getRugCheckConfirmed(data.tokenMint);
    rugCheckPassed = isRugCheckPassed;
    
    const rugCheckTime = performance.now() - rugCheckStart;
    metrics.rugCheck.avgCheckTime = 
        (metrics.rugCheck.avgCheckTime * (metrics.rugCheck.total - 1) + rugCheckTime) 
        / metrics.rugCheck.total;

    if (!isRugCheckPassed) {
      metrics.rugCheck.failed++;
      console.log(`🚫 Rug Check failed for token: ${data.tokenMint}`);
      console.log("🚫 Rug Check not passed! Transaction aborted.");
      return;
    }
    metrics.rugCheck.passed++;

    // Output logs
    console.log("Token found");
    console.log("👽 GMGN: https://gmgn.ai/sol/token/" + data.tokenMint);
    console.log("😈 BullX: https://neo.bullx.io/terminal?chainId=1399811149&address=" + data.tokenMint);
    console.log("🌌 Axiom: https://axiom.trade/t/" + data.tokenMint);

    // Only send Discord notification if it's a valid token
    await sendTokenAlert(data.tokenMint, isRugCheckPassed);

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
    metrics.transactions.avgProcessingTime = 
        (metrics.transactions.avgProcessingTime * (metrics.transactions.total - 1) + processingTime) 
        / metrics.transactions.total;
    metrics.transactions.maxProcessingTime = Math.max(metrics.transactions.maxProcessingTime, processingTime);
    metrics.transactions.minProcessingTime = Math.min(metrics.transactions.minProcessingTime, processingTime);

  } catch (error) {
    console.error("Error processing transaction:", error);
    metrics.transactions.failed++;
    metrics.errors.count++;
    metrics.errors.lastError = error instanceof Error ? error.message : 'Unknown error';
    metrics.errors.lastErrorTime = new Date();
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
  metrics.websocket.connections++;

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
        metrics.errors.count++;
        metrics.errors.lastError = parsedData.error;
        metrics.errors.lastErrorTime = new Date();
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

      // Check for pool creation instructions from any enabled pool
      const liquidityPoolInstructions = config.liquidity_pool
        .filter(pool => pool.enabled)
        .map(pool => pool.instruction);
      
      const containsCreate = logs.some((log: string) => 
        typeof log === "string" && 
        liquidityPoolInstructions.some(instruction => instruction && log.includes(instruction))
      );

      if (!containsCreate) return;

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

      // Verify if we have reached the max concurrent transactions
      if (activeTransactions >= MAX_CONCURRENT) {
        metrics.transactions.skipped++;
        console.log("⏳ Max concurrent transactions reached, skipping...");
        return;
      }

      activeTransactions++;

      const processStart = performance.now();
      
      try {
        await processTransaction(signature);
        metrics.transactions.successful++;
        
        const processingTime = performance.now() - processStart;
        metrics.transactions.avgProcessingTime = 
            (metrics.transactions.avgProcessingTime * (metrics.transactions.total - 1) + processingTime) 
            / metrics.transactions.total;
        metrics.transactions.maxProcessingTime = Math.max(metrics.transactions.maxProcessingTime, processingTime);
        metrics.transactions.minProcessingTime = Math.min(metrics.transactions.minProcessingTime, processingTime);
        
      } catch (error) {
        metrics.transactions.failed++;
        metrics.errors.count++;
        metrics.errors.lastError = error instanceof Error ? error.message : 'Unknown error';
        metrics.errors.lastErrorTime = new Date();
        console.error("Error processing transaction:", error);
      } finally {
        activeTransactions--;
      }

      // Update performance metrics
      metrics.performance.lastMinute.transactions++;

      // Log performance stats every minute
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

    } catch (error) {
      metrics.errors.count++;
      metrics.errors.lastError = error instanceof Error ? error.message : 'Unknown error';
      metrics.errors.lastErrorTime = new Date();
      console.error("💥 Error processing message:", error);
    }
  });

  ws.on("close", () => {
    clearInterval(pingInterval);
    metrics.websocket.reconnects++;
    metrics.websocket.lastReconnect = new Date();
    
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
    metrics.errors.count++;
    metrics.errors.lastError = err.message;
    metrics.errors.lastErrorTime = new Date();
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

console.log('📊 PnL tracking system initialized');

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

            // Get all users with auto-buy enabled
            const users = await sniperooService.getUsersWithAutoBuy();
            for (const user of users) {
                try {
                    const success = await sniperooService.buyToken(tokenMint, user.userId);
                    if (success) {
                        console.log(`Auto-buy successful for user ${user.userId}`);
                    } else {
                        console.log(`Auto-buy failed for user ${user.userId}`);
                    }
                } catch (error) {
                    console.error(`Error auto-buying for user ${user.userId}:`, error);
                }
            }
        }
    } catch (error) {
        console.error("Error handling websocket message:", error);
    }
}
