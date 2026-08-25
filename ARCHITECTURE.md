# Architecture & Handoff Guide

> Internal reference for continuing development. Describes what exists, what works, and known gaps — especially **Pump.fun** vs **PumpSwap** Discord notifications.

**Stack:** TypeScript / Node 18+, Solana Web3.js, Discord.js v14, Prisma + PostgreSQL, SQLite (holdings tracker), Express, Helius RPC/WSS, Moralis, Jupiter, Rugcheck/SolSniffer.

**Date of this snapshot:** 2026-08-24

---

## 1. What This Project Is

A Solana token-monitoring / sniper system with two primary live alert paths:

| Path | Event | Discord channel env | Entry script |
|------|--------|---------------------|--------------|
| **Pump.fun (new mint)** | New bonding-curve token (`InitializeMint2`) | `PUMPFUN_DISCORD_CHANNEL_ID` | `yarn pumpfun` → `src/pumpfun-sniper.ts` |
| **PumpSwap / pool migration** | Pool create (`CreatePool`) on configured program | `DISCORD_CHANNEL_ID` | `yarn dev` → `src/index.ts` |

Plus supporting systems: rug checks, Moralis market data, PnL tracking, Sniperoo wallets, optional auto-buy/sell (mostly simulation today), Grok analysis hooks, and a holdings price tracker.

---

