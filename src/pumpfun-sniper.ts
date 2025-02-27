import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import WebSocket from "ws";
import axios from "axios";
import base58 from "bs58";
import dotenv from "dotenv";
import { Metaplex } from "@metaplex-foundation/js";
import { PUMP_FUN_PROGRAM } from "./constants";  // Ensure this contains "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
import { fetchTokenMintFromTx, getRugCheckConfirmed } from "./transactions";
import { sendPumpFunAlert } from './discord-pumpfun';

dotenv.config();

const RPC_ENDPOINT = process.env.RPC_ENDPOINT || "";
const connection = new Connection(RPC_ENDPOINT, "confirmed");

// Processing queue
let isProcessing = false;
const tokenQueue: string[] = [];

async function processToken(signature: string) {
    try {
        console.log(`\n🎯 Processing Token Tx: https://solscan.io/tx/${signature}`);
        
        // Fetch transaction details
        console.log("🔎 Fetching transaction details...");
        const txData = await fetchTokenMintFromTx(signature, connection);
        if (!txData || !txData.tokenMint) {
            console.log("⛔ Could not fetch token details. Skipping...");
            return;
        }

        console.log(`📌 Token Mint: ${txData.tokenMint}`);

        // Get Market Data
        console.log("📊 Fetching Market Data...");
        const marketData = await fetchTokenMarketData(txData.tokenMint);
        if (!marketData) {
            console.log("⛔ Market data unavailable. Skipping...");
            return;
        }

        // Perform Rug Check
        // console.log("🔍 Performing Rug Check...");
        // const rugCheckPassed = await getRugCheckConfirmed(txData.tokenMint);
        // if (!rugCheckPassed) {
        //     console.log("🚨 Rug check failed! Skipping...");
        //     return;
        // }

        // Add more detailed logging
        console.log("📨 Attempting to send Discord alert...");
        console.log("Channel ID:", process.env.PUMPFUN_DISCORD_CHANNEL_ID);
        console.log("Bot Token present:", !!process.env.DISCORD_BOT_TOKEN);

        await sendPumpFunAlert(txData.tokenMint);

        
        console.log("✅ Discord alert sent successfully");

        console.log(`\n✅ SAFE TOKEN FOUND:
• Mint: ${txData.tokenMint}
• Market Cap: $${marketData.marketCap}
• Supply: ${marketData.totalSupply}
• Liquidity: $${marketData.liquidityUSD}
• Price: $${marketData.priceUSD}
• Bonding Complete: ${marketData.complete}

🚀 Trading Links:
• Pump.fun: https://pump.fun/${txData.tokenMint}
• GMGN: https://gmgn.ai/sol/token/${txData.tokenMint}
• BullX: https://neo.bullx.io/terminal?chainId=1399811149&address=${txData.tokenMint}
• Raydium: https://raydium.io/swap/?inputCurrency=sol&outputCurrency=${txData.tokenMint}`);

    } catch (error) {
        console.error("💥 Error processing token:", error);
        if (error instanceof Error) {
            console.error(error.stack);
        }
    }
}

async function processNextToken() {
    if (tokenQueue.length === 0 || isProcessing) {
        return;
    }

    isProcessing = true;
    const signature = tokenQueue.shift()!;
    
    await processToken(signature);
    
    isProcessing = false;
    // Process next token if any
    processNextToken();
}

// WebSocket setup
const GEYSER_RPC = process.env.GEYSER_RPC || "";
if (!GEYSER_RPC) throw new Error("Missing Geyser RPC!");

const ws = new WebSocket(GEYSER_RPC);

/**
 * Listens for new token creations from Pump.fun.
 */
ws.on("open", () => {
  console.log("🚀 Listening for new tokens on Pump.fun...");
  const request = {
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
});

/**
 * Handles new token creation events.
 */
ws.on("message", async (data) => {
  try {
    const message = JSON.parse(data.toString("utf8"));

    if (message.result !== undefined) {
      console.log("✅ Subscribed to Pump.fun!");
      return;
    }

    const logs = message.params?.result?.value?.logs;
    if (!logs || !logs.some((log: string) => log.includes("Program log: Instruction: InitializeMint2"))) {
      return;
    }

    const signature = message.params.result.value.signature;
    tokenQueue.push(signature);
    processNextToken();

  } catch (error) {
    console.error("💥 Error processing message:", error);
  }
});

/**
 * Fetches token market data from Pump.fun bonding curve
 */
async function fetchTokenMarketData(mintAddress: string) {
  try {
    // Get bonding curve PDA
    const [bondingCurvePDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("bonding-curve"),
        new PublicKey(mintAddress).toBuffer()
      ],
      new PublicKey(PUMP_FUN_PROGRAM)
    );

    // Fetch raw account data
    const accountInfo = await connection.getAccountInfo(bondingCurvePDA);
    if (!accountInfo) {
      console.log("❌ No bonding curve account found.");
      return null;
    }

    // First 8 bytes are discriminator, skip them when deserializing
    const bondingCurveData = {
      virtualTokenReserves: accountInfo.data.readBigUInt64LE(8),
      virtualSolReserves: accountInfo.data.readBigUInt64LE(16),
      realTokenReserves: accountInfo.data.readBigUInt64LE(24),
      realSolReserves: accountInfo.data.readBigUInt64LE(32),
      tokenTotalSupply: accountInfo.data.readBigUInt64LE(40),
      complete: accountInfo.data.readUInt8(48) === 1
    };

    // Get SOL price for USD calculations
    const solPrice = await getSolPrice();

    // Calculate liquidity in SOL
    const solLiquidity = Number(bondingCurveData.realSolReserves) / 1e9;
    
    // Calculate liquidity in USD
    const liquidityUSD = solLiquidity * solPrice;

    // Calculate virtual price from reserves
    const virtualPrice = Number(bondingCurveData.virtualSolReserves) / 
                        Number(bondingCurveData.virtualTokenReserves);
    
    // Calculate market cap
    const totalSupply = Number(bondingCurveData.tokenTotalSupply);
    const marketCapUSD = (totalSupply * virtualPrice * solPrice) / 1e9;

    return {
      marketCap: marketCapUSD.toFixed(2),
      totalSupply: totalSupply,
      liquidityUSD: liquidityUSD.toFixed(2),
      priceUSD: ((virtualPrice * solPrice) / 1e9).toFixed(6),
      complete: bondingCurveData.complete
    };
  } catch (error) {
    console.error("❌ Error fetching market data:", error);
    return null;
  }
}

async function getSolPrice(): Promise<number> {
  try {
      const response = await axios.get(
          'https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112'
      );
      
      const pair = response.data?.pairs?.[0];
      if (pair?.priceUsd) {
          return Number(pair.priceUsd);
      }
      
      return 0;
  } catch (error) {
      console.error('Error fetching SOL price from DexScreener:', error);
      return 0;
  }
}
