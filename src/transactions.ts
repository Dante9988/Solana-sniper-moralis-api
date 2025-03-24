import axios from "axios";
import { Connection, Keypair, VersionedTransaction, PublicKey, ParsedTransactionWithMeta, Commitment, Finality } from "@solana/web3.js";
import { Wallet } from "@project-serum/anchor";
import bs58 from "bs58";
import dotenv from "dotenv";
import { config } from "./config";
import {
  TransactionDetailsResponseArray,
  MintsDataReponse,
  QuoteResponse,
  SerializedQuoteResponse,
  SwapEventDetailsResponse,
  HoldingRecord,
  RugResponseExtended,
  NewTokenRecord,
  createSellTransactionResponse,
} from "./types";
import { insertHolding, insertNewToken, removeHolding, selectTokenByMint, selectTokenByNameAndCreator } from "./tracker/db";
import nacl from 'tweetnacl';

// Load environment variables from the .env file
dotenv.config();

/**
 * Fetch transaction details directly from Solana blockchain.
 * @param {string} signature - The transaction signature.
 * @param {Connection} connection - Solana RPC connection.
 * @returns {Promise<MintsDataReponse | null>} - Token mint & SOL mint addresses.
 */
export async function fetchTransactionDetails(signature: string, connection: Connection): Promise<MintsDataReponse | null> {
  const metrics = {
      initialDelay: 0,
      txFetch: 0,
      total: 0
  };

  const startTotal = performance.now();
  const maxRetries = config.tx.fetch_tx_max_retries;
  let retryCount = 0;

  // Add initial delay to ensure transaction is confirmed
  const startDelay = performance.now();
  console.log(`⏳ Waiting ${config.tx.fetch_tx_initial_delay / 1000} seconds for transaction confirmation...`);
  await new Promise((resolve) => setTimeout(resolve, config.tx.fetch_tx_initial_delay));
  metrics.initialDelay = performance.now() - startDelay;

  const startTxFetch = performance.now();

  while (retryCount < maxRetries) {
      try {
          console.log(`🔎 Attempt ${retryCount + 1} of ${maxRetries} to fetch transaction details...`);

          // Fetch transaction details from Solana blockchain
          const tx: ParsedTransactionWithMeta | null = await connection.getParsedTransaction(signature, { commitment: "finalized" });

          if (!tx || !tx.meta || !tx.transaction.message.instructions) {
              throw new Error("Transaction not found or missing metadata.");
          }

          // Get post-token balances (new token mints)
          const postTokenBalances = tx.meta.postTokenBalances;
          if (!postTokenBalances || postTokenBalances.length < 2) {
              throw new Error("Insufficient token balances in transaction.");
          }

          // Identify new token mint & SOL account
          let solMint = "";
          let tokenMint = "";
          for (const balance of postTokenBalances) {
              if (balance.mint === config.wsol_pc_mint) {
                  solMint = balance.mint; // SOL mint
              } else {
                  tokenMint = balance.mint; // New token mint
              }
          }

          if (!tokenMint || !solMint) {
              throw new Error("Failed to determine token and SOL mint accounts.");
          }

          console.log("✅ Successfully fetched transaction details!");
          console.log(`SOL Token Account: ${solMint}`);
          console.log(`New Token Account: ${tokenMint}`);

          const displayData: MintsDataReponse = {
              tokenMint,
              solMint,
          };

          metrics.txFetch = performance.now() - startTxFetch;
          metrics.total = performance.now() - startTotal;

          console.log(`\n📊 Transaction Details Metrics:
• Total Time: ${metrics.total.toFixed(2)}ms
• Initial Delay: ${metrics.initialDelay.toFixed(2)}ms
• TX Fetch: ${metrics.txFetch.toFixed(2)}ms
• Retry Count: ${retryCount}`);

          return displayData;
      } catch (error: any) {
          console.log(`❌ Attempt ${retryCount + 1} failed: ${error.message}`);
          retryCount++;

          if (retryCount < maxRetries) {
              const delay = Math.min(4000 * Math.pow(1.5, retryCount), 15000);
              console.log(`⏳ Retrying in ${delay / 1000} seconds...`);
              await new Promise((resolve) => setTimeout(resolve, delay));
          }
      }
  }

  metrics.txFetch = performance.now() - startTxFetch;
  metrics.total = performance.now() - startTotal;

  console.log(`❌ All attempts to fetch transaction details failed:
• Total Time: ${metrics.total.toFixed(2)}ms
• Initial Delay: ${metrics.initialDelay.toFixed(2)}ms
• TX Fetch: ${metrics.txFetch.toFixed(2)}ms
• Retry Count: ${retryCount}`);

  return null;
}