## 2. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         PROCESS A: yarn pumpfun                         │
│  pumpfun-sniper.ts                                                      │
│  WSS (GEYSER_RPC) → Pump.fun program logs                               │
│  Filter: "Instruction: InitializeMint2"                                 │
│  → fetchTokenMintFromTx → bonding curve MC data                         │
│  → sendPumpFunAlert()  [discord/discord-pumpfun.ts]                     │
│  → Discord: PUMPFUN_DISCORD_CHANNEL_ID                                  │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                         PROCESS B: yarn dev                             │
│  index.ts                                                               │
│  WSS (HELIUS_WSS_URI) → enabled liquidity_pool programs from config     │
│  Currently enabled: id "pump1" name "pumpswap"                          │
│  Filter: "Program log: Instruction: CreatePool"                         │
│  → fetchTokenMintFromTx → rug check (pump* mints only)                  │
│  → sendTokenAlert()  [discord/discord.ts]                               │
│  → Discord: DISCORD_CHANNEL_ID                                          │
│  → storeTokenAlert (Prisma) → PnL periodic checks                       │
│  Metrics HTTP: METRICS_PORT (default 3030) /metrics                     │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                    OPTIONAL: yarn pumpfun15k                            │
│  discord/discord-pumpfun-15k.ts                                         │
│  Stores new Pump.fun mints in Prisma PumpFunToken                       │
│  Polls until MC ~15k then alerts PUMPFUN_15K_DISCORD_CHANNEL_ID         │
│  ⚠️ package.json script path is wrong (see Known Issues)                │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│  Shared libraries                                                       │
│  transactions.ts     – tx parse, Jupiter swap, rugcheck                 │
│  services/*          – Moralis, PumpSwap helpers, Sniperoo, PnL         │
│  config.ts           – pools, fees, rug filters, simulation flags       │
│  prisma              – Wallet, TokenAlert, PumpFunToken, etc.           │
└─────────────────────────────────────────────────────────────────────────┘
```

**Important:** These are separate Node processes. Running only `yarn pumpfun` does **not** send PumpSwap/migration alerts. Running only `yarn dev` does **not** send new Pump.fun mint alerts.

---

## 3. Pump.fun vs PumpSwap — What Works

### 3.1 Pump.fun — new token creation ✅ WORKING (notify path)

**Program ID:** `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` (`PUMP_FUN_PROGRAM` in `src/constants.ts`)

**Flow:**
1. `src/pumpfun-sniper.ts` opens WebSocket to `GEYSER_RPC`.
2. Subscribes with `logsSubscribe` mentioning Pump.fun program.
3. On log containing `Program log: Instruction: InitializeMint2`, queues the signature.
4. `fetchTokenMintFromTx(signature)` reads post-token balances for the mint.
5. Reads bonding-curve PDA for price / MC / liquidity.
6. Calls `sendPumpFunAlert(mint)` from `src/discord/discord-pumpfun.ts`.
7. Discord embed: **"NEW PUMP.FUN TOKEN DETECTED"** with MC, liquidity, bonding progress bar, socials, trading buttons.
8. Channel: `PUMPFUN_DISCORD_CHANNEL_ID` (bot: `DISCORD_BOT_TOKEN` — note there is also unused `PUMPFUN_DISCORD_BOT_TOKEN` in `.env`).

**Rug check on this path:** Currently **commented out** in `pumpfun-sniper.ts` — alerts go out without rug filtering.

**Env required:**
- `GEYSER_RPC` (WSS)
- `RPC_ENDPOINT`
- `DISCORD_BOT_TOKEN`
- `PUMPFUN_DISCORD_CHANNEL_ID`
- Prefer also `HELIUS_HTTPS_URI` (used by discord-pumpfun connection fallback)

---

### 3.2 PumpSwap / graduated pool alerts ✅ INTENDED & PARTIALLY WIRED

This is the **main** `yarn dev` / `src/index.ts` path. Config labels it **`pumpswap`**.

**Config (`src/config.ts`):**
```ts
{
  enabled: true,
  id: "pump1",
  name: "pumpswap",
  program: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", // same as Pump.fun bonding program
  instruction: "Program log: Instruction: CreatePool",
}
```

Raydium pool watch is present but **`enabled: false`**.

**Flow:**
1. Subscribe to Helius WSS for each enabled pool program.
2. On logs containing configured `CreatePool` instruction → process signature.
3. Extract mint via `fetchTokenMintFromTx`.
4. If mint ends with `pump`:
   - Run `getRugCheckConfirmed` (Rugcheck → SolSniffer fallback).
   - If pass → `sendTokenAlert(mint, true)`.
5. If mint does **not** end with `pump`:
   - Skip rug check; still call `sendTokenAlert` — but **`sendTokenAlert` itself skips non-`pump` mints**, so Discord is silent.
6. If `config.rug_check.simulation_mode === true` (current default): **no Jupiter buy** — alert only.
7. On successful alert for pump tokens: `storeTokenAlert` → Prisma `TokenAlert` for PnL tracking.

**Discord (`sendTokenAlert` in `discord/discord.ts`):**
- Channel: `DISCORD_CHANNEL_ID`
- Title style: **"New Token Launch Detected"**
- Minimum market cap gate: **`$15,000`** (`MINIMUM_MARKET_CAP`)
- Enriches with Moralis (`tokenDataService`); internal bundle/sniper forensics are pending
- Stores alert for PnL; `startPeriodicChecks(client)` runs from `index.ts`

**This is the “PumpSwap / migration / pool create” Discord notify path** the project uses today — even though the subscribed program ID is still the Pump.fun program, not the standalone PumpSwap AMM ID.

---

### 3.3 PumpSwap helper module — EXISTS BUT NOT WIRED ⚠️

`src/services/pumpSwapService.ts` defines the **real** PumpSwap AMM program:

| Constant | Value |
|----------|--------|
| `PUMPSWAP_PROGRAM_ID` | `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` |
| `PUMP_FUN_PROGRAM_ID` | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` |
| `PUMP_FUN_RAYDIUM_MIGRATION` | `39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg` |

Helpers: `isPumpSwapPoolCreation`, `isBondingCurveComplete`, `verifyPumpFunMigration`, `getTokenMintFromLogs`, etc.

**None of these are imported by `index.ts`.**
`index.ts` also defines local helpers `isHighWsolPoolCreation` / `getTokenMintFromLogs` (look for `Create_pool` + WSOL > 80) that are **never called** by the active message handler — the live filter is only the config instruction string `CreatePool`.

**Implication for the next AI:**
- Discord **can** notify for both Pump.fun (process A) and pool-create / “pumpswap”-labeled path (process B).
- True AMM program `pAMMBay...` subscription is **not** live yet; fixing that (and wiring `pumpSwapService`) is a clear next upgrade.

---

## 4. Discord Surface Map

| Bot / module | File | Channel env | Trigger | Status |
|--------------|------|-------------|---------|--------|
| Main launch alerts | `discord/discord.ts` | `DISCORD_CHANNEL_ID` | Pool CreatePool via `index.ts` | Working path (pump mints, MC ≥ 15k) |
| New Pump.fun mints | `discord/discord-pumpfun.ts` | `PUMPFUN_DISCORD_CHANNEL_ID` | InitializeMint2 via `pumpfun-sniper.ts` | Working |
| 15k MC monitor | `discord/discord-pumpfun-15k.ts` | `PUMPFUN_15K_DISCORD_CHANNEL_ID` | DB poll after mint store | Implemented; npm script path broken |
| PnL alerts | `tokenTrackingService.ts` | `PNL_DISCORD_CHANNEL_ID` | Periodic PnL ≥ ~50% | Wired when `yarn dev` runs |
| Daily PnL summary | `tokenTrackingService.ts` | `DISCORD_PNL_SUMMARY_CHANNEL_ID` | Scheduled in periodic checks | Wired when `yarn dev` runs |
| Slash commands | `discord/commands/*` | — | buy/sell/wallet/config | Present; registration mostly commented out in `discord.ts` |

Shared bot token in practice: `DISCORD_BOT_TOKEN`.

---

## 5. npm Scripts

| Script | Command | Purpose |
|--------|---------|---------|
| `yarn dev` | `ts-node src/index.ts` | Main listener + Discord launch alerts + PnL |
| `yarn pumpfun` | `ts-node src/pumpfun-sniper.ts` | New Pump.fun mint Discord alerts |
| `yarn pumpfun15k` | `ts-node src/discord-pumpfun-15k.ts` | **Broken path** — file is `src/discord/discord-pumpfun-15k.ts` |
| `yarn tracker` | `ts-node src/tracker/index.ts` | SQLite holdings TP/SL monitor |
| `yarn server` / `server:dev` | `src/server.ts` | Older Express + WS listener (overlap with index) |
| `yarn daily` | `test-daily-summary.ts` | Manual daily summary test |
| `yarn build` / `start` | `tsc` / `node dist/index.js` | Production build of main entry |

---

## 6. Key Source Map

```
src/
├── index.ts                 # Main WSS sniper (pumpswap-labeled CreatePool) + Discord + PnL
├── pumpfun-sniper.ts        # Pump.fun InitializeMint2 sniper + Discord
├── oldpumpfun.ts            # Legacy / unused pumpfun logic
├── config.ts                # Pool list, swap fees, rug rules, simulation_mode, sniperoo
├── constants.ts             # Pump.fun program IDs, bonding curve layout
├── transactions.ts          # Tx fetch, Jupiter swap/sell, rugcheck/solsniffer
├── server.ts                # Alternate Express control API + listener
├── grok.ts                  # Grok AI token analysis → Discord update helper
├── callStats.ts             # Discord call/reaction stats analyzer
├── discord/
│   ├── discord.ts           # Main alerts (sendTokenAlert), PnL client export
│   ├── discord-pumpfun.ts   # sendPumpFunAlert
│   ├── discord-pumpfun-15k.ts
│   └── commands/            # buy, sell, wallet, config (Sniperoo-backed)
├── services/
│   ├── pumpSwapService.ts   # PumpSwap IDs + detection helpers (unused by index)
│   ├── tokenDataService.ts  # Moralis price/metadata/swaps
│   ├── tokenTrackingService.ts # TokenAlert store, PnL, daily summary, canvas cards
│   ├── sniperDataService.ts
│   ├── sniperooService.ts   # External Sniperoo API + Prisma wallets
│   └── tradingService.ts    # Jupiter trading singleton
├── tracker/                 # SQLite holdings auto-sell loop
├── pumputils/               # Anchor IDL + buyToken on bonding curve
└── utils/                   # env-validator, jito, apiUtils, keys
prisma/schema.prisma         # Wallet, UserConfig, PumpFunToken, TokenAlert, tx/balances
```

---

## 7. Data Stores

### PostgreSQL (Prisma)

- `Wallet` / `UserConfig` / `WalletTransaction` / `WalletBalance` — Sniperoo user trading
- `PumpFunToken` — 15k monitor queue (`mint`, `alerted`)
- `TokenAlert` — launch alerts for PnL (`initialMarketCap`, `pnlAlerted`, etc.)

`DATABASE_URL` required for PnL / 15k / Sniperoo features.

### SQLite

- `src/tracker/holdings.db` (path from `config.swap.db_name_tracker_holdings`) — post-buy holdings for TP/SL tracker.

---

## 8. External Integrations

| Service | Role |
|---------|------|
| Helius HTTPS + WSS | RPC, logSubscribe (`yarn dev`) |
| Geyser / custom WSS (`GEYSER_RPC`) | Pump.fun mint listen |
| Moralis | Token price, metadata, swaps |
| Jupiter Quote/Swap | Buys/sells (when not in simulation) |
| DexScreener | SOL price / pair prices |
| Pump.fun frontend API | Coin metadata, SOL price (pumpfun Discord) |
| Rugcheck.xyz | Primary security report |
| SolSniffer | Rugcheck fallback |
| Birdeye | Optional / fallback market data |
| Sniperoo API | Custodial wallets + buys |
| Grok (`GROK_API_KEY`) | Optional AI commentary on alerts |
| Discord | Alerts / PnL / summaries |

---

## 9. Config Knobs That Matter Now

From `src/config.ts` (current defaults as of snapshot):

- **`liquidity_pool[0]`** (`pumpswap`): **enabled** — this drives Process B Discord.
- **`liquidity_pool[1]`** (Raydium): **disabled**.
- **`rug_check.simulation_mode: true`** — Discord + analysis only; **no live swaps** on `index.ts`.
- **`rugSafe.simulation_mode: true`** — same idea for alternate rug gate.
- **`swap.amount`**: `"1000000"` lamports comment says 0.1 SOL (verify before going live).
- **`sell.auto_sell` / stop_loss / take_profit** — used by tracker path.
- **`sniperoo.enabled: true`** — Discord command / auto-buy plumbing exists; slash registration largely commented out.

Discord MC filter (hardcoded in `discord.ts`, not config): **`MINIMUM_MARKET_CAP = 15000`**.

---

## 10. Environment Variables (names only)

**Core sniper (`yarn dev`):**
`PRIV_KEY_WALLET`, `HELIUS_HTTPS_URI`, `HELIUS_WSS_URI`, `HELIUS_HTTPS_URI_TX`, `JUP_HTTPS_*`, `DEX_HTTPS_LATEST_TOKENS`, `DISCORD_BOT_TOKEN`, `DISCORD_CHANNEL_ID`, `MORALIS_API_KEY`, `METRICS_PORT`, `DATABASE_URL`, `PNL_DISCORD_CHANNEL_ID`, `DISCORD_PNL_SUMMARY_CHANNEL_ID`

**Pump.fun sniper (`yarn pumpfun`):**
`GEYSER_RPC`, `RPC_ENDPOINT`, `DISCORD_BOT_TOKEN`, `PUMPFUN_DISCORD_CHANNEL_ID`

**15k monitor:**
`RPC_ENDPOINT_15K`, `PUMPFUN_15K_DISCORD_CHANNEL_ID`, `DATABASE_URL`

**Optional:**
`SOLSNIFFER_API_KEY`, `GROK_API_KEY`, `BIRDEYE_API_KEY`, `SNIPEROO_API_KEY`, `RUGCHECK_PRIVATE_KEY`, pump buy flags (`IS_JITO`, `JITO_FEE`, `PRIVATE_KEY`, …)

Do not commit `.env`. Secrets are already present locally for development.

---

## 11. Runtime Behavior Summary

### Working today (with correct env + both processes)

1. **Notify Discord from Pump.fun** — new mints → `PUMPFUN_DISCORD_CHANNEL_ID`.
2. **Notify Discord from pool CreatePool path labeled pumpswap** — pump mints, rug pass, MC ≥ 15k → `DISCORD_CHANNEL_ID`.
3. **PnL follow-up + daily summary** — when main process is running and DB is up.
4. **Rugcheck pipeline** — used on main path for `*pump` tokens.
5. **Moralis enrichment** — main Discord embeds.
6. **Simulation mode** — live trading disabled by default.

### Partial / dormant

- `pumpSwapService.ts` (correct AMM ID) unused.
- High-WSOL (>80) filters defined but unused in live WS handler.
- Raydium listener disabled in config.
- Discord slash trading commands mostly disabled.
- `handleWebsocketMessage` auto-buy loop at bottom of `index.ts` is **dead code** (never hooked to WS).
- `server.ts` duplicates older listener without Discord alerts.
- Grok analysis helpers exist; not central to the two notify paths.
- `package.json` `pumpfun15k` points at wrong file path.

---

## 12. Known Issues / Pitfalls for Next Work

1. **Program ID mismatch for “pumpswap”**
   Config name says pumpswap but program is Pump.fun bonding program. Real AMM is `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`. Validate on-chain which program emits the `CreatePool` logs you care about, then subscribe to the correct one(s).

2. **`pumpSwapService` not integrated** — wire into `index.ts` or replace duplicated log parsers.

3. **Two Discord bots / channels must both be running** for full coverage (Pump.fun + PumpSwap/pool).

4. **`sendTokenAlert` hard-filters `mint.endsWith('pump')`** — non-pump graduations never alert even if detected.

5. **`yarn pumpfun15k` broken** — fix script to `ts-node src/discord/discord-pumpfun-15k.ts`.

6. **Simulation mode on** — turning on live buys needs intentional config + wallet funding + fee review.

7. **Duplicate Discord clients** — `discord.ts` and `discord-pumpfun.ts` each `client.login` the same token if both processes run (OK as separate processes; do not import both into one process without care).

8. **README vs reality** — README still describes Raydium-first and yarn scripts that don’t match all behaviors; trust this file + source over README for architecture.

---

## 13. Suggested Continuation Priorities

1. Confirm live CreatePool logs: Pump.fun program vs PumpSwap AMM (`pAMMBay...`); update `config.liquidity_pool` accordingly (keep **both** Pump.fun mint alerts and PumpSwap pool alerts).
2. Import and use `pumpSwapService` for detection / migration verification; remove dead local helpers or call the WSOL>80 filter if still desired.
3. Fix `pumpfun15k` script path; decide if 15k monitor overlaps with main `MINIMUM_MARKET_CAP` gate.
4. Unify Discord alert formatting / channels if product wants clearer “Pump.fun mint” vs “PumpSwap graduated” labels.
5. Before live trading: set `simulation_mode: false`, audit swap amount/slippage/priority fees, test with tiny size.
6. Clean dead code (`handleWebsocketMessage`, commented slash cmds) or re-enable intentionally.

---

## 14. Quick Start for Another AI

```bash
# Terminal 1 — PumpSwap / pool CreatePool Discord (DISCORD_CHANNEL_ID)
yarn dev

# Terminal 2 — Pump.fun new mint Discord (PUMPFUN_DISCORD_CHANNEL_ID)
yarn pumpfun

# Optional holdings TP/SL
yarn tracker
```

Ensure `.env` has Helius, Geyser, Discord tokens/channels, Moralis, and `DATABASE_URL` as needed.

**Verify both notify paths:**
- Mint a / watch a new Pump.fun create → channel A.
- Watch a CreatePool / graduation matching config → channel B (pump mint, MC ≥ 15k, rug pass).

---

## 15. One-Line Truth

**Yes — the project can notify Discord for both Pump.fun (new tokens) and the pumpswap-labeled pool-create path; they are two separate processes (`yarn pumpfun` + `yarn dev`). PumpSwap AMM helpers exist (`pumpSwapService`) but the live subscriber still uses the Pump.fun program ID in config — wiring the real AMM ID is the main architectural gap.**
