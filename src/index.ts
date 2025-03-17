import WebSocket from "ws"; // Node.js websocket library
import { WebSocketRequest } from "./types"; // Typescript Types for type safety
import { config } from "./config"; // Configuration parameters for our bot
import { fetchTransactionDetails, createSwapTransaction, getRugCheckConfirmed, fetchAndSaveSwapDetails, fetchTokenMintFromTx } from "./transactions";
import { validateEnv } from "./utils/env-validator";
import player from "play-sound";
import { sendTokenAlert } from './discord/discord';
import { performance } from 'perf_hooks';
import express from 'express';
import { Connection } from "@solana/web3.js";
import { MintsDataReponse } from "./types";
import { checkTokenPnL, startPeriodicChecks } from './services/tokenTrackingService';
import { client } from './discord/discord';

const audioPlayer = player({});

// Regional Variables
let activeTransactions = 0;
const MAX_CONCURRENT = config.tx.concurrent_transactions;

const connection = new Connection(process.env.HELIUS_HTTPS_URI || "");

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
  const request: WebSocketRequest = {
    jsonrpc: "2.0",
    id: 1,
    method: "logsSubscribe",
    params: [
      {
        mentions: [config.liquidity_pool.radiyum_program_id],
      },
      {
        commitment: "processed", // Can use finalized to be more accurate.
      },
    ],
  };
  ws.send(JSON.stringify(request));
}

export let rugCheckPassed: boolean;
// Function used to handle the transaction once a new pool creation is found
async function processTransaction(signature: string): Promise<void> {
  const start = performance.now();
  
  // Output logs
  console.log("=============================================");
  console.log("🔎 New Liquidity Pool found.");
  console.log("🔃 Fetching transaction details ...");

  // Fetch the transaction details
  let data: MintsDataReponse | null;
  //data = await fetchTransactionDetails(signature, connection);
  data = await fetchTokenMintFromTx(signature, connection);
  if (!data) {
    metrics.transactions.failed++;
    console.log("⛔ Transaction aborted. No data returned.");
    return;
  }

  // Ensure required data is available
  if (!data.solMint || !data.tokenMint) return;

  // Check if this is a Pump.fun token
  const isPumpToken = data.tokenMint.toLowerCase().endsWith('pump');
  console.log(`Token ${data.tokenMint} is ${isPumpToken ? 'a Pump.fun token' : 'not a Pump.fun token'}`);
  
  // Skip rug check for non-Pump.fun tokens
  if (!isPumpToken) {
    console.log(`⏭️ Skipping rug check for non-Pump.fun token: ${data.tokenMint}`);
    
    // Ouput logs
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

  // Ouput logs
  console.log("Token found");
  console.log("👽 GMGN: https://gmgn.ai/sol/token/" + data.tokenMint);
  console.log("😈 BullX: https://neo.bullx.io/terminal?chainId=1399811149&address=" + data.tokenMint);
  console.log("🌌 Axiom: https://axiom.trade/t/" + data.tokenMint);

  // Play notification sound for found token
  // try {
  //   console.log("🔊 Playing notification sound");
  //   audioPlayer.play("src/sounds/notification.wav", (err) => {
  //     if (err) console.error("Error playing sound:", err);
  //   });
  // } catch (error) {
  //   console.error("Failed to play notification sound:", error);
  // }

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

  // Create Swap transaction
  const tx = await createSwapTransaction(data.solMint, data.tokenMint);
  if (!tx) {
    console.log("⛔ Transaction aborted.");
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
}

// Websocket Handler for listening to the Solana logSubscribe method
let init = false;
async function websocketHandler(): Promise<void> {
  const env = validateEnv();
  let ws: WebSocket | null = new WebSocket(env.HELIUS_WSS_URI);
  
  if (!init) console.clear();
  metrics.websocket.connections++;

  // @TODO, test with hosting our app on a Cloud instance closer to the RPC nodes physical location for minimal latency
  // @TODO, test with different RPC and API nodes (free and paid) from quicknode and shyft to test speed

  // Send subscription to the websocket once the connection is open
  ws.on("open", () => {
    // Subscribe
    if (ws) sendSubscribeRequest(ws); // Send a request once the WebSocket is open
    console.log("\n🔓 WebSocket is open and listening.");
    init = true;
  });

  // Logic for the message event for the .on event listener
  ws.on("message", async (data: WebSocket.Data) => {
    const messageStart = performance.now();
    
    try {
      const jsonString = data.toString(); // Convert data to a string
      const parsedData = JSON.parse(jsonString); // Parse the JSON string

      // Handle subscription response
      if (parsedData.result !== undefined && !parsedData.error) {
        console.log("✅ Subscription confirmed");
        return;
      }

      // Only log RPC errors for debugging
      if (parsedData.error) {
        metrics.errors.count++;
        metrics.errors.lastError = parsedData.error;
        metrics.errors.lastErrorTime = new Date();
        console.error("🚫 RPC Error:", parsedData.error);
        return;
      }

      // Safely access the nested structure
      const logs = parsedData?.params?.result?.value?.logs;
      const signature = parsedData?.params?.result?.value?.signature;

      // Validate `logs` is an array and if we have a signtature
      if (!Array.isArray(logs) || !signature) return;

      // Verify if this is a new pool creation
      const containsCreate = logs.some((log: string) => typeof log === "string" && log.includes("Program log: initialize2: InitializeInstruction2"));
      if (!containsCreate || typeof signature !== "string") return;

      // Verify if we have reached the max concurrent transactions
      if (activeTransactions >= MAX_CONCURRENT) {
        metrics.transactions.skipped++;
        console.log("⏳ Max concurrent transactions reached, skipping...");
        return;
      }

      // Add additional concurrent transaction
      activeTransactions++;

      // Process transaction with performance monitoring
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

  ws.on("error", (err: Error) => {
    metrics.errors.count++;
    metrics.errors.lastError = err.message;
    metrics.errors.lastErrorTime = new Date();
    console.error("WebSocket error:", err);
  });

  ws.on("close", () => {
    metrics.websocket.reconnects++;
    metrics.websocket.lastReconnect = new Date();
    console.log("📴 WebSocket connection closed, cleaning up...");
    if (ws) {
      ws.removeAllListeners();
      ws = null;
    }
    console.log("🔄 Attempting to reconnect in 5 seconds...");
    setTimeout(websocketHandler, 5000);
  });
}

// Start Socket Handler
websocketHandler().catch((err) => {
  console.error(err.message);
});

// Set up periodic PnL checking
startPeriodicChecks(client);

console.log('📊 PnL tracking system initialized');