export async function fetchTokenMintFromTx(signature: string, connection: Connection) {
    const metrics = {
        txFetch: 0,
        parsing: 0,
        total: 0,
        attempts: 0
    };

    const startTotal = performance.now();
    const maxRetries = 10;
    const initialDelay = 200;
    const WSOL_ADDRESS = "So11111111111111111111111111111111111111112";
    
    console.log(`Solscan: https://solscan.io/tx/${signature}`);
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        metrics.attempts++;
        try {
            const startTxFetch = performance.now();
            const tx = await connection.getTransaction(signature, { 
                commitment: "confirmed" as Finality,
                maxSupportedTransactionVersion: 0
            });
            metrics.txFetch = performance.now() - startTxFetch;

            if (!tx?.meta) {
                await new Promise(resolve => setTimeout(resolve, initialDelay));
                continue;
            }

            const startParsing = performance.now();
            
            // Look at post token balances to find the new token
            for (const balance of tx.meta.postTokenBalances || []) {
                if (balance.mint && balance.mint !== WSOL_ADDRESS) {
                    metrics.parsing = performance.now() - startParsing;
                    metrics.total = performance.now() - startTotal;

                    console.log(`\n📊 Token Found from Post Balances (Attempt ${attempt + 1}):
• Total Time: ${metrics.total.toFixed(2)}ms
• TX Fetch: ${metrics.txFetch.toFixed(2)}ms
• Parsing: ${metrics.parsing.toFixed(2)}ms
• Token Mint: ${balance.mint}`);

                    console.log(`Token Mint: ${balance.mint}`);
                    console.log(`SOL Mint: ${WSOL_ADDRESS}`);

                    return {
                        tokenMint: balance.mint,
                        solMint: WSOL_ADDRESS
                    };
                }
            }
        } catch (error) {
            console.log(`❌ Attempt ${attempt + 1} failed:`, error);
            if (attempt === maxRetries - 1) {
                metrics.total = performance.now() - startTotal;
                console.error(`❌ All attempts failed (${metrics.total.toFixed(2)}ms)`);
                return null;
            }
            await new Promise(resolve => setTimeout(resolve, initialDelay));
        }
    }

    metrics.total = performance.now() - startTotal;
    console.log(`❌ Failed to find token mint after ${maxRetries} attempts (${metrics.total.toFixed(2)}ms)`);
    return null;
}

// export async function fetchTransactionDetails(signature: string): Promise<MintsDataReponse | null> {
//     const metrics = {
//         initialDelay: 0,
//         txFetch: 0,
//         total: 0
//     };

//     const startTotal = performance.now();
//     const txUrl = process.env.HELIUS_HTTPS_URI_TX || "";
//     const maxRetries = config.tx.fetch_tx_max_retries;
//     let retryCount = 0;

//     // Add longer initial delay to allow transaction to be processed
//     const startDelay = performance.now();
//     console.log("Waiting " + config.tx.fetch_tx_initial_delay / 1000 + " seconds for transaction to be confirmed...");
//     await new Promise((resolve) => setTimeout(resolve, config.tx.fetch_tx_initial_delay));
//     metrics.initialDelay = performance.now() - startDelay;

//     const startTxFetch = performance.now();
//     while (retryCount < maxRetries) {
//         try {
//             console.log(`Attempt ${retryCount + 1} of ${maxRetries} to fetch transaction details...`);

//             const response = await axios.post<any>(
//                 txUrl,
//                 {
//                     transactions: [signature],
//                     commitment: "finalized",
//                     encoding: "jsonParsed",
//                 },
//                 {
//                     headers: {
//                         "Content-Type": "application/json",
//                     },
//                     timeout: config.tx.get_timeout,
//                 }
//             );

//             // Verify if a response was received
//             if (!response.data) {
//                 throw new Error("No response data received");
//             }

//             // Verify if the response was in the correct format and not empty
//             if (!Array.isArray(response.data) || response.data.length === 0) {
//                 throw new Error("Response data array is empty");
//             }

//             // Access the `data` property which contains the array of transactions
//             const transactions: TransactionDetailsResponseArray = response.data;

//             // Verify if transaction details were found
//             if (!transactions[0]) {
//                 throw new Error("Transaction not found");
//             }

//             // Access the `instructions` property which contains account instructions
//             const instructions = transactions[0].instructions;
//             if (!instructions || !Array.isArray(instructions) || instructions.length === 0) {
//                 throw new Error("No instructions found in transaction");
//             }

//             // Verify and find the instructions for the correct market maker id
//             const instruction = instructions.find((ix) => ix.programId === config.liquidity_pool.radiyum_program_id);
//             if (!instruction || !instruction.accounts) {
//                 throw new Error("No market maker instruction found");
//             }
//             if (!Array.isArray(instruction.accounts) || instruction.accounts.length < 10) {
//                 throw new Error("Invalid accounts array in instruction");
//             }

