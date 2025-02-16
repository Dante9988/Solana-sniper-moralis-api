import express from 'express';
import cors from 'cors';
import WebSocket from 'ws';
import bodyParser from 'body-parser';
import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import { config } from './config';
import { validateEnv } from "./utils/env-validator";
import { WebSocketRequest } from "./types";
import { 
  fetchTransactionDetails, 
  createSwapTransaction, 
  getRugCheckConfirmed,
  fetchAndSaveSwapDetails 
} from './transactions';
import player from "play-sound";

const HOST = "0.0.0.0";
const PORT = 9090;

const app = express();
app.use(bodyParser.json());
const audioPlayer = player({ player: "mplayer" });

// Middleware
app.use(cors());

// Store active WebSocket connections and state
let activeWS: WebSocket | null = null;
let isListening = false;
let activeTransactions = 0;
const MAX_CONCURRENT = config.tx.concurrent_transactions;

// WebSocket helper functions
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
        commitment: "processed",
      },
    ],
  };
  ws.send(JSON.stringify(request));
}

// Transaction processing function
async function processTransaction(signature: string): Promise<void> {
  console.log("=============================================");
  console.log("🔎 New Liquidity Pool found.");
  console.log("🔃 Fetching transaction details ...");

  const data = await fetchTransactionDetails(signature);
  if (!data) {
    console.log("⛔ Transaction aborted. No data returned.");
    console.log("🟢 Resuming looking for new tokens...\n");
    return;
  }

  if (!data.solMint || !data.tokenMint) return;

  const isRugCheckPassed = await getRugCheckConfirmed(data.tokenMint);
  if (!isRugCheckPassed) {
    console.log("View Token");
    try {
      audioPlayer.play("./sounds/notification.wav", (err) => {
        if (err) console.error("Error playing sound:", err);
      });
    } catch (error) {
      console.error("Failed to play notification sound:", error);
    }
    console.log("👽 GMGN: https://gmgn.ai/sol/token/" + data.tokenMint);
    console.log("😈 BullX: https://neo.bullx.io/terminal?chainId=1399811149&address=" + data.tokenMint);
    console.log("🚫 Rug Check not passed! Transaction aborted.");
    console.log("🟢 Resuming looking for new tokens...\n");
    return;
  }

  console.log("Token found");
  console.log("👽 GMGN: https://gmgn.ai/sol/token/" + data.tokenMint);
  console.log("😈 BullX: https://neo.bullx.io/terminal?chainId=1399811149&address=" + data.tokenMint);

  if (config.rug_check.simulation_mode) {
    console.log("👀 Token not swapped. Simulation mode is enabled.");
    console.log("🟢 Resuming looking for new tokens..\n");
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, config.tx.swap_tx_initial_delay));

  const tx = await createSwapTransaction(data.solMint, data.tokenMint);
  if (!tx) {
    console.log("⛔ Transaction aborted.");
    console.log("🟢 Resuming looking for new tokens...\n");
    return;
  }

  console.log("🚀 Swapping SOL for Token.");
  console.log("Swap Transaction: ", "https://solscan.io/tx/" + tx);

  const saveConfirmation = await fetchAndSaveSwapDetails(tx);
  if (!saveConfirmation) {
    console.log("❌ Warning: Transaction not saved for tracking! Track Manually!");
  }
}

// Modified websocketHandler function
async function websocketHandler(): Promise<void> {
  const env = validateEnv();
  let ws: WebSocket | null = new WebSocket(env.HELIUS_WSS_URI);
  activeWS = ws;

  ws.on("open", () => {
    if (ws) sendSubscribeRequest(ws);
    console.log('\n🔓 WebSocket is open and listening.');
  });

  ws.on("message", async (data: WebSocket.Data) => {
    try {
      const jsonString = data.toString();
      const parsedData = JSON.parse(jsonString);

      if (parsedData.result !== undefined && !parsedData.error) {
        console.log("✅ Subscription confirmed");
        return;
      }

      if (parsedData.error) {
        console.error("🚫 RPC Error:", parsedData.error);
        return;
      }

      const logs = parsedData?.params?.result?.value?.logs;
      const signature = parsedData?.params?.result?.value?.signature;

      if (!Array.isArray(logs) || !signature) return;

      const containsCreate = logs.some((log: string) => 
        typeof log === "string" && log.includes("Program log: initialize2: InitializeInstruction2")
      );
      
      if (!containsCreate || typeof signature !== "string") return;

      if (activeTransactions >= MAX_CONCURRENT) {
        console.log("⏳ Max concurrent transactions reached, skipping...");
        return;
      }

      activeTransactions++;

      processTransaction(signature)
        .catch((error) => {
          console.error("Error processing transaction:", error);
        })
        .finally(() => {
          activeTransactions--;
        });
    } catch (error) {
      console.error("💥 Error processing message:", {
        error: error instanceof Error ? error.message : "Unknown error",
        timestamp: new Date().toISOString(),
      });
    }
  });

  ws.on("error", (err: Error) => {
    console.error("WebSocket error:", err);
  });

  ws.on("close", () => {
    console.log("📴 WebSocket connection closed");
    activeWS = null;
    isListening = false;
    if (ws) {
      ws.removeAllListeners();
      ws = null;
    }
    console.log("🔄 Attempting to reconnect in 5 seconds...");
    setTimeout(websocketHandler, 5000);
  });
}

// API Endpoints
app.post('/api/start-listening', (req: any, res: any) => {
  if (isListening) {
    return res.status(400).json({ message: 'Bot is already listening' });
  }

  websocketHandler()
    .then(() => {
      isListening = true;
      res.json({ message: 'Bot started listening successfully' });
    })
    .catch((error) => {
      res.status(500).json({ 
        message: 'Failed to start bot', 
        error: error.message 
      });
    });
});

app.post('/api/stop-listening', (req: any, res: any) => {
  if (!isListening || !activeWS) {
    return res.status(400).json({ message: 'Bot is not listening' });
  }

  activeWS.close();
  activeWS = null;
  isListening = false;
  res.json({ message: 'Bot stopped listening successfully' });
});

app.get('/api/status', (req: any, res: any) => {
  res.json({ 
    isListening,
    activeTransactions,
    config: {
      maxConcurrent: config.tx.concurrent_transactions,
      simulationMode: config.rug_check.simulation_mode,
      // Add other relevant config values
    }
  });
});

app.post('/api/update-config', (req: any, res: any) => {
  try {
    const newConfig = req.body;
    
    if (typeof newConfig.simulation_mode === 'boolean') {
      config.rug_check.simulation_mode = newConfig.simulation_mode;
    }
    
    res.json({ message: 'Config updated successfully', config });
  } catch (error: any) {
    res.status(500).json({ 
      message: 'Failed to update config', 
      error: error.message 
    });
  }
});

// Start the server
app.listen(PORT, HOST, () => {
    console.log(`Running on http://${HOST}:${PORT}`);
  });
