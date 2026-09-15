# Phase 7D.4 — implementation matrix

Brief: `only-pump-me/phase7d4.txt`. Started 2026-09-15.

**Precondition checked first:** the 2026-09-14 test-orphaning incident was repaired on 2026-09-15 (`ARCHITECTURE.md` §26.4). 15,275 of 15,275 V2 tokens are canonical and 254 are graduated with PoolIds. The gaps below are real data-path defects, not damaged data.

**Status legend:** **done** (implemented and tested on this branch) · **partial** · **gap** (not built yet) · **blocked** (needs something outside the code).

## 1. Discovery and filtering

| User action / field | Source | Backend | Frontend | Status / gap |
|---|---|---|---|---|
| Pick a chain | URL state | `GET /tokens/robinhood` only; no chain parameter | Two independent selects (header and Explore); the header's changes nothing; filtering is client-side over 25 rows | **gap**: one state owner in the URL, a chain-aware list API, server pagination and counts, cancellation of stale requests |
| Solana tokens | none | No Solana discovery endpoint or ingestion (`TokenIntelligenceReport` rows come from the legacy listener, which isn't running) | Pump.fun / LaunchLab / Bonk.fun toggles look active | **gap**: label Solana discovery "not connected" and disable its providers; never substitute another chain's tokens |
| Pair label | `TokenLaunched.pairToken` | Address only | Anything non-native renders as "ERC-20" | **gap**: quote asset registry (symbol, decimals, verified on chain), returned on every row |
| "Analyzing" badge | none | No job state for Pons tokens | Hard-coded `riskPending: true` | **gap**: show only when backed by a real job |

## 2. Metadata and artwork

| Field | Source | Backend | Frontend | Status / gap |
|---|---|---|---|---|
| Name / symbol | ERC-20 reads during discovery enrichment | done | done | done |
| Logo / description / socials | `launchToken()` calldata; Blockscout trace fallback | done (`richMetadataStatus`) | done | Blockscout is behind a Cloudflare challenge from this host (2026-09-15), so bundler-routed launches stay UNAVAILABLE |
| Artwork delivery | `ipfs://` via gateways | `TokenImageCache`: SSRF-guarded, byte-sniffed, retries with backoff | Backend-served URL, placeholder | **partial**: gateway 429s are not distinguished from permanent failure in the API; no live push when artwork arrives |
| Alchemy `alchemy_getTokenMetadata` | `ROBINHOOD_RPC_HTTPS3` (name, symbol, decimals; logo always null) | not wired | — | **gap**: optional Alchemy-only fallback, kept out of generic failover |
| Per-field provenance and timestamps | — | only a status per group | — | **gap** |

## 3. Market data

| Field | Source | Backend | Frontend | Status / gap |
|---|---|---|---|---|
| Pre-graduation trades | `PonsV2BondingCurve` `CurveBuy` / `CurveSell` (Sourcify exact match) | **done**: `CurveTradeListener`, emitter-checked, with real fixtures | — | Live ingestion started 2026-09-15 from the first V2 launch in the DB. It trails V2 discovery (next row). Curves launched before discovery history are dropped until discovery is backfilled |
| Post-graduation trades | V4 `Swap` by PoolId | `TradeV2Listener` | — | Barriered behind V2 discovery |
| V2 discovery progress | factory logs | **done**: `RANGE_LIMIT` failover moves wide `eth_getLogs` past Alchemy's 10-block free tier | — | **blocked (throughput)**: only the public default RPC serves wide ranges and it rate-limits, so roughly 9 hours to catch up 1.6M blocks. A paid RPC plan removes this |
| Candles | `ChainTrade` | **done**: fixed native-quote decimals, token selection, per-token venue, multi-stream finality | chart exists | Verify live once trades exist |
| Native price, quote asset | quote snapshot / trades | market evidence (spot) | Market evidence tab | **partial**: not in the terminal header |
| USD price | Chainlink on Robinhood Chain: ETH/USD `0x78F3…d3A9`, USDG/USD `0x61B7…9aD2`, CBBTC/USD `0x0009…a21a`; 8 decimals, 24h heartbeat, 0.5% deviation. Verified on chain 2026-09-15; directory https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json | not wired | "Unavailable" | **gap**: per-asset feed mapping, staleness rules (equity feeds are 24/5), and historical rounds at trade time |
| Market cap / FDV | `totalSupply` (enrichment) × price | supply stored | "Unavailable" | **gap**: FDV = total supply × price, labelled as such; circulating supply unknown and stated explicitly |
| Liquidity / depth | curve reserves or V4 quoter at reference sizes | market evidence | tab | done (raw V4 liquidity never shown as reserves) |
| Rolling volume 5m/15m/30m/1h/24h, buys/sells, price change | `ChainTrade` | not built | "Unavailable" | **gap**: windows from deduplicated trades, with coverage |
| Recent trades | `ChainTrade` | token detail returns trades | "Coming soon" tab | **gap** |
| Holders | not indexed | — | "Unavailable" | Stays unavailable, labelled |

## 4. Terminal presentation

| Element | Status / gap |
|---|---|
| Collapsible sidebar, compact header, large chart, Practice panel right, trades/evidence/positions below; mobile sheet | **gap** |
| Backend issue numbers on product screens ("Tracking: Solana-sniper-moralis-api#10") | **gap**: remove; group unfinished tabs as "Coming soon" |
| Connection status vs data freshness; no-trades vs missing-history vs stale vs error | **partial** |

## 5. Guided practice

| Element | Backend | Frontend | Status / gap |
|---|---|---|---|
| Quote → simulate → paper position, per user, idempotent | done (7D.3.2) | done | reused underneath |
| Portfolio with virtual balance per quote currency; overspend and oversell prevention | — | — | **gap** |
| Trade plan, journal, entry/exit, close and review against plan | — | — | **gap** |
| Lesson A–H and self-directed mode; "Paper money · Live market data" | — | — | **gap** |
| "Below pre-trade price" figure | `shortfallVsSpotBps`: (spot-implied output − quoted output) / spot-implied output, fees included | shown as a percentage | **gap**: relabel as an all-in cost versus the pre-trade price, separate from slippage tolerance |
| PnL after modelled costs; indicative value vs estimated exit proceeds | — | — | **gap** |

## 6. Achievements

| Element | Status / gap |
|---|---|
| Four learning achievements, deduplicated server-side, reduced-motion aware | **gap** |

## 7. Vanity generator handoff

| Finding | Detail |
|---|---|
| Mechanism | `OnlyPump-Vanity-Generator` (Rust, `src/vanity.rs`) grinds **Solana ed25519 keypairs** whose base58 public key ends in `pump`, for pump.fun mint accounts. The output is a keypair, not deterministic deployment parameters; the mint must sign creation, so a server-side secret is inherent |
| **Security** | `test_pump.json` (215 keypairs **with private keys**) is committed to the **public** GitHub repo. The frontend `public/` folder ships `test_pump.json`, `test_fan.json` and `vanity-keypairs.json` (281 private keys). As of 2026-09-15 they are **served by https://onlypump.me** (HTTP 200, `application/json`). All of these keypairs must be treated as burned |
| Handoff | **gap**: versioned public JSON (address, chain, type, reservation ID, status), private material behind a server-side secret reference, atomic reservation and consumption, Launch UI showing availability. Robinhood Chain (EVM) launches go through the Pons factory and have no keypair-based vanity path; it is not claimed |

## Blockers needing the owner

1. **RPC throughput.** Robinhood Chain RPC with wide `eth_getLogs` ranges (paid Alchemy or an equivalent). The primary and second keys are quota-exhausted, and the third is free tier.
2. **Keypair exposure.** Redeploy the site without the keypair JSON files. Decide whether to rewrite the public vanity repo's history.
3. **Blockscout access.** It is blocked by Cloudflare from this host; bundler-routed metadata recovery and verified-source checks depend on it.