//             // Store quote and token mints
//             const accountOne = instruction.accounts[8];
//             const accountTwo = instruction.accounts[9];

//             // Verify if we received both quote and token mints
//             if (!accountOne || !accountTwo) {
//                 throw new Error("Required accounts not found");
//             }

//             // Set new token and SOL mint
//             let solTokenAccount = "";
//             let newTokenAccount = "";
//             if (accountOne === config.liquidity_pool.wsol_pc_mint) {
//                 solTokenAccount = accountOne;
//                 newTokenAccount = accountTwo;
//             } else {
//                 solTokenAccount = accountTwo;
//                 newTokenAccount = accountOne;
//             }

//             // Output logs
//             console.log("Successfully fetched transaction details!");
//             console.log(`SOL Token Account: ${solTokenAccount}`);
//             console.log(`New Token Account: ${newTokenAccount}`);

//             const displayData: MintsDataReponse = {
//                 tokenMint: newTokenAccount,
//                 solMint: solTokenAccount,
//             };

//             metrics.txFetch = performance.now() - startTxFetch;
//             metrics.total = performance.now() - startTotal;

//             console.log(`\n📊 Transaction Details Metrics:
// • Total Time: ${metrics.total.toFixed(2)}ms
// • Initial Delay: ${metrics.initialDelay.toFixed(2)}ms
// • TX Fetch: ${metrics.txFetch.toFixed(2)}ms
// • Retry Count: ${retryCount}`);

//             return displayData;
//         } catch (error: any) {
//             console.log(`Attempt ${retryCount + 1} failed: ${error.message}`);
//             retryCount++;

//             if (retryCount < maxRetries) {
//                 const delay = Math.min(4000 * Math.pow(1.5, retryCount), 15000);
//                 console.log(`Waiting ${delay / 1000} seconds before next attempt...`);
//                 await new Promise((resolve) => setTimeout(resolve, delay));
//             }
//         }
//     }

//     metrics.txFetch = performance.now() - startTxFetch;
//     metrics.total = performance.now() - startTotal;

//     console.log(`❌ All attempts to fetch transaction details failed:
// • Total Time: ${metrics.total.toFixed(2)}ms
// • Initial Delay: ${metrics.initialDelay.toFixed(2)}ms
// • TX Fetch: ${metrics.txFetch.toFixed(2)}ms
// • Retry Count: ${retryCount}`);

//     return null;
// }

