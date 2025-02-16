import { config } from "./../config"; // Configuration parameters for our bot
import axios from "axios";
import * as sqlite3 from "sqlite3";
import dotenv from "dotenv";
import { open } from "sqlite";
import { createTableHoldings } from "./db";
import { createSellTransactionResponse, HoldingRecord, LastPriceDexReponse } from "../types";
import { DateTime } from "luxon";
import { createSellTransaction } from "../transactions";

// Load environment variables from the .env file
dotenv.config();

// Create Action Log constant
const actionsLogs: string[] = [];

async function main() {
  const priceUrl = process.env.JUP_HTTPS_PRICE_URI || "";
  const dexPriceUrl = process.env.DEX_HTTPS_LATEST_TOKENS || "";
  const priceSource = config.sell.price_source || "jup";
  const solMint = config.liquidity_pool.wsol_pc_mint;

  // Connect to database and create if not exists
  const db = await open({
    filename: config.swap.db_name_tracker_holdings,
    driver: sqlite3.Database,
  });

  // Create Table if not exists
  const holdingsTableExist = await createTableHoldings(db);
  if (!holdingsTableExist) {
    console.log("Holdings table not present.");
    // Close the database connection when done
    await db.close();
  }

  // Proceed with tracker
  if (holdingsTableExist) {
    // Create const for holdings and action logs.
    const holdingLogs: string[] = [];
    let currentPriceSource = "Jupiter Agregator";

    // Create regional functions to push holdings and logs to const
    const saveLogTo = (logsArray: string[], ...args: unknown[]): void => {
      const message = args.map((arg) => String(arg)).join(" ");
      logsArray.push(message);
    };

    // Get all our current holdings
    const holdings = await db.all("SELECT * FROM holdings");
    if (holdings.length !== 0) {
      // Get all token ids
      const tokenValues = holdings.map((holding) => holding.Token).join(",");

      // Jupiter Agragator Price
      const priceResponse = await axios.get<any>(priceUrl, {
        params: {
          ids: tokenValues + "," + solMint,
          showExtraInfo: true,
        },
        timeout: config.tx.get_timeout,
      });
      const currentPrices = priceResponse.data.data;
      if (!currentPrices) {
        saveLogTo(actionsLogs, `⛔ Latest prices from Jupiter Agregator could not be fetched. Trying again...`);
        return;
      }

      // DexScreener Agragator Price
      let dexRaydiumPairs = null;
      if (priceSource !== "jup") {
        const dexPriceUrlPairs = `${dexPriceUrl}${tokenValues}`;
        const priceResponseDex = await axios.get<any>(dexPriceUrlPairs, {
          timeout: config.tx.get_timeout,
        });
        const currentPricesDex: LastPriceDexReponse = priceResponseDex.data;

        // Get raydium legacy pairs prices
        dexRaydiumPairs = currentPricesDex.pairs
          .filter((pair) => pair.dexId === "raydium")
          .reduce<Array<(typeof currentPricesDex.pairs)[0]>>((uniquePairs, pair) => {
            // Check if the baseToken address already exists
            const exists = uniquePairs.some((p) => p.baseToken.address === pair.baseToken.address);

            // If it doesn't exist or the existing one has labels, replace it with the no-label version
            if (!exists || (pair.labels && pair.labels.length === 0)) {
              return uniquePairs.filter((p) => p.baseToken.address !== pair.baseToken.address).concat(pair);
            }

            return uniquePairs;
          }, []);

        if (!currentPrices) {
          saveLogTo(actionsLogs, `⛔ Latest prices from Dexscreener Tokens API could not be fetched. Trying again...`);
          return;
        }
      }

      // Loop trough all our current holdings
      await Promise.all(
        holdings.map(async (row) => {
          const holding: HoldingRecord = row;
          const token = holding.Token;
          const tokenName = holding.TokenName === "N/A" ? token : holding.TokenName;
          const tokenTime = holding.Time;
          const tokenBalance = holding.Balance;
          const tokenSolPaid = holding.SolPaid;
          const tokenSolFeePaid = holding.SolFeePaid;
          const tokenSolPaidUSDC = holding.SolPaidUSDC;
          const tokenSolFeePaidUSDC = holding.SolFeePaidUSDC;
          const tokenPerTokenPaidUSDC = holding.PerTokenPaidUSDC;
          const tokenSlot = holding.Slot;
          const tokenProgram = holding.Program;

          // Conver Trade Time
          const centralEuropenTime = DateTime.fromMillis(tokenTime).toLocal();
          const hrTradeTime = centralEuropenTime.toFormat("HH:mm:ss");

          // Get current price
          let tokenCurrentPrice = currentPrices[token]?.extraInfo?.lastSwappedPrice?.lastJupiterSellPrice;
          if (priceSource === "dex") {
            if (dexRaydiumPairs && dexRaydiumPairs?.length !== 0) {
              currentPriceSource = "Dexscreener Tokens API";
              const pair = dexRaydiumPairs.find((p: any) => p.baseToken.address === token);
              tokenCurrentPrice = pair ? pair.priceUsd : tokenCurrentPrice;
            } else {
              saveLogTo(actionsLogs, `🚩 Latest prices from Dexscreener Tokens API not fetched. Falling back to Jupiter.`);
            }
          }

          // Calculate PnL and profit/loss
          const unrealizedPnLUSDC = (tokenCurrentPrice - tokenPerTokenPaidUSDC) * tokenBalance - tokenSolFeePaidUSDC;
          const unrealizedPnLPercentage = (unrealizedPnLUSDC / (tokenPerTokenPaidUSDC * tokenBalance)) * 100;
          const iconPnl = unrealizedPnLUSDC > 0 ? "🟢" : "🔴";

          // Check SL/TP
          if (config.sell.auto_sell && config.sell.auto_sell === true) {
            const amountIn = tokenBalance.toString().replace(".", "");

            // Sell via Take Profit
            if (unrealizedPnLPercentage >= config.sell.take_profit_percent) {
              try {
                const result: createSellTransactionResponse = await createSellTransaction(config.liquidity_pool.wsol_pc_mint, token, amountIn);
                const txErrorMsg = result.msg;
                const txSuccess = result.success;
                const tXtransaction = result.tx;
                // Add success to log output
                if (txSuccess) {
                  saveLogTo(actionsLogs, `✅🟢 ${hrTradeTime}: Took profit for ${tokenName}\nTx: ${tXtransaction}`);
                } else {
                  saveLogTo(actionsLogs, `⚠️ ERROR when taking profit for ${tokenName}: ${txErrorMsg}`);
                }
              } catch (error: any) {
                saveLogTo(actionsLogs, `⚠️  ERROR when taking profit for ${tokenName}: ${error.message}`);
              }
            }

            // Sell via Stop Loss
            if (unrealizedPnLPercentage <= -config.sell.stop_loss_percent) {
              try {
                const result: createSellTransactionResponse = await createSellTransaction(config.liquidity_pool.wsol_pc_mint, token, amountIn);
                const txErrorMsg = result.msg;
                const txSuccess = result.success;
                const tXtransaction = result.tx;
                // Add success to log output
                if (txSuccess) {
                  saveLogTo(actionsLogs, `✅🔴 ${hrTradeTime}: Triggered Stop Loss for ${tokenName}\nTx: ${tXtransaction}`);
                } else {
                  saveLogTo(actionsLogs, `⚠️ ERROR when triggering Stop Loss for ${tokenName}: ${txErrorMsg}`);
                }
              } catch (error: any) {
                saveLogTo(actionsLogs, `\n⚠️ ERROR when triggering Stop Loss for ${tokenName}: ${error.message}: \n`);
              }
            }
          }

          // Get the current price
          saveLogTo(
            holdingLogs,
            `${hrTradeTime}: Buy $${tokenSolPaidUSDC.toFixed(2)} | ${iconPnl} Unrealized PnL: $${unrealizedPnLUSDC.toFixed(
              2
            )} (${unrealizedPnLPercentage.toFixed(2)}%) | ${tokenBalance} ${tokenName}`
          );
        })
      );
    }

    // Output Current Holdings
    console.clear();
    console.log(`📈 Current Holdings via ✅ ${currentPriceSource}`);
    console.log("================================================================================");
    if (holdings.length === 0) console.log("No token holdings yet as of", new Date().toISOString());
    console.log(holdingLogs.join("\n"));

    // Output Action Logs
    console.log("\n\n📜 Action Logs");
    console.log("================================================================================");
    console.log("Last Update: ", new Date().toISOString());
    console.log(actionsLogs.join("\n"));

    // Output wallet tracking if set in config
    if (config.sell.track_public_wallet) {
      console.log("\nCheck your wallet: https://gmgn.ai/sol/address/" + config.sell.track_public_wallet);
    }

    await db.close();
  }

  setTimeout(main, 5000); // Call main again after 5 seconds
}

main().catch((err) => {
  console.error(err);
});
