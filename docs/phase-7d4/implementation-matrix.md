# Phase 7D.4 — implementation matrix

Brief: `only-pump-me/phase7d4.txt`. Started 2026-09-15.

**Precondition checked first:** the 2026-09-14 test-orphaning incident was repaired on 2026-09-15 (`ARCHITECTURE.md` §26.4). 15,275 of 15,275 V2 tokens are canonical and 254 are graduated with PoolIds. The gaps below are real data-path defects, not damaged data.

**Delivery state (2026-09-15):** the tables below were the starting gap analysis; each row now carries its delivered status. Backend branch and frontend branch `feature/phase-7d4-market-terminal-practice`, both unmerged.

**Status legend:** **done** (implemented and tested on this branch) · **partial** · **gap** (not built yet) · **blocked** (needs something outside the code).

## 1. Discovery and filtering

| User action / field | Delivered | Status |
|---|---|---|
| Pick a chain, tab, search, provider | URL search params are the only owner (`discoveryParams.ts`); header and Explore write the same params; server-side `lifecycle`, `q`, cursor pagination and `total`; stale requests aborted through React Query signals | **done** — browser check `discovery-check.cjs` 11/11 |
| Solana tokens | `GET /discovery/chains` reports Solana `UNAVAILABLE` with its providers labelled; the feed says "not connected" and never substitutes Robinhood tokens | **done** (Solana discovery itself remains **gap**) |
| Pair label | `quoteAsset` on every row from the official registry (WETH/USDG from docs.robinhood.com/chain/contracts, stock tokens from api.robinhood.com/rhj/assets); unknown pairs say "Unknown pair" | **done** — 99.6% identified |
| "Analyzing" badge | removed unless backed by a real risk job | **done** |

## 2. Metadata and artwork

| Field | Delivered | Status |
|---|---|---|
| Name / symbol / decimals gaps | `alchemyMetadataFallback.ts`: Alchemy-only, fills null fields only, per-field `metadataProvenance`, daily negative cache, decimals conflicts recorded not applied | **done** (Alchemy named 1 of 12 nameless tokens tried) |
| No downgrade | discovery updates never overwrite `FOUND` rich metadata | **done** |
| Artwork | queued at discovery without a viewer; newest never-tried logos first, concurrent fetches; PNG/JPEG/GIF/WebP byte-sniffed; distinct PENDING/READY/FAILED/REJECTED; bounded backoff | **done** — `artwork-check.cjs`: card listed with placeholder, artwork arrived 17 s later without refresh |
| IPFS gateways | ipfs.io and dweb.link returned 429 for every CID tried; Filebase and Pinata served them | **config** — `TOKEN_IMAGE_IPFS_GATEWAYS` |
| Blockscout recovery for bundler launches | Cloudflare challenge from this host | **blocked** |

## 3. Market data

| Field | Delivered | Status |
|---|---|---|
| Pre-graduation trades | `CurveTradeListener` (CurveBuy/CurveSell, emitter-checked, block-hash verified) | **done**; ingestion trails the tip (RPC throughput) |
| Candles | native decimals, forward token selection, per-token venue, multi-stream finality | **done** |
| USD | `ChainlinkQuoteUsdRateProvider`: feed description/decimals verified, heartbeat staleness, historical round at trade time, chain liveness in place of a sequencer feed | **done** — 96.2% of tokens have a USD feed |
| Price, FDV, supply | `GET /tokens/robinhood/:address/market`; FDV = total supply × last price; circulating supply stated as not indexed | **done** |
| Rolling 5m/15m/30m/1h/24h volume, buys/sells, change | per-window coverage COMPLETE/PARTIAL/NONE; zero only when complete; USD only when every trade valued | **done** |
| Recent trades | latest 50 | **done** |
| Holders | not indexed | labelled unavailable |

## 4. Terminal

| Element | Status |
|---|---|
| Collapsible token sidebar, compact stat bar, large chart (subscript-zero price axis), Practice right, trades/evidence below, mobile sheet | **done** — `terminal-check.cjs` 13/13 |
| Backend issue numbers removed from product screens | **done** |
| No-trades vs partial history vs stale vs error states | **done** |

## 5–6. Guided Practice and achievements

| Element | Status |
|---|---|
| Portfolios, balances, holdings, plans, trades, reviews, journal, lesson progress; serializable ledger, CHECK constraints, idempotent writes, two-user isolation | **done** — service 7 + routes 3 DB tests |
| Overspend/oversell prevention; PnL after costs; indicative value vs estimated exit proceeds | **done** |
| "Below pre-trade price" | audited: it is the all-in shortfall vs the spot-implied output, fees included; relabelled "Total cost vs the pre-trade price", separate from slippage tolerance | **done** |
| Curve exits the curve cannot pay (`sell()` Panic 0x11 when quoteOut > trackedQuote) | refused as `CURVE_CANNOT_PAY` with a plain explanation | **done** |
| Lesson (8 steps derived from facts), self-directed mode, "Paper money · Live market data" | **done** — `practice-journey.cjs` 20/20 |
| Four learning achievements, server-deduplicated, reduced-motion toasts | **done** |

## 7. Vanity generator handoff

| Element | Delivered | Status |
|---|---|---|
| Mechanism | Solana ed25519 keypairs ending in `pump` (pump.fun mint, must co-sign create). Robinhood: Pons factory assigns addresses → `UNSUPPORTED` | documented |
| Secrets | AES-256-GCM keystore files (0600) under `VANITY_KEYSTORE_DIR`, key `VANITY_KEYSTORE_KEY`; DB stores `keystore:v1:<address>` only; no secret or reference in user responses or the bundle | **done** |
| Import | derive public key from secret, suffix, refuse the 283 publicly exposed addresses (`exposedVanityAddresses.json`, public keys only), refuse accounts that exist on chain or cannot be checked; dry run by default | **done** — dry run on the generator's `test_pump.json`: 215/215 refused `PUBLICLY_EXPOSED` |
| Reserve / release / consume | `FOR UPDATE SKIP LOCKED`, per-user advisory lock, 15-minute TTL, idempotent; consume is internal-API-key only and signs/broadcasts nothing | **done** — service 6 + routes 3 DB tests |
| Public JSON | `VanityHandoffV1` (version, reservationId, chain, address, generationType, suffix, status, times, `deployed: false`, deployment params) | **done** |
| Launch UI | stock, reserve, reserved address "Not deployed", copy, release, Robinhood explanation | **done** — `vanity-check.cjs` 13/13 |

## Blockers needing the owner

1. **RPC throughput.** A Robinhood Chain RPC plan that serves wide `eth_getLogs` ranges. On 2026-09-15 V2 discovery was at block 62,365,442 and curve trades at 61,051,509 against a tip of 63,681,551. Until it catches up, no actively traded token shows live-updating candles.
2. **Exposed keypairs.** Redeploy onlypump.me without the removed JSON files; decide on rewriting the public vanity repo's history; the 283 addresses are refused by import regardless.
3. **Credential rotation.** Helius keys formerly hardcoded in the frontend, E2E user B's password (printed once by a Playwright call log), `ROBINHOOD_RPC_HTTPS2` key, Supabase secret key.
4. **Blockscout access** from the server host.
5. **Solana discovery** has no ingestion; it is labelled unavailable.