export async function createSwapTransaction(solMint: string, tokenMint: string): Promise<string | null> {
  const quoteUrl = process.env.JUP_HTTPS_QUOTE_URI || "";
  const swapUrl = process.env.JUP_HTTPS_SWAP_URI || "";
  const routeUrl = process.env.JUP_HTTPS_ROUTE_URI || "";
  const rpcUrl = process.env.HELIUS_HTTPS_URI || "";
  let quoteResponseData: QuoteResponse | null = null;
  let serializedQuoteResponseData: SerializedQuoteResponse | null = null;
  const connection = new Connection(rpcUrl);
  const myWallet = new Wallet(Keypair.fromSecretKey(bs58.decode(process.env.PRIV_KEY_WALLET || "")));

  // Add route check before getting quote
  try {
    const routeResponse = await axios.get(routeUrl, {
      params: {
        inputMint: solMint,
        outputMint: tokenMint,
      },
      timeout: config.tx.get_timeout,
    });

    if (!routeResponse.data || !routeResponse.data.length) {
      console.log("🚫 No valid routes found for this swap");
      return null;
    }
  } catch (error: any) {
    console.error("Error checking routes:", error.message);
    return null;
  }

  // Get Swap Quote
  let retryCount = 0;
  while (retryCount < config.swap.token_not_tradable_400_error_retries) {
    try {
      // Request a quote in order to swap SOL for new token
      const quoteResponse = await axios.get<QuoteResponse>(quoteUrl, {
        params: {
          inputMint: solMint,
          outputMint: tokenMint,
          amount: config.swap.amount,
          slippageBps: config.swap.slippageBps,
        },
        timeout: config.tx.get_timeout,
      });

      if (!quoteResponse.data) return null;

      if (config.swap.verbose_log && config.swap.verbose_log === true) {
        console.log("\nVerbose log:");
        console.log(quoteResponse.data);
      }

      quoteResponseData = quoteResponse.data; // Store the successful response
      break;
    } catch (error: any) {
      // Retry when error is TOKEN_NOT_TRADABLE
      if (error.response && error.response.status === 400) {
        const errorData = error.response.data;
        if (errorData.errorCode === "TOKEN_NOT_TRADABLE") {
          retryCount++;
          await new Promise((resolve) => setTimeout(resolve, config.swap.token_not_tradable_400_error_delay));
          continue; // Retry
        }
      }

      // Throw error (null) when error is not TOKEN_NOT_TRADABLE
      console.error("Error while requesting a new swap quote:", error.message);
      if (config.swap.verbose_log && config.swap.verbose_log === true) {
        console.log("Verbose Error Message:");
        if (error.response) {
          // Server responded with a status other than 2xx
          console.error("Error Status:", error.response.status);
          console.error("Error Status Text:", error.response.statusText);
          console.error("Error Data:", error.response.data); // API error message
          console.error("Error Headers:", error.response.headers);
        } else if (error.request) {
          // Request was made but no response was received
          console.error("No Response:", error.request);
        } else {
          // Other errors
          console.error("Error Message:", error.message);
        }
      }
      return null;
    }
  }

  if (quoteResponseData) console.log("✅ Swap quote recieved.");

  // Serialize the quote into a swap transaction that can be submitted on chain
  try {
    if (!quoteResponseData) return null;

    const swapResponse = await axios.post<SerializedQuoteResponse>(
      swapUrl,
      JSON.stringify({
        // quoteResponse from /quote api
        quoteResponse: quoteResponseData,
        // user public key to be used for the swap
        userPublicKey: myWallet.publicKey.toString(),
        // auto wrap and unwrap SOL. default is true
        wrapAndUnwrapSol: true,
        //dynamicComputeUnitLimit: true, // allow dynamic compute limit instead of max 1,400,000
        dynamicSlippage: {
          // This will set an optimized slippage to ensure high success rate
          maxBps: 3000, // Make sure to set a reasonable cap here to prevent MEV
        },
        prioritizationFeeLamports: {
          priorityLevelWithMaxLamports: {
            maxLamports: config.swap.prio_fee_max_lamports,
            priorityLevel: config.swap.prio_level,
          },
        },
      }),
      {
        headers: {
          "Content-Type": "application/json",
        },
        timeout: config.tx.get_timeout,
      }
    );
    if (!swapResponse.data) return null;

    if (config.swap.verbose_log && config.swap.verbose_log === true) {
      console.log(swapResponse.data);
    }

    serializedQuoteResponseData = swapResponse.data; // Store the successful response
  } catch (error: any) {
    console.error("Error while sending the swap quote:", error.message);
    if (config.swap.verbose_log && config.swap.verbose_log === true) {
      console.log("Verbose Error Message:");
      if (error.response) {
        // Server responded with a status other than 2xx
        console.error("Error Status:", error.response.status);
        console.error("Error Status Text:", error.response.statusText);
        console.error("Error Data:", error.response.data); // API error message
        console.error("Error Headers:", error.response.headers);
      } else if (error.request) {
        // Request was made but no response was received
        console.error("No Response:", error.request);
      } else {
        // Other errors
        console.error("Error Message:", error.message);
      }
    }
    return null;
  }

  if (serializedQuoteResponseData) console.log("✅ Swap quote serialized.");

  // deserialize, sign and send the transaction
  try {
    if (!serializedQuoteResponseData) return null;
    const swapTransactionBuf = Buffer.from(serializedQuoteResponseData.swapTransaction, "base64");
    var transaction = VersionedTransaction.deserialize(swapTransactionBuf);

    // sign the transaction
    transaction.sign([myWallet.payer]);

    // get the latest block hash
    const latestBlockHash = await connection.getLatestBlockhash();

    // Execute the transaction
    const rawTransaction = transaction.serialize();
    const txid = await connection.sendRawTransaction(rawTransaction, {
      skipPreflight: true, // If True, This will skip transaction simulation entirely.
      maxRetries: 2,
    });

    // Return null when no tx was returned
    if (!txid) {
      console.log("🚫 No id received for sent raw transaction.");
      return null;
    }

    if (txid) console.log("✅ Raw transaction id received.");

    // Fetch the current status of a transaction signature (processed, confirmed, finalized).
    const conf = await connection.confirmTransaction({
      blockhash: latestBlockHash.blockhash,
      lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
      signature: txid,
    });

    console.log(`Transaction Hash: https://solscan.io/tx/${txid}`);

    if (txid) console.log("🔎 Checking transaction confirmation ...");

    // Return null when an error occured when confirming the transaction
    if (conf.value.err || conf.value.err !== null) {
      console.log("🚫 Transaction confirmation failed.");
      return null;
    }

    return txid;
  } catch (error: any) {
    console.error("Error while signing and sending the transaction:", error.message);
    if (config.swap.verbose_log && config.swap.verbose_log === true) {
      console.log("Verbose Error Message:");
      if (error.response) {
        // Server responded with a status other than 2xx
        console.error("Error Status:", error.response.status);
        console.error("Error Status Text:", error.response.statusText);
        console.error("Error Data:", error.response.data); // API error message
        console.error("Error Headers:", error.response.headers);
      } else if (error.request) {
        // Request was made but no response was received
        console.error("No Response:", error.request);
      } else {
        // Other errors
        console.error("Error Message:", error.message);
      }
    }
    return null;
  }
}

