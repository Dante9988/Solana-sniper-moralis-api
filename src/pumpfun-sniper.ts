import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import base58 from "bs58";
import dotnet from "dotenv";
import { PUMP_FUN_PROGRAM } from "./constants";
import { convertHttpToWebSocket, formatDate } from "./utils/commonFunc";
import buyToken from "./pumputils/utils/buyToken";
import { Metaplex } from "@metaplex-foundation/js";
import WebSocket from "ws";
import { WebSocketRequest } from "./types";
import { fetchTransactionDetails, getRugCheckConfirmed } from "./transactions";

dotnet.config();

// Environment variables and setup
const rpc = process.env.RPC_ENDPOINT;
console.log("🚀 RPC:", rpc);

const payer = process.env.PRIVATE_KEY;
console.log("🚀 Private Key:", `${payer?.slice(0, 6)}...`);

const isDevMode = process.env.DEV_MODE === "true";
const devwallet = process.env.DEV_WALLET_ADDRESS;
if (isDevMode) {
  console.log("🚀 Dev Wallet:", devwallet);
}

const isTickerMode = process.env.TICKER_MODE === "true";
const tokenTicker = process.env.TOKEN_TICKER;
if (isTickerMode) {
  console.log("🚀 Token Ticker:", tokenTicker);
}

const buyamount = process.env.BUY_AMOUNT;
console.log("🚀 Buy Amount:", buyamount);

const isGeyser = process.env.IS_GEYSER === "true";

// Token metadata helper
const getTokenMetadata = async (
  mintAddress: string,
  connection: Connection
) => {
  try {
    const metaplex = Metaplex.make(connection);
    const mintPublicKey = new PublicKey(mintAddress);
    const nft = await metaplex
      .nfts()
      .findByMint({ mintAddress: mintPublicKey });
    return nft;
  } catch (error) {
    return false;
  }
};

async function waitForFinalization(connection: Connection, signature: string): Promise<boolean> {
    try {
        console.log("⏳ Waiting for transaction finalization (32 blocks)...");
        const result = await connection.confirmTransaction(
            signature,
            "finalized"  // Wait for 32 blocks
        );
        
        if (result.value.err) {
            console.log("❌ Transaction failed:", result.value.err);
            return false;
        }

        // Double check finalization status
        const status = await connection.getSignatureStatus(signature, {
            searchTransactionHistory: true,
        });

        if (status.value?.confirmationStatus === 'finalized') {
            console.log("✅ Transaction finalized!");
            return true;
        } else {
            console.log("⚠️ Transaction not finalized:", status.value?.confirmationStatus);
            return false;
        }
    } catch (error) {
        console.error("❌ Error waiting for finalization:", error);
        return false;
    }
}

const withGayser = (
  rpcEndPoint: string,
  payer: string,
  solIn: number,
  devAddr: string
) => {
  const GEYSER_RPC = process.env.GEYSER_RPC;
  if (!GEYSER_RPC) return console.log("Geyser RPC is not provided!");
  
  const ws = new WebSocket(GEYSER_RPC);
  const connection = new Connection(rpcEndPoint, {
    wsEndpoint: convertHttpToWebSocket(rpcEndPoint),
    commitment: "confirmed",
  });
  const payerKeypair = Keypair.fromSecretKey(base58.decode(payer));

  function sendRequest(ws: WebSocket): void {
    const request: WebSocketRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "logsSubscribe",
      params: [
        {
          mentions: [PUMP_FUN_PROGRAM], // Listening for logs from Pump.fun program
        },
        {
          commitment: "processed",
        },
      ],
    };
    ws.send(JSON.stringify(request));
  }
  

  let init = false;
  ws.on("open", () => {
    // Subscribe
    if (ws) sendRequest(ws); // Send a request once the WebSocket is open
    console.log("\n🔓 WebSocket is open and listening.");
    init = true;
  });

  ws.on("message", async function incoming(data) {
    const messageStr = data.toString("utf8");
    try {
      const messageObj = JSON.parse(messageStr);
  
      // Confirm Subscription
      if (messageObj.result !== undefined) {
        console.log("✅ Subscription confirmed, ID:", messageObj.result);
        return;
      }
  
      // Check for logs
      if (!messageObj.params?.result?.value?.logs) {
        console.log("⚠️ No logs found in transaction");
        return;
      }
  
      const logs = messageObj.params.result.value.logs;
      
      // Detect New Token Creation
      if (!logs.some((log: string) => log.includes("Program log: Instruction: InitializeMint2"))) {
        return;
      }
  
      const signature = messageObj.params.result.value.signature;
      console.log("=============================================");
      console.log("🎯 New Mint Event Detected!");
      console.log(`🔍 Transaction: https://solscan.io/tx/${signature}`);

      // Wait for transaction finalization
      const isFinalized = await waitForFinalization(connection, signature);
      if (!isFinalized) {
        console.log("⛔ Transaction not finalized, skipping...");
        console.log("🟢 Resuming looking for new tokens...\n");
        return;
      }

      // Fetch transaction details after finalization
      console.log("🔍 Fetching transaction details...");
      const data = await fetchTransactionDetails(signature, connection);
      if (!data) {
        console.log("⛔ Transaction aborted. No data returned.");
        console.log("🟢 Resuming looking for new tokens...\n");
        return;
      }

      // Ensure required data is available
      if (!data.solMint || !data.tokenMint) {
        console.log("⛔ Missing token data.");
        return;
      }

      console.log(`🎯 Token Found:`);
      console.log(`• Token Address: ${data.tokenMint}`);
      console.log(`• Trading Links:`);
      console.log(`  • 👽 GMGN: https://gmgn.ai/sol/token/${data.tokenMint}`);
      console.log(`  • 😈 BullX: https://neo.bullx.io/terminal?chainId=1399811149&address=${data.tokenMint}`);
      console.log(`  • 🌊 Raydium: https://raydium.io/swap/?inputCurrency=sol&outputCurrency=${data.tokenMint}`);

      // Check Rug Check
      console.log("🔍 Running rug check...");
      const isRugCheckPassed = await getRugCheckConfirmed(data.tokenMint);
      if (!isRugCheckPassed) {
        console.log("🚫 Rug Check not passed! Transaction aborted.");
        console.log("🟢 Resuming looking for new tokens...\n");
        return;
      }

      console.log("✅ Rug Check passed!");

      // Add your buying logic here if needed
      // const sig = await buyToken(new PublicKey(data.tokenMint), connection, payerKeypair, solIn, 1);
      
      console.log("=============================================\n");

    } catch (error) {
      console.error("💥 Error processing message:", error instanceof Error ? error.message : "Unknown error");
    }
  });
  

