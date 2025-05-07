/** 
*  * Detailed Explanations (To be continued)
*  
* -------------------
* prio_level:
* -------------------
* priorityLevel: Allows you to set a custom priority level for the fee. If priorityLevel is not specified, 
* the API will use the Medium (50th percentile) level. The levels and their corresponding percentiles are:
*     Min: 0th percentile
*     Low: 25th percentile
*     Medium: 50th percentile
*     High: 75th percentile
*     VeryHigh: 95th percentile
*     UnsafeMax: 100th percentile (use with caution).
* -------------------
* legacy_not_allowed:
* -------------------
* Sorted from high risk to lower risk - however all of them are still risky!
* 1. Freeze Authority Still Enabled: 
* This means that the developers or issuer of the coin have the ability to freeze transactions or revert them. 
* This can be a sign of a lack of decentralization and can undermine your confidence in the stability 
* and security of the coin.
* 2. Single Holder Ownership: 
* If a single wallet holder owns a large portion of the coins, this person could manipulate the market by 
* selling off or withholding large amounts. This is risky for you as the value of your investment could 
* heavily depend on the actions of one person.
* 3. High Holder Concentration: 
* Similar to single holder ownership, but here, a few holders own a large percentage of the coins. This increases 
* the risk of market manipulations and price fluctuations if these major holders suddenly decide to sell.
* 4. Large Amount of LP Unlocked: 
* LP stands for Liquidity Provider. If a large amount of the liquidity pool tokens are unlocked, 
* providers could withdraw them at any time, which could lead to a sudden loss of liquidity and a potential price drop.
* 5. Low Liquidity:
* Low liquidity means there are not many coins available for buying or selling. This can lead to extreme 
* price changes even with small buy or sell orders. It's risky because you might not be able to sell your 
* coins without significantly impacting the price.
* 6. Copycat Token: 
* A token that is simply a copy of another existing token, often without any innovative features or improvements. 
* This can indicate a lack of seriousness or potential for long-term growth.
* 7. Low Amount of LP Providers: 
* Having few liquidity providers means the liquidity of the token depends on a few sources. 
* This can be risky, as if these providers decide to withdraw their funds, it could destabilize the market.
**/
export const config = {
  liquidity_pool: [
    {
      enabled: true,
      id: "pump1",
      name: "pumpswap",
      program: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
      instruction: "Program log: Instruction: CreatePool",
    },
    {
      enabled: false,
      id: "rad1",
      name: "Raydium",
      program: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
      instruction: "Program log: initialize2: InitializeInstruction2",
    },
    {
      wsol_pc_mint: "So11111111111111111111111111111111111111112",
    }
  ],
  wsol_pc_mint: "So11111111111111111111111111111111111111112",

  tx: {
    fetch_tx_max_retries: 10,
    fetch_tx_initial_delay: 1000, // Initial delay before fetching LP creation transaction details (3 seconds)
    swap_tx_initial_delay: 1000, // Initial delay before first buy (1 second)
    get_timeout: 10000, // Timeout for API requests
    concurrent_transactions: 5, // Number of simultaneous transactions
    retry_delay: 500, // Delay between retries (0.5 seconds)
  },
  swap: {
    verbose_log: false,
    prio_fee_max_lamports: 9000000, // 0.009 SOL
    prio_level: "veryHigh", // If you want to land transaction fast, set this to use `veryHigh`. You will pay on average higher priority fee.
    amount: "1000000", //0.1 SOL
    slippageBps: "4000", // 20%
    db_name_tracker_holdings: "src/tracker/holdings.db", // Sqlite Database location
    token_not_tradable_400_error_retries: 5, // How many times should the bot try to get a quote if the token is not tradable yet
    token_not_tradable_400_error_delay: 2000, // How many seconds should the bot wait before retrying to get a quote again
  },
  sell: {
    price_source: "dex", // dex=Dexscreener,jup=Jupiter Agregator (Dex is most accurate and Jupiter is always used as fallback)
    prio_fee_max_lamports: 9000000, // 0.009 SOL
    prio_level: "veryHigh", // If you want to land transaction fast, set this to use `veryHigh`. You will pay on average higher priority fee.
    slippageBps: "4000", // 40%
    auto_sell: true, // If set to true, stop loss and take profit triggers automatically when set.
    stop_loss_percent: 20,
    take_profit_percent: 100,
    track_public_wallet: "", // If set an additional log line will be shown with a link to track your wallet
  },
  rug_check: {
    verbose_log: true, // Enable verbose logging to see which checks are failing
    simulation_mode: true,
    // Dangerous
    allow_mint_authority: false, // Temporarily allow mint authority for testing
    allow_not_initialized: false, // Temporarily allow uninitialized tokens for testing
    allow_freeze_authority: false, // Temporarily allow freeze authority for testing
    allow_rugged: false, // Temporarily allow rugged tokens for testing
    // Critical
    allow_mutable: false,
    block_returning_token_names: false,
    block_returning_token_creators: false,
    block_symbols: ["XXX"],
    block_names: ["XXX"],
    allow_insider_topholders: true,
    max_alowed_pct_topholders: 80, // Increased from 70 to 90
    exclude_lp_from_topholders: true,
    // Warning
    min_total_markets: 0,
    min_total_lp_providers: 0,
    min_total_market_Liquidity: 1000, // Reduced from 3000 to 1000
    // Misc
    ignore_pump_fun: false, // Added to ignore pump.fun specific checks
    max_score: 0, // Increased from 0 to 100
    
    legacy_not_allowed: [
      "Freeze Authority still enabled",
      "Single holder ownership",
      "High holder concentration",
      "Large Amount of LP Unlocked",
    ],
  },
  rugSafe: {
    simulation_mode: true,
    requiredAuditRisk: {
      mintDisabled: true,    // Mint authority must be disabled
      freezeDisabled: true,  // Freeze authority must be disabled
      lpBurned: true,       // LP tokens must be burned
      top10Holders: false,   // Top 10 holders should not have concentration
    },
    verbose_log: false,      // Enable for debugging
  },
  sniperoo: {
    enabled: true,
    api_key: process.env.SNIPEROO_API_KEY || "",
    default_buy_amount: 0.1, // Default SOL amount for buys
    default_take_profit: 50, // Default take profit percentage
    default_stop_loss: 15,   // Default stop loss percentage
    auto_sell: true,        // Enable auto-sell by default
  },
  telegram: {
    enabled: true,
    token: process.env.TELEGRAM_BOT_TOKEN || "",
    admin_ids: (process.env.TELEGRAM_ADMIN_IDS || "").split(","),
  },
  pumpswap: {
    enabled: true,
    send_migration_alerts: true,
    program_id: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
  },
};