export async function getRugCheckConfirmed(tokenMint: string): Promise<boolean> {
    const metrics = {
        rugCheckApi: 0,
        validation: 0,
        dbOperation: 0,
        total: 0
    };

    const startTotal = performance.now();

    try {
        // Try Rugcheck first without auth
        const startRugCheck = performance.now();
        const rugResponse = await axios.get<RugResponseExtended>(
            "https://api.rugcheck.xyz/v1/tokens/" + tokenMint + "/report", 
            { timeout: config.tx.get_timeout }
        );
        metrics.rugCheckApi = performance.now() - startRugCheck;

        if (!rugResponse.data) {
            console.log("⚠️ No Rugcheck data received, falling back to SolSniffer");
            return getSolSnifferConfirmed(tokenMint);
        }

        // Start validation timing
        const startValidation = performance.now();

        // Extract and validate all data
        const tokenReport: RugResponseExtended = rugResponse.data;
        const tokenCreator = tokenReport.creator ? tokenReport.creator : tokenMint;
        const mintAuthority = tokenReport.token.mintAuthority;
        const freezeAuthority = tokenReport.token.freezeAuthority;
        const isInitialized = tokenReport.token.isInitialized;
        const supply = tokenReport.token.supply;
        const decimals = tokenReport.token.decimals;
        const tokenName = tokenReport.tokenMeta.name;
        const tokenSymbol = tokenReport.tokenMeta.symbol;
        const tokenMutable = tokenReport.tokenMeta.mutable;
        let topHolders = tokenReport.topHolders;
        const marketsLength = tokenReport.markets ? tokenReport.markets.length : 0;
        const totalLPProviders = tokenReport.totalLPProviders;
        const totalMarketLiquidity = tokenReport.totalMarketLiquidity;
        const isRugged = tokenReport.rugged;
        const rugScore = tokenReport.score;
        const rugRisks = tokenReport.risks
          ? tokenReport.risks
          : [
              {
                name: "Good",
                value: "",
                description: "",
                score: 0,
                level: "good",
              },
            ];

        // Update topholders if liquidity pools are excluded
        if (config.rug_check.exclude_lp_from_topholders) {
            // local types
            type Market = {
                liquidityA?: string;
                liquidityB?: string;
            };

            const markets: Market[] | undefined = tokenReport.markets;
            if (markets) {
                // Safely extract liquidity addresses from markets
                const liquidityAddresses: string[] = (markets ?? [])
                    .flatMap((market) => [market.liquidityA, market.liquidityB])
                    .filter((address): address is string => !!address);

                // Filter out topHolders that match any of the liquidity addresses
                topHolders = topHolders.filter((holder) => !liquidityAddresses.includes(holder.address));
            }
        }

        // Get config
        const rugCheckConfig = config.rug_check;
        const rugCheckLegacy = rugCheckConfig.legacy_not_allowed;

        // Set conditions
        const conditions = [
            {
                check: !rugCheckConfig.allow_mint_authority && mintAuthority !== null,
                message: "🚫 Mint authority should be null",
            },
            {
                check: !rugCheckConfig.allow_not_initialized && !isInitialized,
                message: "🚫 Token is not initialized",
            },
            {
                check: !rugCheckConfig.allow_freeze_authority && freezeAuthority !== null,
                message: "🚫 Freeze authority should be null",
            },
            {
                check: !rugCheckConfig.allow_mutable && tokenMutable !== false,
                message: "🚫 Mutable should be false",
            },
            {
                check: !rugCheckConfig.allow_insider_topholders && topHolders.some((holder) => holder.insider),
                message: "🚫 Insider accounts should not be part of the top holders",
            },
            {
                check: topHolders.some((holder) => holder.pct > rugCheckConfig.max_alowed_pct_topholders),
                message: "🚫 An individual top holder cannot hold more than the allowed percentage of the total supply",
            },
            {
                check: totalLPProviders < rugCheckConfig.min_total_lp_providers,
                message: "🚫 Not enough LP Providers.",
            },
            {
                check: marketsLength < rugCheckConfig.min_total_markets,
                message: "🚫 Not enough Markets.",
            },
            {
                check: totalMarketLiquidity < rugCheckConfig.min_total_market_Liquidity,
                message: "🚫 Not enough Market Liquidity.",
            },
            {
                check: !rugCheckConfig.allow_rugged && isRugged, //true
                message: "🚫 Token is rugged",
            },
            {
                check: rugCheckConfig.block_symbols.includes(tokenSymbol),
                message: "🚫 Symbol is blocked",
            },
            {
                check: rugCheckConfig.block_names.includes(tokenName),
                message: "🚫 Name is blocked",
            },
            {
                check: rugScore > rugCheckConfig.max_score && rugCheckConfig.max_score !== 0,
                message: "🚫 Rug score to high.",
            },
            {
                check: rugRisks.some((risk) => rugCheckLegacy.includes(risk.name)),
                message: "🚫 Token has legacy risks that are not allowed.",
            },
        ];

        // Validate conditions
        for (const condition of conditions) {
            if (condition.check) {
                console.log(`\n📊 Rug Check Metrics (${condition.check ? 'Failed' : 'Passed'}):
• Total Time: ${performance.now() - startValidation}ms
• API Call: ${metrics.rugCheckApi.toFixed(2)}ms
• Validation: ${metrics.validation.toFixed(2)}ms
• DB Operation: ${metrics.dbOperation.toFixed(2)}ms`);

                return false;
            }
        }

        // DB Operation timing
        const startDb = performance.now();
        const newToken: NewTokenRecord = {
            time: Date.now(),
            mint: tokenMint,
            name: tokenName,
            creator: tokenCreator,
        };
        
        await insertNewToken(newToken).catch((err) => {
            if (config.rug_check.block_returning_token_names || config.rug_check.block_returning_token_creators) {
                console.log("⛔ Unable to store new token for tracking duplicate tokens: " + err);
            }
        });
        const dbOperation = performance.now() - startDb;
        
        metrics.validation = performance.now() - startValidation;
        metrics.total = performance.now() - startTotal; // This includes API time since startTotal is before API call

        console.log(`\n📊 Rug Check Metrics (Passed):
• Total Time: ${metrics.total.toFixed(2)}ms
• API Call: ${metrics.rugCheckApi.toFixed(2)}ms
• Validation: ${metrics.validation.toFixed(2)}ms
• DB Operation: ${dbOperation.toFixed(2)}ms`);

        return true;

    } catch (error: any) {
        metrics.total = performance.now() - startTotal;
        console.log(`⚠️ Rugcheck failed (${metrics.total.toFixed(2)}ms), falling back to SolSniffer`);
        return getSolSnifferConfirmed(tokenMint);
    }
}