//   ws.on("message", async function incoming(data) {
//     const messageStr = data.toString("utf8");
//     try {
//       const messageObj = JSON.parse(messageStr);

//       // Handle subscription confirmation
//       if (messageObj.result !== undefined) {
//         console.log("✅ Subscription confirmed, ID:", messageObj.result);
//         return;
//       }

//       // Skip if no params or result
//       if (!messageObj.params?.result?.value?.logs) {
//         return;
//       }

//       const logs = messageObj.params.result.value.logs;
      
//       // We're only interested in mint creation
//       if (!logs.some((log: any) => log.includes("Program log: Instruction: InitializeMint2"))) {
//         return;
//       }

//       const signature = messageObj.params.result.value.signature;
//       const accountKeys = messageObj.params.result.value.transaction?.transaction?.message?.accountKeys;
      
//       if (!accountKeys) {
//         console.log("No account keys found in transaction");
//         return;
//       }

//       const dev = accountKeys[0].pubkey;
//       const mint = accountKeys[1].pubkey;

//       console.log(
//         "🎯 New token creation detected => ",
//         `https://solscan.io/tx/${signature}`,
//         await formatDate()
//       );
      
//       if (isDevMode) {
//         console.log("Dev wallet => ", `https://solscan.io/address/${dev}`);
//         if (dev !== devAddr) {
//           console.log("Skipping: Not from target dev wallet");
//           return;
//         }
//       }

//       if (isTickerMode) {
//         if (!tokenTicker) {
//           console.log("Token Ticker is not defined!");
//           return;
//         }
//         const tokenInfo = await getTokenMetadata(mint.toString(), connection);
//         if (!tokenInfo) {
//           console.log("Could not fetch token metadata");
//           return;
//         }
//         const isTarget = tokenInfo.symbol
//           .toUpperCase()
//           .includes(tokenTicker.toUpperCase());
//         if (!isTarget) {
//           console.log(`Skipping: Token symbol doesn't match ${tokenTicker}`);
//           return;
//         }
//         console.log(`Found $${tokenInfo.symbol} token!`);
//       }

//       console.log(
//         "🎯 Attempting to buy => ",
//         `https://solscan.io/token/${mint.toString()}`
//       );
      
//       const sig = await buyToken(new PublicKey(mint), connection, payerKeypair, solIn, 1);
//       console.log('Buy Transaction => ', `https://solscan.io/tx/${sig}`);
      
//       if (sig) {
//         console.log('🚀 Buy Success!!!');
//         console.log('Try to sell on pumpfun: ', `https://pump.fun/${mint.toString()}`);
//       }

//     } catch (e) {
//       if (e instanceof Error) {
//         console.error("Error processing message:", {
//           error: e.message,
//           data: messageStr.slice(0, 200) + "..." // Log first 200 chars of message for debugging
//         });
//       }
//     }
//   });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err);
  });

  ws.on("close", () => {
    console.log("WebSocket connection closed, attempting to reconnect...");
    setTimeout(() => withGayser(rpcEndPoint, payer, solIn, devAddr), 5000);
  });
};

const main = () => {
  if (!isGeyser) {
    console.log("Please enable Geyser mode to use Pump.fun sniper!");
    return;
  }
  
  console.log("--------------- Pump.fun Sniper Started! ---------------\n");
  withGayser(rpc!, payer!, Number(buyamount!), devwallet!);
};

main();