// export async function getRugCheckConfirmed(tokenMint: string): Promise<boolean> {
//   return getSolSnifferConfirmed(tokenMint);
// }

async function getSolSnifferConfirmed(tokenMint: string): Promise<boolean> {
  const metrics = {
      apiCall: 0,
      validation: 0,
      total: 0
  };

  const startTotal = performance.now();

  try {
      // Fetch token data from solsniffer
      const startApi = performance.now();
      const response = await axios.get(
          `https://solsniffer.com/api/v2/token/${tokenMint}`,
          {
              headers: {
                  'X-API-KEY': process.env.SOLSNIFFER_API_KEY || '',
                  'accept': 'application/json'
              }
          }
      );
      metrics.apiCall = performance.now() - startApi;

      const startValidation = performance.now();
      
      const auditRisk = response.data.tokenData.auditRisk;
      if (!auditRisk) {
          console.log("❌ No audit risk data available");
          return false;
      }

      // Check required security features
      const conditions = [
          {
              check: !auditRisk.mintDisabled,
              message: "🚫 Mint is not disabled"
          },
          {
              check: !auditRisk.freezeDisabled,
              message: "🚫 Freeze authority is not disabled"
          },
          {
              check: !auditRisk.lpBurned,
              message: "🚫 LP tokens are not burned"
          }
      ];

      // Validate conditions
      for (const condition of conditions) {
          if (condition.check) {
              metrics.validation = performance.now() - startValidation;
              metrics.total = performance.now() - startTotal;

              console.log(`\n📊 SolSniffer Check Metrics (Failed):
• Total Time: ${metrics.total.toFixed(2)}ms
• API Call: ${metrics.apiCall.toFixed(2)}ms
• Validation: ${metrics.validation.toFixed(2)}ms
• Failed on: ${condition.message}`);

              return false;
          }
      }

      metrics.validation = performance.now() - startValidation;
      metrics.total = performance.now() - startTotal;
      
      console.log(`\n📊 SolSniffer Check Metrics (Passed):
• Total Time: ${metrics.total.toFixed(2)}ms
• API Call: ${metrics.apiCall.toFixed(2)}ms
• Validation: ${metrics.validation.toFixed(2)}ms`);

      return true;

  } catch (error) {
      metrics.total = performance.now() - startTotal;
      console.error(`❌ SolSniffer Check Error (${metrics.total.toFixed(2)}ms):`, error);
      return false;
  }
}

export async function fetchAndSaveSwapDetails(tx: string): Promise<boolean> {
  const txUrl = process.env.HELIUS_HTTPS_URI_TX || "";
  const priceUrl = process.env.JUP_HTTPS_PRICE_URI || "";
  const rpcUrl = process.env.HELIUS_HTTPS_URI || "";

  try {
    const response = await axios.post<any>(
      txUrl,
      { transactions: [tx] },
      {
        headers: {
          "Content-Type": "application/json",
        },
        timeout: 10000, // Timeout for each request
      }
    );

    // Verify if we received tx reponse data
    if (!response.data || response.data.length === 0) {
      console.log("⛔ Could not fetch swap details: No response received from API.");
      return false;
    }

    // Safely access the event information
    const transactions: TransactionDetailsResponseArray = response.data;
    const swapTransactionData: SwapEventDetailsResponse = {
      programInfo: transactions[0]?.events.swap.innerSwaps[0].programInfo,
      tokenInputs: transactions[0]?.events.swap.innerSwaps[0].tokenInputs,
      tokenOutputs: transactions[0]?.events.swap.innerSwaps[0].tokenOutputs,
      fee: transactions[0]?.fee,
      slot: transactions[0]?.slot,
      timestamp: transactions[0]?.timestamp,
      description: transactions[0]?.description,
    };

    // Get latest Sol Price
    const solMint = config.wsol_pc_mint;
    const priceResponse = await axios.get<any>(priceUrl, {
      params: {
        ids: solMint,
      },
      timeout: config.tx.get_timeout,
    });

    // Verify if we received the price response data
    if (!priceResponse.data.data[solMint]?.price) return false;

    // Calculate estimated price paid in sol
    const solUsdcPrice = priceResponse.data.data[solMint]?.price;
    const solPaidUsdc = swapTransactionData.tokenInputs[0].tokenAmount * solUsdcPrice;
    const solFeePaidUsdc = (swapTransactionData.fee / 1_000_000_000) * solUsdcPrice;
    const perTokenUsdcPrice = solPaidUsdc / swapTransactionData.tokenOutputs[0].tokenAmount;

    // Get token meta data
    let tokenName = "N/A";
    const tokenData: NewTokenRecord[] = await selectTokenByMint(swapTransactionData.tokenOutputs[0].mint);
    if (tokenData) {
      tokenName = tokenData[0].name;
    }

    // Add holding to db
    const newHolding: HoldingRecord = {
      Time: swapTransactionData.timestamp,
      Token: swapTransactionData.tokenOutputs[0].mint,
      TokenName: tokenName,
      Balance: swapTransactionData.tokenOutputs[0].tokenAmount,
      SolPaid: swapTransactionData.tokenInputs[0].tokenAmount,
      SolFeePaid: swapTransactionData.fee,
      SolPaidUSDC: solPaidUsdc,
      SolFeePaidUSDC: solFeePaidUsdc,
      PerTokenPaidUSDC: perTokenUsdcPrice,
      Slot: swapTransactionData.slot,
      Program: swapTransactionData.programInfo ? swapTransactionData.programInfo.source : "N/A",
    };

    await insertHolding(newHolding).catch((err) => {
      console.log("⛔ Database Error: " + err);
      return false;
    });

    return true;
  } catch (error: any) {
    console.error("Error during request:", error.message);
    return false;
  }
}

export async function createSellTransaction(solMint: string, tokenMint: string, amount: string): Promise<createSellTransactionResponse> {
  const quoteUrl = process.env.JUP_HTTPS_QUOTE_URI || "";
  const swapUrl = process.env.JUP_HTTPS_SWAP_URI || "";
  const rpcUrl = process.env.HELIUS_HTTPS_URI || "";
  const myWallet = new Wallet(Keypair.fromSecretKey(bs58.decode(process.env.PRIV_KEY_WALLET || "")));
  const connection = new Connection(rpcUrl);

  try {
    // Check token balance using RPC connection
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(myWallet.publicKey, {
      mint: new PublicKey(tokenMint),
    });

    //Check if token exists in wallet with non-zero balance
    const totalBalance = tokenAccounts.value.reduce((sum, account) => {
      const tokenAmount = account.account.data.parsed.info.tokenAmount.amount;
      return sum + BigInt(tokenAmount); // Use BigInt for precise calculations
    }, BigInt(0));

    // Verify returned balance
    if (totalBalance <= 0n) {
      await removeHolding(tokenMint).catch((err) => {
        console.log("⛔ Database Error: " + err);
      });
      throw new Error(`Token has 0 balance - Already sold elsewhere. Removing from tracking.`);
    }

    // Verify amount with tokenBalance
    if (totalBalance !== BigInt(amount)) {
      throw new Error(`Wallet and tracker balance mismatch. Sell manually and token will be removed during next price check.`);
    }

    // Request a quote in order to swap SOL for new token
    const quoteResponse = await axios.get<QuoteResponse>(quoteUrl, {
      params: {
        inputMint: tokenMint,
        outputMint: solMint,
        amount: amount,
        slippageBps: config.sell.slippageBps,
      },
      timeout: config.tx.get_timeout,
    });

    // Throw error if no quote was received
    if (!quoteResponse.data) {
      throw new Error("No valid quote for selling the token was received from Jupiter!");
    }

    // Serialize the quote into a swap transaction that can be submitted on chain
    const swapTransaction = await axios.post<SerializedQuoteResponse>(
      swapUrl,
      JSON.stringify({
        // quoteResponse from /quote api
        quoteResponse: quoteResponse.data,
        // user public key to be used for the swap
        userPublicKey: myWallet.publicKey.toString(),
        // auto wrap and unwrap SOL. default is true
        wrapAndUnwrapSol: true,
        //dynamicComputeUnitLimit: true, // allow dynamic compute limit instead of max 1,400,000
        dynamicSlippage: {
          // This will set an optimized slippage to ensure high success rate
          maxBps: 300, // Make sure to set a reasonable cap here to prevent MEV
        },
        prioritizationFeeLamports: {
          priorityLevelWithMaxLamports: {
            maxLamports: config.sell.prio_fee_max_lamports,
            priorityLevel: config.sell.prio_level,
          },
        },
      }),
      {
        headers: {
          "Content-Type": "application/json",
        },
        timeout: config.tx.get_timeout,
      }
    );

    // Throw error if no quote was received
    if (!swapTransaction.data) {
      throw new Error("No valid swap transaction was received from Jupiter!");
    }

    // deserialize the transaction
    const swapTransactionBuf = Buffer.from(swapTransaction.data.swapTransaction, "base64");
    var transaction = VersionedTransaction.deserialize(swapTransactionBuf);

    // sign the transaction
    transaction.sign([myWallet.payer]);

    // Execute the transaction
    const rawTransaction = transaction.serialize();
    const txid = await connection.sendRawTransaction(rawTransaction, {
      skipPreflight: true, // If True, This will skip transaction simulation entirely.
      maxRetries: 2,
    });

    // Return null when no tx was returned
    if (!txid) {
      throw new Error("Could not send transaction that was signed and serialized!");
    }

    // get the latest block hash
    const latestBlockHash = await connection.getLatestBlockhash();

    // Fetch the current status of a transaction signature (processed, confirmed, finalized).
    const conf = await connection.confirmTransaction({
      blockhash: latestBlockHash.blockhash,
      lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
      signature: txid,
    });

    // Return null when an error occured when confirming the transaction
    if (conf.value.err || conf.value.err !== null) {
      throw new Error("Transaction was not successfully confirmed!");
    }

    // Delete holding
    await removeHolding(tokenMint).catch((err) => {
      console.log("⛔ Database Error: " + err);
    });

    return {
      success: true,
      msg: null,
      tx: txid,
    };
  } catch (error: any) {
    return {
      success: false,
      msg: error instanceof Error ? error.message : "Unknown error",
      tx: null,
    };
  }
}

let rugcheckJWT: string | null = null;

async function authenticateRugcheck(): Promise<string> {
    try {
        if (rugcheckJWT) return rugcheckJWT;

        const keypair = Keypair.fromSecretKey(bs58.decode(process.env.RUGCHECK_PRIVATE_KEY || ''));
        const timestamp = Date.now();
        const message = "Sign-in to Rugcheck.xyz"; // Simplified message without timestamp
        const encodedMessage = new TextEncoder().encode(message);
        const signedData = nacl.sign.detached(encodedMessage, keypair.secretKey);

        const authData = {
            message: {
                message,
                publicKey: keypair.publicKey.toString(),
                timestamp
            },
            signature: {
                data: bs58.encode(signedData),
                type: "ed25519"
            },
            wallet: keypair.publicKey.toString()
        };

        const response = await axios.post(
            "https://api.rugcheck.xyz/auth/login/solana",
            authData
        );

        if (!response.data.token) {
            throw new Error('No token received from Rugcheck');
        }
        rugcheckJWT = response.data.token;
        return response.data.token;
    } catch (error) {
        console.error('Failed to authenticate with Rugcheck:', error);
        throw error;
    }
}
