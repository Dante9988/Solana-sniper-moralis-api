# Architecture & Handoff Guide

> Source of truth for how this repository works **today** (Phases **1–6**, **X**, **7A–7B.5B**, **7D–7D.5**, **7F.2**, plus the trading/Telegram surface merged from the `main2` branch).
> Companion docs: [README.md](./README.md) (operator overview), [RUNBOOK.md](./RUNBOOK.md) (running the stack locally), [PHASE_7D_ROBINHOOD_V2_AND_LAUNCHPAD.md](./PHASE_7D_ROBINHOOD_V2_AND_LAUNCHPAD.md) (Pons V2 ingestion), [docs/phase-7d3-2-quote-verification.md](./docs/phase-7d3-2-quote-verification.md) (quote verification record), [evm-verification/README.md](./evm-verification/README.md) (Foundry harness), [src/intelligence/README.md](./src/intelligence/README.md) (intelligence danger zone), [src/forensics/README.md](./src/forensics/README.md) (forensics danger zone).

**Snapshot date:** 2026-09-14 (UTC)
**Canonical branch:** `main` (fast-forwarded to `master`'s tip in Phase 7B.1 — see §16.1; `master` still exists, unused going forward)
**Latest commits:** `88d6ec4` (PR #23 merged 2026-09-19: Phase 7D.4 market data, live market snapshots, Trending, guided Practice ledger, vanity address handoff; §27), `b0779c4` (PR #22 merged 2026-09-19: Phase 7D.3.3 follow-up — CORS for :8080, docs, verified repair of the test-orphaned V2 launches; §26.4), `a097263` / `3d366a5` / `8b7963c` (Phase 7D.3.3: CORS for the web app's Vite port and `Idempotency-Key`, and the disposable-database guard for DB test suites; §26, merged as PR #21), `b1de963` (PR #20 merged: Phase 7D.3.2 block-pinned quotes, route simulation, evidence snapshots, paper positions, logo cache, Foundry fork verification; §25), `cab5784` (PR #19: Phase 7D.3.1 RPC failover, WebSocket recovery, block pinning; §24), `c29780a` (PR #18: Phase 7D.3 operational ingestion and V4 pool evidence; §24), `eab698c` (PR #17: Phase 7F.2; §22), `1ef81be` (PR #16: Phase 7D Pons V2 and Uniswap V4; §23), `3d049e4` (Phase 7B.5B: the first candle/OHLCV service backed by canonical `ChainTrade` — §21; on top of `953cc2e`'s carried-forward schema draft, branch `feature/phase-7b5b-canonical-ohlcv`), `9b2a892` (Phase 7B.5A: Pons ingestion hardening — coordination barrier, reorg recovery, pool-set scaling, batch enrichment, source-health — §20), `874166f` (Phase 7B.4: Robinhood Chain / Pons discovery, trades, graduation, checkpoints and API — §19), `a1c4507` (Phase 7B.3A1: Pump.fun/PumpSwap lifecycle decoders and normalized trades — §18), `414f068` / `b505e9f` (Phase 7B.2: wallet ownership and realtime jobs — §17), `e88b3e6` (Phase 7B.1: canonical `/api/v1` gateway — §16), `7ba40f4` (Phase 7A.1: restored init migration and real Postgres CI — §11), `4ee49ca` (Phase 7A: non-custodial trading and access controls — §8).

**Stack:** TypeScript / Node (CI runs Node 20), Solana Web3.js, **viem** (Robinhood Chain HTTP/WSS RPC with multi-key failover), **Foundry 1.8.1** (Solidity fork verification in `evm-verification/`, CI only), Discord.js v14, **Telegraf** (Telegram bot), Prisma + PostgreSQL, SQLite holdings tracker, Express (three separate HTTP surfaces — see §8.3), Supabase JWT auth, Zod/OpenAPI, `ws`, Redis via `ioredis` (optional distributed rate limiting/realtime), Helius RPC/WSS, Geyser WSS, Moralis (supported REST only), DexScreener/Birdeye fallbacks, RugCheck/SolSniffer, Jupiter (three independent integrations — see §8.2), Jito (tip-only, not full bundle submission), Anthropic Claude (AI synthesis), canonical cross-chain research assets, X API (read-only checkpoint), Vitest.

---

## ⚠️ 0. Read this before running `npm run dev`

> **Phase 7F.2 update (§22):** three startup defects were fixed here — a Telegram bot token printed to stdout on every boot (**rotate any token that booted the old code**), every periodic check registered twice so **each PnL card posted to Discord twice**, and a second `client.login()` in `main()` that hung forever and silently skipped everything after it. Running this repo locally with the *production* `TELEGRAM_BOT_TOKEN` will also fight the production instance for Telegram's polling lock (`409 Conflict`); use a separate test bot or leave Telegram unset.

> **Phase 7D.3.3 update (§26):** the `*.dbIntegration` suites delete checkpoints and run reorg recovery against a fake chain. On 2026-09-14 they were run against the local development database (`solana_bot`) and marked 11,977 real Pons V2 launches `ORPHANED`, wiping their graduation data. A vitest global setup now refuses any `*_RUN_DB_TESTS` flag unless the database name looks disposable. The damaged rows were repaired on 2026-09-15 (§26.4). To run the product locally (API, workers, frontend), follow [RUNBOOK.md](./RUNBOOK.md), not `npm run dev`.

This section exists because the single most important fact about the current state of this repository does not fit anywhere else without getting lost: `npm run dev` starts a live Telegram trading bot alongside everything it already did. **As of this snapshot, that bot is non-custodial** (trades are approved in the user's own wallet app — see §8.2) **and its trading commands are allowlisted** (§8.6); its HTTP server (`src/api/index.ts`) is **off by default** and, when enabled, requires a bearer token on every `/api/*` route (§8.3). Full detail is in §8 — read it before changing any of that, and definitely before running with `API_ENABLED=true` on a network-reachable host.

---

## 1. What This Project Is

Four layers share one codebase:

| Layer | Purpose | Trading |
|-------|---------|---------|
| **Legacy listeners + Discord** | Detect Pump.fun mints / pool CreatePool events; alert Discord; optional PnL tracking | Simulation-gated (`config.rug_check.simulation_mode`) — keep disabled for production research |
| **Token intelligence and canonical gateway (Phases 1–6, X, 7B.1–7B.2)** | Research → reports/forensics → PostgreSQL → Supabase-authenticated `/api/v1`; wallet ownership proofs and authenticated realtime scan events (§16–§17) | **Impossible** from the research/presentation path — no execution imports, enforced by automated boundary tests |
| **On-chain discovery and raw trades (Phases 7B.3A1–7B.4)** | Pump.fun/PumpSwap decoding foundation (§18); standalone Pons discovery/trade/graduation worker → durable PostgreSQL checkpoints and facts → Robinhood token read routes (§19) | Read-only chain access; no signing or transaction submission |
| **Telegram/Discord trading bot + trading services** (merged from `main2`, PR #7) | `/buy`, `/sell`, `/wallet connect <public_address>` via Telegram, Discord, and `POST /api/transaction/*` | **Non-custodial and allowlisted** — this bot never generates, imports, or stores a private key; every trade is a Solana Pay link the user approves in their own wallet app (§8.2), and only allowlisted user IDs can invoke trading commands at all (§8.6). Its HTTP server (`src/api/index.ts`) is off by default and bearer-authenticated when enabled (§8.3). |

**Implemented:** everything in the first two layers (event types, orchestrator, researchers, Prisma report store, non-blocking listener dispatch, Anthropic synthesis, Moralis compatibility cleanup, trench.bot removed from runtime, canonical asset identity, deterministic Solana forensics 5A–5E, read-only presentation HTTP API, an X API read-only capability checkpoint) plus, from `main2`: a Telegraf-based Telegram bot with real buy/sell/wallet commands, a `PumpSwapService` and a `JupiterService` trading class, a websocket/API server, PnL/top-calls/simulation reporting scripts.

**Latest additions:** wallet verification and user-scoped realtime jobs; real-chain Pump.fun/PumpSwap event decoding and normalized trades; the `ChainAdapter` contract; Robinhood/Pons ingestion with discovery enrichment, raw trades, graduation polling, transactional checkpoints, and `/api/v1/tokens/robinhood` reads (Phase 7B.4); a discovery-before-trades coordination barrier, bounded automatic reorg rollback/replay, chunked pool-scaling, bounded-concurrency batch enrichment with `PENDING`-row retry, and a backend-owned `/api/v1/tokens/robinhood/status` ingestion source-health projection (Phase 7B.5A, §20). Phase 7B.4 is completed and tested within the boundaries in §19.8–§19.9; Phase 7B.5A within §20.12–§20.13; and now, **the first candle/OHLCV service**: a chain-neutral aggregation engine, a `MarketCandle` materialization, an independently runnable `candles:worker`, reorg-safe full-bucket recomputation driven by the same `reorgRecovery.ts` transaction, `GET /api/v1/tokens/robinhood/:tokenAddress/candles`, and an optional `token.candle.updated` realtime event — Phase 7B.5B, §21, tested and proven within the boundaries in §21.19–§21.20. Since then: Pons **V2** discovery/graduation onto Uniswap V4 with launch metadata (Phase 7D, §23); supervised local processes, a committed OpenAPI contract and read-only V4 pool evidence (Phase 7D.3, §24); multi-key RPC failover, WebSocket recovery and cross-provider block pinning (Phase 7D.3.1, §24); and **block-pinned quotes verified against the real contracts on a fork, route simulation, immutable evidence snapshots, per-user paper positions and a safe token-logo cache** (Phase 7D.3.2, §25), accepted in a real browser with two Supabase test users (Phase 7D.3.3, §26). Nothing in this path signs or broadcasts a transaction. Pons facts are still not connected to the Solana intelligence/scoring pipeline.

**Not implemented yet:** Chroma/RAG, trending history, macro/news beyond the X checkpoint, intelligence → Discord/Telegram notifications, real PumpSwap AMM swap execution (Jupiter is the only working swap path). (`src/api/index.ts` authentication is implemented — bearer-token, fail-closed, off by default — see §8.3.)

The discovery foundation still leaves historical/legacy-factory backfill, Pons scam/rug scoring, momentum ranking, the AI query layer, frontend candle-chart integration (Phase 7B.5C), and a durable Solana adapter behind `ChainAdapter` to later slices. OHLCV/candle aggregation for Robinhood/Pons is now implemented (§21) — the *existing Pump candle/rate tables* (`PumpCandle`/`PumpCandleRevision`/`SolUsdRate`, §18) remain schema foundations only, not running aggregation services; Phase 7B.5B's `MarketCandle`/`CandleInvalidation`/`CandleAggregationCheckpoint`/`CandleWorkerRunState` tables are new and chain-neutral, not a repurposing of those Solana-shaped ones. Automatic reorg reconciliation is implemented as of Phase 7B.5A (§20.2) — see §20.13 for what remains unproven against a live reorg; Phase 7B.5B's candle invalidation is layered directly on top of that same reconciliation transaction (§21.10).

---

## 2. End-to-End Runtime Map

```text
┌─ PROCESS A: npm run pumpfun ─────────────────────────────────────────┐
│  src/pumpfun-sniper.ts                                               │
│  Geyser WSS → Pump.fun program → InitializeMint2                     │
│  → Discord PUMPFUN_DISCORD_CHANNEL_ID                                │
│  ✗ Does NOT enter TokenIntelligenceOrchestrator (by design, Phase 2) │
└──────────────────────────────────────────────────────────────────────┘

┌─ PROCESS B: npm run dev ─────────────────────────────────────────────────────┐
│  src/index.ts                                                                │
│                                                                              │
│  At import time (unconditional):                                            │
│    TelegramBot.getInstance() constructs a Telegraf(TELEGRAM_BOT_TOKEN)      │
│    A top-level IIFE calls telegramBot.initialize() → .launch()             │
│    → live long-polling Telegram bot with real /buy /sell /wallet commands  │
│                                                                              │
│  In main(), gated behind isApiServerEnabled() / API_ENABLED==='true':       │
│    (default false — nothing below this line runs unless set) initApiServer│
│    starts src/api/index.ts: Express on API_HOST:API_PORT (default          │
│    0.0.0.0:3001), every /api/* route requires Bearer API_AUTH_TOKEN        │
│    (fails closed, §8.3); exposes /api/wallet/connect (public address       │
│    only), /api/transaction/{buy,sell} (return a Solana Pay link, never     │
│    execute — §8.2), and the unauthenticated-by-spec /pay/* build routes    │
│                                                                              │
│  Then: Discord client.login, Helius WSS → enabled config.liquidity_pool     │
│  programs, filter CreatePool (currently "pumpswap"-labeled pool)            │
│                                                                              │
│  On mint extracted:                                                         │
│    1) dispatchTokenIntelligence(...)   ← fire-and-forget (Phase 2)         │
│    2) existing Discord / rug / simulation trade flow (unchanged)           │
│    3) WebSocket broadcast to any connected /api/index.ts clients           │
│    4) PnL periodic checks + daily top-tokens report via Discord/Telegram   │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │
                                ▼
┌─ Token intelligence pipeline ────────────────────────────────────────┐
│  tokenIntelligenceDispatch.ts                                        │
│    dedupe(signature:mint) · maxConcurrent=3 · timeoutMs=20s          │
│    deriveTokenSource(programId) → PUMPSWAP | MIGRATION | UNKNOWN     │
│         │                                                            │
│         ▼                                                            │
│  TokenIntelligenceOrchestrator.process()                             │
│    parallel: metadata · market · safety · bundleSniper               │
│    then:     social (needs metadata)                                 │
│    then:     aiSynthesis (Anthropic; optional)                       │
│         │                                                            │
│         ▼                                                            │
│  reportStore.saveReport() → Prisma TokenIntelligenceReport (+evidence│
│                            / errors)                                 │
│         │                                                            │
│         ▼ (Phase 5E, when enabled)                                   │
│  forensics:worker (separate process) → SolanaForensicsRun/Evidence/  │
│  Cluster/Eligibility → reconciled back onto the report                │
│         │                                                            │
│         ▼ (Phase 6, on request)                                      │
│  npm run api (separate process, src/researchApi/) → GET/POST         │
│  /api/v1/tokens/:mint/{report,forensics,scans}, no trade execution   │
└──────────────────────────────────────────────────────────────────────┘

┌─ PROCESS C: npm run forensics:worker (separate, disabled by default) ┐
│  Claims SolanaForensicsJob rows (FOR UPDATE SKIP LOCKED), runs        │
│  deterministic analyzers against Helius, persists runs/evidence.     │
│  FORENSICS_WORKER_ENABLED=false by default — must be explicitly on.  │
└──────────────────────────────────────────────────────────────────────┘

┌─ PROCESS D: npm run api (canonical /api/v1 gateway, §16–§26)        ┐
│  src/researchApi/server.ts — Express, default API_PORT=8787.        │
│  Supabase/API-key auth; Prisma research and Robinhood token reads; │
│  scan enqueue, wallet proofs, authenticated realtime job events.   │
│  Redis connects worker/API events when REALTIME_BACKEND=redis.     │
│  Phase 7D.3.2: quotes/simulations/market evidence read Robinhood   │
│  Chain directly (block-pinned, failover RPC); paper positions and  │
│  evidence snapshots in Postgres; in-process token-logo worker.     │
└──────────────────────────────────────────────────────────────────────┘

┌─ PROCESS E: npm run api:server (main2's standalone read-only API)    ┐
│  src/api-server.ts → src/api/standalone.ts — /health, /, /api/status,│
│  /api/utils/sol-price. No Discord/Telegram/wallet imports, no trades.│
└──────────────────────────────────────────────────────────────────────┘

┌─ PROCESS F: npm run pons:worker (standalone, Phase 7B.4 / 7D)       ┐
│  src/pons/scripts/ponsWorkerMain.ts                               │
│  Robinhood RPC (failover list, §24) →                              │
│    Pons V1 factory TokenLaunched + enrichment                     │
│    Pons V2 factory TokenLaunched / PoolGraduated + launch metadata │
│    → DiscoveredToken + discovery checkpoint in one transaction    │
│  V1 pools → Swap; V2 → Uniswap V4 PoolManager Swap by PoolId      │
│    → ChainTrade + trade checkpoint                                 │
│  V1 graduationStatus(token) polling → DiscoveredToken state       │
│  PostgreSQL → PROCESS D /api/v1/tokens/robinhood[/tokenAddress]    │
│  Source block/hash checkpoints support resume and reorg recovery. │
└──────────────────────────────────────────────────────────────────────┘

┌─ PROCESS G: npm run candles:worker (standalone, Phase 7B.5B)        ┐
│  src/candles/scripts/candlesWorkerMain.ts                         │
│  ChainTrade → MarketCandle (7 resolutions, provisional/final,      │
│  reorg-safe recompute) → /api/v1/tokens/robinhood/:token/candles  │
└──────────────────────────────────────────────────────────────────────┘

PROCESS D, F and G are what the web app needs; scripts/dev-stack.sh
supervises all three with one-owner protection (RUNBOOK.md).
```

**Rule (intelligence layer only):** listeners are event sources; analysis lives under `src/intelligence/**`; Discord alerts and intelligence are parallel, not substitutes. **This rule does not extend to the Telegram/API trading surface** — that surface has its own, separate path from a chat command or an HTTP request to a trade, but (unlike when this line was first written) that path is now allowlisted (§8.6) and non-custodial: it ends at an unsigned Solana Pay transaction request the user's own wallet must approve, never a transaction this bot signs or submits itself (§8.2).

---

## 3. Implementation Phases (what landed)

| Phase | Goal | Status |
|-------|------|--------|
| **1** | Types, orchestrator, workers, Prisma models, unit tests; no listener change | Done |
| **2** | Wire `index.ts` → dispatcher → orchestrator; non-blocking; Discord untouched | Done |
| **3** | Replace AI stub with Anthropic structured outputs + Zod; fail → PARTIAL | Done |
| **3.1** | Moralis 2026 removals cleanup; remove trench.bot; bundle worker = UNAVAILABLE | Done |
| **4** | Canonical chain/address identity and shared research/market observations | Done; not wired into runtime |
| **5** | Deterministic Solana forensics (5A–5E) | Done |
| **6** | Presentation layer: read-only HTTP API (`src/researchApi/`) | Done |
| **X** | Read-only X (Twitter) API capability checkpoint | Done — see below |
| **6+** | Chroma/RAG, notifications, a *safe* Telegram/chat surface | Not started |
| **(unnumbered)** | `main2` merge (PR #7): Telegraf trading bot, `PumpSwapService`, `JupiterService`, websocket/API server, PnL/top-calls reporting | Merged; **not gated, not part of the phaseN.txt spec sequence** — see §8 |
| **7A** | Non-custodial trading, authenticated `/api/*`, Telegram/Discord allowlists (removes the custodial paths `main2` introduced) | Done — see §8 |
| **7A.1** | Restore the historical `20250324020906_init` migration; real PostgreSQL migration validation in CI | Done — see §5.6, §11 |
| **7B.1** | Canonical `/api/v1` gateway: Supabase JWT auth, versioned routes, OpenAPI, CORS/rate-limit/logging hygiene | Done — see §16 |
| **7B.2** | Wallet-ownership verification, user-scoped scans/jobs, authenticated WebSockets, memory/Redis event bus and tickets | Done — see §17; live Supabase/Redis deployment proof remains open |
| **7B.3A1** | Pump.fun/PumpSwap lifecycle decoding, canonical event identity, normalized trades and additive schema | Done for decoding/schema slice — see §18; durable Solana ingestion and candle services remain open |
| **7B.4** | Robinhood/Pons discovery, trades, graduation polling, PostgreSQL checkpoints, reorg detection and canonical read API | Done and tested; recorded mainnet proof, testnet blocker and remaining limits — §19 |
| **7B.5A** | Pons ingestion hardening: discovery-before-trades barrier, bounded reorg rollback/replay, chunked pool scaling, batch enrichment, source health | Done — §20 |
| **7B.5B** | Chain-neutral candle/OHLCV service for Robinhood/Pons | Done — §21 |
| **7D** | Pons V2 discovery/graduation onto Uniswap V4, launch metadata, V4 trade history | Done — §23 and `PHASE_7D_ROBINHOOD_V2_AND_LAUNCHPAD.md` |
| **7F.2** | Verified callouts API, single-sourced PnL renderer, three startup fixes | Done — §22 |
| **7D.3** | Supervised local processes (`dev-stack.sh`), committed OpenAPI + drift check, fabricated-PnL removal, read-only V4 pool evidence | Done — §24 |
| **7D.3.1** | Credential-leak remediation, safe public error messages, multi-key RPC failover, WebSocket recovery, cross-provider block pinning, deadlines and metrics | Done — §24 |
| **7D.3.2** | Official V4Quoter verified on a pinned fork; block-pinned quotes, route simulation, market evidence, immutable evidence snapshots, paper positions, token-logo cache | Done, merged as PR #20 — §25 |
| **7D.3.3** | Browser acceptance with two confirmed Supabase test users; CORS fixes; disposable-DB guard | Done, merged as PR #21 and follow-up PR #22 — §26 |
| **7D.4** | Market terminal, live market snapshots, Almost bonded/Trending, guided Practice with paper money, light gamification, vanity address handoff | Done, merged as PR #23 (2026-09-19) — §27; infrastructure blockers remain in §27.6 |
| **7D.5** | Robinhood live-data readiness: RPC identity, failure classification, adaptive log windows, graduation-poller scope, deployed-secret proof | Done, draft PR — §28; V2 discovery enrichment cost remains (§28.4) |
| **7G.1** | Robinhood Chain deterministic investigation snapshots, checks and AI thesis | Not started — brief is `phase7g1.txt` in the frontend repository |

Phase briefs live in `phase2.txt`, `phase3.txt`, `phase3-1.txt`, `phase4.txt`, `phase5*.txt`, `phase6`, `phase7b1.txt`, `phase7b2.txt`, `phase7b4.txt`, `phase7b5a.txt` and `phase7b5b.txt` (repository root, historical prompts). The Phase 7C/7D/7G briefs (`phase7d3.txt` … `phase7d3.3.txt`) live in the frontend repository root (`only-pump-me`). The implemented Phase 7B.4 behavior and deviations are recorded in §19; the brief is not an exact runtime description. The `main2` merge had no corresponding phase brief — it is independent legacy work with its own history (commits from May 2025), reconciled into `master` (see git log around `10668e0`).

### Phase 4 details

Phase 4 implements a canonical, provider-neutral research foundation for cross-chain assets and market observations. It is intentionally not wired into active listeners, the TokenIntelligenceOrchestrator, Discord alerts, tracker writes, or any execution/trading paths.

Primary artifacts (created under `src/assets/`):

- `src/assets/types.ts` — canonical AssetIdentity types and research observation types
- `src/assets/chainRegistry.ts` — immutable supported-chain registry (`SOLANA`, `ETHEREUM`, `BNB_SMART_CHAIN`; extended with `ROBINHOOD`, chain ID `4663`, in Phase 7B.4)
- `src/assets/assetResolver.ts` — explicit AssetResolutionInput → AssetResolutionResult behavior (RESOLVED / AMBIGUOUS_CHAIN / INVALID_ADDRESS / UNSUPPORTED_CHAIN)
- `src/assets/marketObservation.ts` — provider-neutral MarketObservation contract and validation
- `src/assets/assetStore.ts` — controlled PostgreSQL store with idempotent upsert and observation persistence
- `src/assets/tokenDiscoveryAssetAdapter.ts` — pure adapter from legacy `TokenDiscoveryEvent` to AssetResolutionResult
- Tests: `src/assets/__tests__/` covering resolver, observations, store, and execution boundary checks
- `src/assets/README.md` — Phase 4 documentation and boundary rules

Database

- Additive Prisma models and migration were created to persist canonical assets and research observations in PostgreSQL (additive only; no destructive migration or legacy SQLite changes). The canonical `Asset` uses `@@unique([chainId, normalizedAddress])` and `AssetObservation` uses `@@unique([assetId, source, observationKey])` for idempotency.

Verification

Phase 4 verification instructions are captured in `phase4.txt` and include:

- `npx prisma@6.5.0 generate` and `npx prisma@6.5.0 validate`
- `npx tsc --noEmit`
- `npx vitest run src/assets` and `npm run test:intelligence`
- `git diff -- prisma/schema.prisma prisma/migrations` and `git diff -- src/assets`

Notes and boundaries

- EVM addresses are validated as `0x` + 40 hex chars and normalized to lowercase; no EIP-55 checksums generated in this phase.
- Solana addresses are validated with `PublicKey` and remain case-sensitive; canonical identity preserves Solana casing.
- A bare `0x` address without a chain hint returns `AMBIGUOUS_CHAIN` with candidates `ETHEREUM` and `BNB_SMART_CHAIN`; there is no silent default to Ethereum.
- `POSITION` observations are rejected by the Phase 4 store — research observations are distinct from portfolio holdings (SQLite remains legacy tracker).
- No live Ethereum/BNB RPC or provider is added in Phase 4; adapters and constructors are pure and perform no network or DB I/O.

For full Phase 4 requirements and the approved audit plan, see `phase4.txt` at the repository root and `src/assets/README.md`.

### Phase 5 details

Phase 5 implements a deterministic, read-only Solana forensic subsystem (Phase 5A–5E) that produces evidence-backed eligibility assessments and deterministic on-chain metrics. It focuses on forensics and intelligence integration while preserving the repository's read-only, fail-closed safety boundaries.

Primary Phase 5 artifacts (under `src/forensics/`, migrations, and related services):

- `src/forensics/` — deterministic math, analyzers, client interfaces, job/enqueue helpers, worker process, and tests. Key files include:
  - `solanaForensicsClient.ts` — typed, read-only forensic client interface (Phase 5B)
  - `launchTransactionAnalyzer.ts`, `walletFundingAnalyzer.ts`, `mintAuthorityAnalyzer.ts` — deterministic analyzers (Phase 5C)
  - `bundleForensicsService.ts`, `forensicsJobService.ts`, `forensicsWorker.ts`, `forensicsRunPersistence.ts` — durable worker and job persistence (Phase 5D)
  - `tokenEligibilityPolicy.ts`, `thresholds.ts` — deterministic eligibility policy and mandatory exclusion rules (Phase 5A)
  - `forensicsIntegrationConfig.ts` and `forensicsWorkerConfig.ts` — integration flags and worker tuning
  - `__tests__/` — comprehensive unit and integration tests that mock network and database boundaries; no live Helius calls during tests
- `src/services/forensicsIntelligenceLookupService.ts` — narrow injected service used by `bundleSniperResearcher` to read job/run state and enqueue at-most-one idempotent job (Phase 5E)
- `src/services/forensicsIntelligenceReconciliation.ts` — reconciles a completed/partial `SolanaForensicsRun` into its `TokenIntelligenceReport` by matching `job.eventId`; only ever runs inside the standalone worker
- `src/intelligence/workers/bundleSniperResearcher.ts` — now backed by Phase 5 via the injected lookup service; researcher receives safe statuses (PENDING, RUNNING, PARTIAL, COMPLETE, FAILED) rather than making heavy RPC calls

Database migrations (additive):

- `prisma/migrations/20260825013814_add_token_intelligence` — Token Intelligence tables (Phase 1)
- `prisma/migrations/20260825022923_add_ai_synthesis_meta` — AI provider telemetry columns (Phase 3)
- `prisma/migrations/20260825060000_add_canonical_assets` — `Asset`/`AssetObservation` (Phase 4)
- `prisma/migrations/20260826051447_add_solana_forensics` — creates SolanaForensicsJob, SolanaForensicsRun, SolanaForensicsEvidence, SolanaWalletCluster, SolanaWalletClusterMember, SolanaTokenEligibilityAssessment, and SolanaForensicsError tables plus indexes and foreign keys (Phase 5D)
- `prisma/migrations/20260826070752_add_forensics_intelligence_linkage` — adds linkage and summary columns to `TokenIntelligenceReport` and reconciliation columns on runs to support Phase 5E integration

- `prisma/migrations/20260827010000_wallet_pk_optional` — makes `Wallet.walletPk` nullable (Telegram/Discord/API custody removal, see §8)

**Resolved in Phase 7A.1 (was previously documented here as a gap):** `prisma/migrations/20250324020906_init/migration.sql` and `prisma/migrations/migration_lock.toml` — the original migration that creates the legacy `Wallet`/`UserConfig`/`PumpFunToken`/`TokenAlert`/`WalletTransaction`/`WalletBalance` tables — existed on `origin/main` but had been missing from `master`'s migration chain since before the `main2` merge (most likely the same class of case-insensitive-filesystem checkout bug documented in §8.5). Restored byte-for-byte from `origin/main` (`git show origin/main:<path>`, verified against the source blob via both `git diff --no-index` and matching `git hash-object`/SHA-256 — see `src/__tests__/migrationChain.test.ts`, which pins those hashes so the historical file can never be silently edited going forward). `prisma migrate deploy` now applies all 7 migrations, in order, against a genuinely fresh PostgreSQL 16 database — both the clean-install path (fresh DB, all 7 migrations) and the upgrade path (a disposable DB seeded through migration 6, with a live `Wallet` row present, then migration 7 applied on top) were verified against real, disposable, throwaway Postgres containers during Phase 7A.1, never against any shared or persistent database. CI now runs the same clean-install validation on every push/PR against its own disposable `postgres:16` service container (§11).

**Subsequently resolved in Phase 7B.1:** the missing `UserPreference` migration identified during Phase 7A.1 was added as `20260828071721_add_user_preference`. Freshly migrated databases now include the table; the preference only controls Telegram notifications (§16.2). The current chain has 12 migrations, including wallet ownership, Pump lifecycle/trades, and Pons ingestion (§11, §18–§19).

Behavior and boundaries

- Mandatory deterministic policy enforced: tokens meeting the configured bundled/holding thresholds are marked EXCLUDED and must never become recommendation candidates. The repository encodes the non-negotiable rule (e.g., initialBundledAcquisitionPct >= 40 OR currentBundleWalletHoldingsPct >= 40 => EXCLUDED).
- Phase 5 itself is read-only research: no swaps, buys/sells, signing, or execution logic were added by Phase 5. The heavy analyzer (SolanaForensicsClient implementation) runs inside the dedicated `forensics:worker` process; researchers and orchestrator never call it directly. (This guarantee is about the *forensics subsystem specifically* — it does not describe the repository as a whole; see §8.)
- The intelligence integration is narrow: `bundleSniperResearcher` uses `forensicsIntelligenceLookupService` which performs fast Prisma reads and, when enabled, an idempotent enqueue of a forensics job. It never runs the analyzer inline or performs network I/O from researcher code paths.
- Job idempotency and run deduplication use stable job keys computed from mint, signature, event id, analysis level, and policy version.
- Observability and idempotency: runs and evidence are persisted with stable keys (evidenceKey, clusterKey, jobKey) and indexes to avoid duplicate work; jobs expose status (PENDING, RUNNING, COMPLETE, PARTIAL, FAILED) to callers.

Tests and verification

- Phase 5 includes unit and integration tests under `src/forensics/__tests__` that mock the Solana client (`src/forensics/fixtures/fakeClient.ts`) and assert deterministic outputs for analyzers and policy enforcement. No live Helius or production RPC calls are required for tests.
- Verification steps: run `npx prisma@6.5.0 validate`, `npx prisma@6.5.0 generate`, `npx tsc --noEmit`, `npx vitest run src/forensics`, and the intelligence test suite. Inspect `git diff -- prisma/schema.prisma prisma/migrations` and `git diff -- src/forensics` to confirm only Phase 5 additive changes were introduced.

Phase 5 status

- Implemented: 5A (data contracts & policy), 5B (typed read-only client), 5C (deterministic analyzers), 5D (durable job/run persistence and worker), 5E (intelligence integration via narrow lookup/enqueue service).
- The forensic worker process and database migrations are additive. The orchestrator and researchers now consume Phase 5 read-only results via the injected service; active listeners and execution paths remain unchanged.

For full Phase 5 requirements and the approved audit plan, see `phase5.txt`, `phase5b.txt`, `phase5c.txt`, `phase5d.txt`, and `phase5e.txt` at the repository root and `src/forensics/README.md`.

### Phase 6 details

Phase 6 exposes the intelligence and forensics that Phase 1–5 already persist to humans, through one deterministic contract consumed by an HTTP API. It adds no new data sources, no new analyzers, and no execution paths — it is a read-only projection of existing Prisma state. (A Telegram bot for this same purpose was prototyped and then explicitly reverted at the user's request before the `main2` merge — see git history around commits removing `src/telegram/renderTelegram.ts`. The *unrelated* Telegram bot described in §8 came from `main2`, a completely separate, pre-existing, non-Phase-6 codebase with real trading commands — do not confuse the two.)

Primary artifacts:

- `src/presentation/` — pure projection layer. No network, no Prisma, no env reads.
  - `riskView.ts` — `RiskView`/`Signal` types and `buildRiskView()`; derives a verdict (`EXCLUDED` / `HIGH_RISK` / `ELEVATED` / `UNVERIFIED` — there is deliberately no `CLEAR` verdict) from already-loaded plain rows. `WASH_TRADE` and `DEV_HISTORY` signals are always `UNVERIFIED`: no analyzer for either exists yet, and absence is never rendered as safety.
  - `renderDiscord.ts` — builds (never sends) a `discord.js` `EmbedBuilder`.
  - `toApiJson.ts` — versioned, stable-field-name JSON projection.
  - Both renderers re-screen output against the Phase 3 prohibited-language reject list (`anthropicSynthesisProvider.ts`'s exported `PROHIBITED_PATTERNS`), not just raw model output.
  - `__tests__/executionBoundary.test.ts` — walks `src/presentation/` and `src/researchApi/` source for denylisted imports (execution, wallet, tracker, live Discord login). **This test only covers those two directories** — it says nothing about `src/telegram/`, `src/api/`, or `src/services/{pumpswapService,jupiterService}.ts`, all of which are real execution paths from `main2` (§8). Those trading/chat surfaces have their own, differently-shaped regression coverage instead — not "unreachable," but "reachable and proven non-custodial": `src/services/__tests__/nonCustodialTradingBoundary.test.ts` (no private-key generation/import/logging anywhere in `src/telegram/`, `src/discord/`, `src/api/`, or the trading services; no write to `Wallet.walletPk`; no `sniperooService` references; no `sendTransaction`/`signTransaction`) and `src/services/__tests__/tradingAllowlistWiring.test.ts` (the allowlist guards are actually called from every trading entrypoint, not just defined).
- `src/services/riskViewLoader.ts` — the one place Prisma rows are loaded and mapped into `RiskViewInput`; also falls back to a standalone `SolanaForensicsRun` for a mint with no `TokenIntelligenceReport` (e.g. a token only ever manually scanned via `POST /scans`, never seen by the live listener) rather than reporting it as never-analysed.
- `src/researchApi/` — Express, its own `API_PORT` (not the listener's `METRICS_PORT`, and not the same process as `main2`'s `src/api/index.ts` or `src/api/standalone.ts` — see §8.3 for how three different things all end up named "api"). Evolved into the canonical `/api/v1` gateway in Phase 7B.1 — full route map, Supabase auth, CORS, rate-limit-backend, request-id/logging, and error-contract detail lives in **§16**, not repeated here. `createApiServer()` only ever listens behind `require.main === module`. Named `researchApi` rather than `api` because `main2`'s own unrelated `src/api/` collided with it once merged — merging the two into one directory would have mixed execution-path code into this read-only layer's own execution-boundary scan.

Database: no migration — Phase 6 only reads existing Phase 1–5 tables.

Verification: `npx tsc --noEmit`, `npx vitest run src/presentation src/researchApi`, `npm run test:intelligence`, `npx prisma@6.5.0 validate`, plus grepping the compiled `dist/` output for denylisted imports (zero real hits — matches found are only inside comments/regex-literal source, not actual imports). `src/index.ts`, `src/server.ts`, `src/pumpfun-sniper.ts`, and `src/discord/**` were untouched by Phase 6 itself (they were subsequently changed by the unrelated `main2` merge — see §8).

For full Phase 6 requirements, see `phase6` at the repository root.

### Phase X details

A minimal, read-only capability checkpoint for the X (Twitter) API, gated entirely behind an explicit smoke-test script rather than any live listener path.

- `src/x/xApiClient.ts` — typed client for read-only X API v2 endpoints.
- `src/x/config.ts` — validated config (`X_BEARER_TOKEN`, `X_API_BASE_URL`, `X_STREAM_ENABLED`, `X_REQUEST_TIMEOUT_MS`); streaming stays disabled by default.
- `src/x/smoke.ts`, run via `npm run x:smoke` — the *only* place `X_BEARER_TOKEN` is ever read outside of config loading/tests.
- `src/x/__tests__/executionBoundary.test.ts` — same denylist-scan pattern as the other execution-boundary tests, scoped to `src/x/`.

No streaming ingestion, no write access, no wiring into the intelligence orchestrator yet.

---

## 4. Legacy Listeners (still active)

### 4.1 Pump.fun new mints — `npm run pumpfun`

| Item | Detail |
|------|--------|
| File | `src/pumpfun-sniper.ts` |
| Program | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` |
| Signal | `Program log: Instruction: InitializeMint2` |
| Discord | `sendPumpFunAlert` → `PUMPFUN_DISCORD_CHANNEL_ID` |
| Intelligence | **Not wired** |

### 4.2 Pool / "pumpswap"-labeled CreatePool — `npm run dev`

| Item | Detail |
|------|--------|
| File | `src/index.ts` |
| Config | `config.liquidity_pool[0]`: name `"pumpswap"`, **program = Pump.fun bonding program**, instruction `CreatePool` |
| Real PumpSwap AMM | `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`, defined in both `src/services/pumpSwapDetection.ts` (pure, intelligence-only) and `src/services/pumpswapService.ts` (the real trading class) — **not subscribed as the CreatePool watch target yet** |
| Discord | `sendTokenAlert` → `DISCORD_CHANNEL_ID` (still filters `mint.endsWith("pump")`, MC ≥ $15k) |
| Intelligence | `dispatchTokenIntelligence(signature, mint, matchedPool.program, rawWsValue)` after mint extract |
| Trading (legacy path) | `config.rug_check.simulation_mode: true` → no Jupiter buy via `transactions.ts` |
| Trading (main2 paths) | **Unaffected by `simulation_mode`** — see §8. The Telegram bot and `src/api/index.ts` are separate processes/paths that this flag does not gate. |
| Also runs now | The Telegram bot auto-init IIFE always starts as part of this same `npm run dev` process; `src/api/index.ts` additionally starts only when `API_ENABLED=true` (default off), and every `/api/*` route it exposes is bearer-authenticated when it does — see §2 and §8.3. |

### 4.3 Other processes

| Script | Entry | Notes |
|--------|-------|-------|
| `npm run pumpfun15k` | Wrong path in `package.json` (`src/discord-pumpfun-15k.ts`); real file is `src/discord/discord-pumpfun-15k.ts` | Broken script |
| `npm run tracker` | SQLite holdings TP/SL | Legacy |
| `npm run server` | Older Express + WS | Overlaps `index.ts` |
| `npm run api:server` / `dev:api` | `src/api-server.ts` → `src/api/standalone.ts` | Read-only, no wallet/trade routes — safe of the three "api" surfaces (§8.3) |
| `npm run daily` / `topcalls` / `simulation` / `pnl` | `src/test-daily-summary.ts`, `src/topCalls.ts`, `src/simulation.ts`, `src/pnl-check.ts` | Reporting/backtest utilities from `main2`, not covered by the automated test suite |

---

## 5. Token Intelligence Layer (detail)

### 5.1 Canonical event — `TokenDiscoveryEvent`

Defined in `src/intelligence/types.ts`:

- `id`, `signature`, `mint`, optional `poolAddress`
- `source`: `PUMPFUN` \| `PUMPSWAP` \| `MIGRATION` \| `UNKNOWN`
- `discoveredAt` / `receivedAt`
- `rawPayload` (WebSocket value preserved)

**Source derivation** (`deriveTokenSource` in `tokenIntelligenceDispatch.ts`):

| Program ID | Source |
|------------|--------|
| `pAMMBay…` (PumpSwap AMM) | `PUMPSWAP` |
| `39azUYFW…` (Pump.fun→Raydium migration account) | `MIGRATION` |
| Anything else (including current enabled pump1 config) | `UNKNOWN` |

Sources are never guessed from the config **name** `"pumpswap"`. The constants live in `src/services/pumpSwapDetection.ts` (renamed from `pumpSwapService.ts` during the `main2` merge to avoid a case-only filename collision with the unrelated trading module of the same near-name — see §8.4).

### 5.2 Dispatcher — `src/services/tokenIntelligenceDispatch.ts`

- Fire-and-forget: listener must not `await` research
- Dedup key: `signature:mint` (LRU-ish cap 1000)
- Concurrency: default 3; overflow → skip with log
- Timeout: default 20s frees the concurrency slot; work may continue in background
- Synchronous throws and promise rejections are swallowed/logged (listener stays up)

### 5.3 Orchestrator — `TokenIntelligenceOrchestrator`

File: `src/intelligence/orchestrator.ts`
Public API: `processTokenDiscoveryEvent(event)`.

Order:

1. **Parallel:** metadata, market, safety, bundleSniper
2. **After metadata:** social
3. **Then:** AI synthesis on the partial report
4. **Persist:** `saveReport` (best-effort; persistence failure does not throw away the in-memory report)

**Status rules:**

| Status | Meaning |
|--------|---------|
| `COMPLETE` | Research workers succeeded without errors; AI also OK if configured |
| `PARTIAL` | Some evidence exists but worker errors/fatals and/or AI failure |
| `FAILED` | No usable deterministic research |

AI failure can only **downgrade** `COMPLETE` → `PARTIAL`. AI success cannot rescue a `FAILED` research baseline.

`recommendation` is always `RESEARCH_ONLY`.

### 5.4 Workers

| Worker | File | Sources / behavior |
|--------|------|--------------------|
| Metadata | `workers/metadataResearcher.ts` | Moralis via `tokenDataService`; Pump.fun frontend via `pumpFunSocialClient`; optional on-chain migration check when source is PUMPSWAP/MIGRATION (via `pumpSwapDetection.ts`) |
| Market | `workers/marketResearcher.ts` | Moralis price/metadata/swaps (+ Birdeye volume/liquidity fallbacks in token data path) |
| Safety | `workers/safetyResearcher.ts` | **Read-only** `safetyCheckService` (RugCheck + SolSniffer). Never imports `transactions.ts` |
| Social | `workers/socialResearcher.ts` | Links already present on metadata / pump.fun frontend payload |
| Bundle/sniper | `workers/bundleSniperResearcher.ts` | Backed by Phase 5 forensics via `forensicsIntelligenceLookupService` (fast Prisma reads + idempotent enqueue); never calls the heavy analyzer inline |
| AI synthesis | `workers/aiSynthesisAgent.ts` | Calls `anthropicSynthesisProvider`; maps failures to safe UNKNOWN assessment |

### 5.5 Anthropic provider (Phase 3)

File: `src/intelligence/providers/anthropicSynthesisProvider.ts`

- Official `@anthropic-ai/sdk`, Messages API, **zero tools**
- Env: `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (default `claude-haiku-4-5-20251001`), `ANTHROPIC_TIMEOUT_MS`, `ANTHROPIC_MAX_TOKENS`
- Strict structured output + local Zod validation
- Prompt-injection treated as untrusted data
- Local reject of prohibited trading language (`PROHIBITED_PATTERNS`, exported for reuse by `src/presentation/`'s renderers)
- Retries only for 429 / retryable 5xx
- Telemetry persisted on report: provider, model, prompt/schema versions, latency, tokens, validation status, failure reason
- Unconfigured key → `NOT_CONFIGURED`; deterministic report still usable

### 5.6 Persistence (Prisma)

Migrations: see the list in §3's Phase 5 section (the original `20250324020906_init` legacy-tables migration was restored in Phase 7A.1 — see the note there).

Models (Phase 1–5, intelligence/forensics only — the legacy `Wallet`/`TokenAlert`/`WalletTransaction`/`WalletBalance`/`UserPreference` models used by the Telegram bot are separate, see §8):

- `TokenIntelligenceReport` — upsert by unique `eventId`
- `TokenIntelligenceEvidence` — category + JSON payload
- `TokenIntelligenceError` — per-worker messages + fatal flag
- `Asset` / `AssetObservation` — Phase 4 canonical identity/market data
- `SolanaForensicsJob` / `SolanaForensicsRun` / `SolanaForensicsEvidence` / `SolanaWalletCluster(Member)` / `SolanaTokenEligibilityAssessment` / `SolanaForensicsError` — Phase 5

Shared client: `src/services/prismaClient.ts`.

---

## 6. Moralis (Phase 3.1)

Shared client: `src/services/moralisClient.ts`
Host: `https://solana-gateway.moralis.io`
Header: `X-Api-Key` (never logged).

### Retained

| Endpoint | Helper |
|----------|--------|
| `GET /token/mainnet/{address}/metadata` | `getMoralisMetadata` |
| `GET /token/mainnet/{address}/price` | `getMoralisPrice` |
| `GET /token/mainnet/{address}/swaps` | `getMoralisSwaps` |
| `GET /token/mainnet/{address}/pairs` | `getMoralisPairs` |
| `GET /token/mainnet/pairs/{pairAddress}/stats` | `getMoralisPairStats` |

Behavior: timeout, max body size, Zod parse, typed `AVAILABLE` / `UNAVAILABLE` with codes (`TOKEN_NOT_FOUND`, `AUTHENTICATION_FAILED`, `RATE_LIMITED`, …). Retry **only** 429 and retryable 5xx.

### Removed (must not be called)

- Holders / top-holders / historical holders
- Pair snipers (`…/pairs/{pair}/snipers`) — `fetchSniperData` now returns `null`
- Legacy discovery / volume
- Exchange new / bonding / graduated
- Bonding-status
- Solana Token Score / metadata `score`

`removedMoralisEndpoint(feature)` returns typed `ENDPOINT_REMOVED`. Missing data ≠ zeros ≠ "safe".

`tokenDataService.ts` is rebuilt on the shared client for intelligence/Discord market enrichment. `src/services/tokenTrackingService.ts`'s `getSolPrice()` also uses `getMoralisPrice` (fixed during the `main2` merge — it had a broken CoinGecko/Moralis hybrid left over from a bad merge resolution).

---

## 7. trench.bot removal (Phase 3.1)

| Item | Status |
|------|--------|
| `src/services/trenchClient.ts` | **Deleted** |
| Intelligence bundle worker | No HTTP; backed by Phase 5 forensics instead |
| Discord / PnL paths | Must not call trench (cleaned in 3.1 commit; `discord.ts`'s `sendTokenAlert` still has a `fetchTrenchData`-shaped fallback path fed by prefetched data from `index.ts`, but the non-prefetched fallback uses `fetchPendingBundleData` — a stub — not a live trench.bot call) |
| Future forensics | Now built (Phase 5) for the intelligence path; the Telegram/API trading surface (§8) does not consult it at all |

---

## 8. Safety / execution boundary — READ THIS SECTION

This section changed materially with the `main2` merge (PR #7, commit `10668e0`), and again immediately afterward when the plaintext-key custody it introduced was removed. The previous version of this document said trading was "simulation-gated and unreachable from intelligence" as a description of the whole repository — that stopped being true the moment `main2` merged. **It is true again now**, but for a different reason than before: not because the new trading surface is gated, but because it no longer holds a key to sign with at all. Read on before assuming either extreme.

### 8.1 What's still true: the intelligence/forensics/presentation path is genuinely execution-proof

- `src/intelligence/**`, `src/forensics/**`, `src/presentation/**`, `src/researchApi/**`, `src/x/**`, `src/assets/**` cannot reach `transactions.ts`, `tradingService.ts`, Jito bundle helpers, tracker writers, or any `client.login`-at-import Discord module. This is enforced by automated tests, not just convention: `src/presentation/__tests__/executionBoundary.test.ts`, `src/assets/__tests__/executionBoundary.test.ts`, `src/forensics/__tests__/executionBoundary.test.ts`, `src/x/__tests__/executionBoundary.test.ts`.
- `safetyCheckService.ts` is a read-only clone of the rug/sniffer fetches used elsewhere for trading gates; it never triggers a trade.
- The forensics worker and the Phase 6 API never sign or submit anything; `POST /api/v1/tokens/:mint/scan` only enqueues a deterministic analysis job.

### 8.2 The `main2` trading surface is now non-custodial — it never holds a private key

`main2` originally shipped three custodial trading backends (`jupiterService.ts`, `pumpswapService.ts`, and a third-party SaaS client `sniperooService.ts`), each of which generated, imported, or received a private key and stored it — two of them in plaintext in Postgres (`Wallet.walletPk`), one via a third party (`api.sniperoo.app`) whose returned key was *also* stored in the same plaintext column. All of that was removed in the same session it was discovered, replaced with a **Solana Pay Transaction Request** flow (`src/services/solanaPayService.ts`, implementing https://docs.solanapay.com/spec#transaction-request):

- `sniperooService.ts` is deleted. `config.sniperoo` is gone from `config.ts`.
- `jupiterService.ts` no longer has `createWallet`, `importWallet`, or `getWalletPrivateKey`. It exposes `connectWallet(userId, publicAddress)` (stores a PUBLIC address only, validated as a real `PublicKey`) and `buildBuySwapTransaction`/`buildSellSwapTransaction`, which build an **unsigned** transaction for a caller-supplied public key via Jupiter's quote/swap API and return it as base64 — they never sign or send anything.
- `pumpswapService.ts`'s `buyToken`/`sellToken` are removed outright, not just de-custodied: their underlying `getPumpFunBuyInstructions`/`getPumpFunSellInstructions` were always empty-array placeholders (never actually implemented), so the only thing that custodial path ever did was spend a real Jito tip for zero effect. Real PumpSwap AMM swaps are still not implemented anywhere in this codebase — Jupiter (which can route through a PumpSwap pool once one exists on-chain) is the only working swap path now.
- `Wallet.walletPk` is now nullable (`prisma/migrations/20260827010000_wallet_pk_optional`) and is never written by any code path going forward. Existing rows aren't touched — if this bot's DB already has real plaintext private keys in it from before this fix, **treat every one of those wallets as compromised and have the affected users move funds to a new wallet**; this fix does not retroactively secure keys already written.

**How a trade actually happens now:** a user runs `/buy <mint> [sol_amount]` or `/sell <mint> <percentage>` (Telegram: `src/telegram/commands/{buy,sell}.ts`; Discord: `src/discord/commands/{buy,sell}.ts` and the DM handler in `src/discord/discord.ts`; HTTP: `POST /api/transaction/{buy,sell}` in `src/api/index.ts`). Each of these calls `solanaPayService.create{Buy,Sell}Intent`, which returns a `solana:<https-url>` link and a QR code (`src/services/qrCode.ts`) pointing at `GET/POST /pay/{buy,sell}/:intentId` (also in `src/api/index.ts`). The user opens that link in their own wallet app (Phantom, Solflare, …); the wallet — not this bot — POSTs its own public key to that endpoint, `buildTransactionForAccount` builds the unsigned swap transaction for that specific account, and the wallet shows it to the user for approval. Nothing is signed or sent unless the user approves it in their own wallet. This bot never sees a private key at any point in this flow.

**Requires `SOLANA_PAY_BASE_URL`** (a real, publicly reachable HTTPS URL for wherever `src/api/index.ts`'s `/pay/*` routes are served) — `create{Buy,Sell}Intent` throws `SolanaPayConfigError` rather than building a broken `solana:` link if it's unset. In this dev container there is no such public URL, so the flow is verified by unit test (`src/services/__tests__/solanaPayService.test.ts`) rather than live end-to-end; do that manually once a real deployment target exists.

**Intent hardening (phase7.txt §3/§5):** an intent expires 10 minutes after creation (`INTENT_TTL_MS`), is capped at 500 concurrently-live intents as a defense-in-depth backstop against a bug or a leaked `API_AUTH_TOKEN` (creation already requires that token), and is **one-time-use** — `buildTransactionForAccount` deletes the intent the moment it successfully builds a transaction, so the same `/pay/*` link cannot be replayed to mint a second transaction; a *failed* build (bad account, no on-chain balance, an upstream Jupiter error) leaves the intent live so a genuine retry still works. The intent's own `kind`/`tokenAddress`/`amount` are fixed at creation time and never take input from the `/pay/*` POST body — the wallet-supplied `account` field only selects whose balance/quote to build for, it cannot smuggle in a different mint, amount, or side. The public (unauthenticated, per spec) `GET`/`POST /pay/*` routes are also rate-limited per IP (`src/api/rateLimit.ts`, 30 req/min) so a caller can't hammer Jupiter's quote/swap API for free. All of this is covered by `src/services/__tests__/solanaPayService.test.ts`.

**What this does *not* fix, by design:**
- **Auto-buy** (`UserConfig.autoBuy`, `getUsersWithAutoBuy()`) is inherently incompatible with non-custodial signing — there is no key here to sign an unattended trade with. It was already dead code (`handleWebsocketMessage` in `index.ts` is defined but never called); it now only logs candidates instead of calling a since-removed custodial `buyToken`.
- No RugCheck gate, spend cap, or confirmation step was added *in this bot* — that job now belongs to the user's own wallet app, which is exactly the point of a non-custodial flow (they review the real transaction before signing).
- Discord's `wallet:export`/`withdraw` style menu buttons still exist for UX continuity but now just explain that there's nothing to export or withdraw — the bot never held either.

### 8.3 The `/api/index.ts` server: now off by default and authenticated

Both fixed in the same session as §8.2:

- `src/index.ts`'s `main()` no longer calls `initApiServer()` unconditionally — it's now gated behind `API_ENABLED === 'true'` (default `false`; the dead code that used to check this is now live). Start it explicitly with `API_ENABLED=true npm run dev` (matching the pre-existing but previously-nonfunctional `dev:all` script), or run it standalone.
- Every route under `/api/*` in `src/api/index.ts` now requires `Authorization: Bearer <API_AUTH_TOKEN>`, checked by middleware mounted at `app.use('/api', ...)`. **Fails closed**: with `API_AUTH_TOKEN` unset, every `/api/*` request gets `503`, not silent pass-through. `/health`, `/`, and the Solana Pay `/pay/*` routes are exempt by design — the latter must stay unauthenticated per the Solana Pay Transaction Request spec (a wallet app calls them directly; building a transaction for a caller-declared account cannot move that account's funds without its own signature).
- This closed a real, separate finding made while implementing this: `PUT /api/config` could flip `config.rug_check.simulation_mode` at runtime over that same unauthenticated HTTP surface — i.e. before this fix, anyone who could reach the port could remotely disable the one safety gate the legacy `transactions.ts` path actually has. That route is now behind the same bearer-auth middleware.
- `src/apiServerGate.ts` — the `API_ENABLED === 'true'` check itself is pulled into its own zero-dependency module (`isApiServerEnabled()`) purely so it's unit-testable (`src/__tests__/apiServerGate.test.ts`) without importing `src/index.ts`, which has import-time side effects (constructing the live Telegram bot — §2) unsafe to trigger in a test.
- `src/api/__tests__/index.test.ts` covers the auth gate (missing/malformed/wrong/correct bearer token, unset-token 503), that `/api/wallet/create` and `/api/wallet/import` now 404, that the public route surface is exactly `/health`, `/`, and `/pay/*` (every other `/api/*` route rejects an unauthenticated request), and that `POST /api/transaction/buy` returns a `solana:` link containing no key material. It mocks `../discord/discord` and `../telegram/telegramBot` so importing the router never makes a real Discord/Telegram network call.

### 8.4 Three things are all called "api" — keep them straight

| Name | File(s) | Port/host default | Auth | Trade/wallet routes | Started by |
|------|---------|--------------------|------|----------------------|------------|
| Canonical `/api/v1` gateway (Phase 6, evolved in 7B.1 — §16) | `src/researchApi/server.ts` | `API_PORT` (own var, default 8787) | Supabase JWT **or** internal `API_KEYS`; `/me` is Supabase-only; full detail in §16.4 | None — read-only + one idempotent job enqueue | `npm run api` only, behind `require.main === module` |
| `main2` standalone API | `src/api-server.ts` → `src/api/standalone.ts` | `API_PORT`/`API_HOST` (default `0.0.0.0:3001`) | None | None — `/health`, `/`, `/api/status`, `/api/utils/sol-price` only | `npm run api:server` / `npm run dev:api` |
| `main2` full API | `src/api/index.ts` | `API_HOST`/`API_PORT` (default `0.0.0.0:3001`), or `API_PORT_MAIN` (3030) when run alongside the main app | Bearer `API_AUTH_TOKEN` on every `/api/*` route (fails closed); `/health`, `/`, `/pay/*` exempt | `POST /api/wallet/connect` (public address only, non-custodial), `GET /api/wallet/:userId`, `POST /api/transaction/{buy,sell}` (return a Solana Pay link — do not execute), `GET/POST /pay/{buy,sell}/:intentId` (build-only, unauthenticated by design) | Only when `API_ENABLED=true` (§8.3) |

`API_PORT` still collides in name (not in process — they're never running from the same `require`, but they are trivially confusable) between the Phase 6 research API and `main2`'s server. Check `API_HOST`/`API_PORT` in whatever `.env` a given process actually loads before assuming which server you're looking at.

### 8.5 Case-insensitive-filesystem collisions caused real bugs during the merge

Two separate near-duplicate filenames differing only by capitalization already caused problems once (`pumpSwapService.ts` vs `pumpswapService.ts` — one went missing entirely from `main2`'s history, almost certainly because someone checked it out on a case-insensitive filesystem, most likely macOS or Windows). If you are on such a filesystem, be deliberate about any future file named similarly to an existing one differing only by case — `git status` will not warn you, and a silent overwrite on checkout is exactly what happened here. The forensics-side collision was fixed by renaming to `pumpSwapDetection.ts`; the `src/api/` vs (Phase 6) `src/api/` directory-name collision was fixed by renaming the Phase 6 side to `src/researchApi/`.

### 8.6 Trading commands are now allowlisted

`/buy`, `/sell`, and `/wallet connect`/`disconnect` on both Telegram (`src/telegram/adminGuard.ts`) and Discord (`src/discord/adminGuard.ts`, covering both the slash commands and the DM-based text-command handler in `discord.ts`) now check a comma-separated allowlist — `TELEGRAM_ADMIN_IDS` / `DISCORD_ADMIN_IDS`. **Fails closed**: unset or empty means nobody is allowed, not everybody. The Telegram check is applied both at the command entrypoint and inside `connect_wallet_scene`'s `enter` handler, since the wallet-menu buttons reach that scene directly without going through the `/wallet` command function. `/config`, `/service`, `/pumpsettings`, and the read-only wallet-menu/balance views are **not** gated — only the two truly trading-adjacent commands.

### 8.7 What's still open

1. **Implement real PumpSwap AMM instruction building**, or remove the vestigial `SwapService.PUMPFUN` preference option (`telegram/commands/service.ts`) that no longer changes anything at execution time now that both `/buy` and `/sell` always go through Jupiter.
2. Verify the Solana Pay flow live end-to-end once a real `SOLANA_PAY_BASE_URL`/deployment exists (§8.2) — still only unit-tested in this dev environment.
3. Rotate any wallet whose private key was imported through the old custodial flow, before §8.2's fix.
4. ~~Regenerate the missing `20250324020906_init` migration~~ — restored byte-for-byte in Phase 7A.1 (§3's Phase 5 note); `prisma migrate deploy` is now validated clean-install and upgrade against real disposable PostgreSQL, both locally and in CI (§11).
5. ~~Add the missing `UserPreference` migration~~ — completed in Phase 7B.1 (`20260828071721_add_user_preference`, §16.2).

---

## 9. Source map (current)

```text
src/
├── index.ts                          # Pool CreatePool listener + Discord + intel dispatch
│                                      # + Telegram bot auto-init + opt-in, bearer-authed API start (§8.3)
├── apiServerGate.ts                   # isApiServerEnabled() — pulled out of index.ts so the
│                                      # API_ENABLED fail-closed default is unit-testable (§8.3)
├── pumpfun-sniper.ts                  # New mint Discord only
├── config.ts                         # Pools, fees, simulation (no sniperoo block anymore — removed)
├── transactions.ts                   # Legacy tx / swap / rug gate (danger for intel); the one
│                                      # trading path actually gated by simulation_mode
├── server.ts                         # Older Express + WS, overlaps index.ts
├── api-server.ts                     # Entry for the read-only standalone API (main2)
├── check-api.ts / test-api.ts / test-websocket.ts   # Manual smoke scripts (main2), not in vitest
├── simulation.ts / topCalls.ts / pnl-check.ts        # Reporting/backtest scripts (main2)
├── intelligence/
│   ├── types.ts
│   ├── orchestrator.ts
│   ├── reportStore.ts
│   ├── providers/anthropicSynthesisProvider.ts
│   ├── workers/{metadata,market,safety,social,bundleSniper,aiSynthesis}Researcher*.ts
│   └── __tests__/                    # Vitest (mocked network)
├── forensics/                        # Phase 5A-5E deterministic analyzers, worker, policy (see §3)
├── pump/                             # Phase 7B.3A1: pure lifecycle/event decoding, event identity,
│                                      # normalized trades, real-chain fixtures, live capture script (§18)
├── discovery/                        # Phase 7B.4: ChainAdapter + normalized types + decimal math (§19.2)
├── pons/                             # Phase 7B.4: config, verified ABI, viem ChainReader, adapter,
│                                      # discovery/trade loops, checkpoints, graduation poller;
│                                      # scripts/ponsWorkerMain.ts and liveVerification.ts (§19)
│   ├── abiV2.ts / ponsV2Adapter.ts / discoveryV2Listener.ts / tradeV2Listener.ts   # Phase 7D (§23)
│   ├── v4PoolState.ts / v4PoolEvidenceService.ts   # Phase 7D.3 read-only V4 pool evidence (§24)
│   ├── rpcEndpoints.ts / failoverChainClient.ts     # Phase 7D.3.1 multi-key failover (§24)
│   ├── wsSubscriptionManager.ts / blockPinnedReader.ts   # Phase 7D.3.1 WS recovery, block pinning
│   └── quote/                        # Phase 7D.3.2 (§25): protocol.ts (addresses/ABIs/sources),
│                                      # curveQuote.ts, v4Quote.ts, pinnedReads.ts, quoteService.ts,
│                                      # simulationService.ts, marketEvidenceService.ts,
│                                      # generated/routeSimulator.json (from evm-verification/)
├── candles/                          # Phase 7B.5B candle domain + candlesWorkerMain.ts (§21)
├── media/                            # Phase 7D.3.2 token-logo cache: imageSafety.ts (byte sniffing),
│                                      # safeImageFetch.ts (SSRF-guarded), tokenImageCache.ts (worker)
├── testSupport/disposableDatabaseGuard.ts   # Phase 7D.3.3 vitest globalSetup (§26.3)
├── assets/                           # Phase 4 canonical identity (see §3)
├── presentation/                     # Phase 6 pure projection layer (see §3)
├── researchApi/                      # Canonical /api/v1 gateway (Phase 6, evolved 7B.1/7B.2 — see §3, §8.4, §16, §17)
│   ├── server.ts                     # createApiServer(db, config) — requestId, CORS, routes, error handler
│   ├── config.ts                     # Fail-closed env config: API_KEYS, Supabase, CORS, rate-limit/realtime backend
│   ├── middleware/{authenticate,supabaseAuth,requestId,cors,rateLimit,validateMint,validateRobinhoodAddress}.ts
│   ├── routes/{health,docs,me,tokens,jobs,wallets,realtimeTickets,robinhoodTokens,callouts,paperTrading,media}.ts
│   ├── contracts/{zodOpenApi,common,errors,openapi,wallets,robinhoodTokens,candles,callouts,poolEvidence,paperTrading}.ts   # One Zod source for validation + OpenAPI (§16.5)
│   ├── quoteEngineProvider.ts        # Phase 7D.3.2: lazy chain config + 8s market-evidence cache
│   ├── realtime/{eventEnvelope,eventBus,eventPublisher,ticketStore,websocketServer}.ts   # Phase 7B.2 (§17)
│   ├── lib/logger.ts                 # pino + redaction (§16.8)
│   ├── scripts/generateOpenApiDocument.ts   # npm run openapi:generate
│   └── __tests__/                    # supabaseAuth, cors, config, rateLimit, logger, openapi, routes,
│                                      # wallets, eventBus, ticketStore, eventEnvelope, websocketServer.test.ts
├── x/                                 # Phase X read-only X API checkpoint (see §3)
├── api/
│   ├── index.ts                      # Off by default, bearer-authed on every /api/* route (§8.3-8.4).
│   │                                  # Trading routes are non-custodial (§8.2) — they return Solana Pay
│   │                                  # links, never execute. /pay/* is public-by-spec but rate-limited.
│   ├── rateLimit.ts                  # Per-IP fixed-window limiter for the public /pay/* routes (§8.2)
│   ├── __tests__/index.test.ts       # Auth/retirement/route-allowlist regression tests (§8.3)
│   └── standalone.ts                 # Read-only status/websocket API, safe
├── telegram/                          # Telegraf trading bot — non-custodial (§8.2)
│   ├── telegramBot.ts                # Bot construction + .launch(); TELEGRAM_BOT_TOKEN required
│   ├── commands/                     # buy, sell, wallet (connect/disconnect), config, pumpSettings, toggles, admin utils
│   ├── scenes.ts / scenes/configScenes.ts   # Multi-step wizards (connect_wallet_scene, config input)
│   ├── callbackHandlers.ts           # Inline-keyboard button wiring
│   ├── menus/, show{Buy,Sell,Wallet}Menu.ts  # Inline menu renderers
│   └── alerts.ts                     # Token/PnL alerts to configured channel(s)
├── services/
│   ├── tokenIntelligenceDispatch.ts
│   ├── moralisClient.ts
│   ├── tokenDataService.ts
│   ├── safetyCheckService.ts
│   ├── pumpFunSocialClient.ts
│   ├── pumpSwapDetection.ts          # Pure pool/migration constants+helpers for intelligence only
│   ├── pumpswapService.ts            # PumpSwapService — buy/sell removed (§8.2); settings/read-only methods only
│   ├── jupiterService.ts             # Non-custodial: connectWallet (public address) + build-only swap methods (§8.2)
│   ├── solanaPayService.ts           # Solana Pay Transaction Request sessions + link building (§8.2)
│   ├── qrCode.ts                     # Renders a Solana Pay URL as a PNG for chat delivery
│   ├── walletVerificationService.ts  # Phase 7B.2: Sign-In-With-Solana challenge/verify (§17.1) — non-custodial
│   ├── scanOwnershipService.ts       # Phase 7B.2: user <-> jobKey ownership mapping (§17.2)
│   ├── paperTradingService.ts        # Phase 7D.3.2: evidence snapshots + idempotent paper positions (§25)
│   ├── pnlImage.ts                   # Phase 7F.2: the single PnL card renderer (§22.3)
│   ├── __tests__/walletVerificationService.test.ts / .dbIntegration.test.ts   # §17.1
│   ├── __tests__/nonCustodialTradingBoundary.test.ts  # Grep-based: no key material anywhere in
│   │                                  # telegram/discord/api/trading-service source (§3 Phase 6 note)
│   ├── __tests__/tradingAllowlistWiring.test.ts       # Guards are called, not just defined (§4)
│   ├── tradingService.ts             # Legacy/unused execution class (dead code, zero callers)
│   ├── dailyTopTokensService.ts      # Telegram top-performer report generation
│   ├── riskViewLoader.ts             # Phase 6 Prisma-reading glue (see §3)
│   ├── forensicsIntelligenceLookupService.ts / forensicsIntelligenceReconciliation.ts  # Phase 5E
│   ├── sniperDataService.ts          # Retired endpoint → null
│   ├── tokenTrackingService.ts       # PnL / Discord summaries
│   └── prismaClient.ts
├── discord/                          # Alert bots (import-time login) + slash commands + registerCommands.ts
├── tracker/                          # SQLite holdings
└── pumputils/                        # Bonding-curve buy helpers (legacy)
prisma/schema.prisma
evm-verification/                     # Phase 7D.3.2 Foundry harness: test-hook suite, actual-Pons fork suite
                                      # at block 62211539, PonsRouteSimulator.sol, evidence/*.jsonl (§25)
scripts/dev-stack.sh                  # Phase 7D.3: supervises api, pons, candles (RUNBOOK.md)
scripts/check-openapi-drift.mjs       # Phase 7D.3: CI contract drift check
```

---

## 10. Discord surface

| Module | Channel env | Trigger |
|--------|-------------|---------|
| `discord/discord.ts` | `DISCORD_CHANNEL_ID` | Pool CreatePool via `index.ts` |
| `discord/discord-pumpfun.ts` | `PUMPFUN_DISCORD_CHANNEL_ID` | New mint via `pumpfun-sniper` |
| `discord/discord-pumpfun-15k.ts` | `PUMPFUN_15K_DISCORD_CHANNEL_ID` | 15k MC poll |
| PnL / daily summary | `PNL_*` / `DISCORD_PNL_SUMMARY_*` | Periodic from `index.ts` |
| `discord/commands/*` + `registerCommands.ts` | — | Slash commands, including `buy.ts`/`sell.ts`/`wallet.ts` (non-custodial — Solana Pay links via `solanaPayService`, §8.2), plus a DM-based command handler in `discord.ts` covering the same commands |

Intelligence does **not** post Discord alerts yet. The Telegram surface (§8) is a completely separate bot/library (`telegraf`, not `discord.js`) with its own alert path (`telegram/alerts.ts`).

---

## 11. Commands & verification

```bash
npm install
npx prisma generate
npx prisma validate
npx prisma migrate deploy    # full 18-migration chain, through evidence snapshots / paper positions / image cache (§25)
                              # apply both Pons migrations before starting ingestion

npm run build                 # tsc
npx vitest run                # default offline/transport tests: 1,111 passed, 82 skipped (2026-09-14);
                               # opt-in DB-integration files skipped. vitest.config.ts excludes
                               # evm-verification/, .run/, .claude/ and dist/ (vendored tests inflated counts before)
# DB suites: DATABASE_URL must name a disposable database (test/tests/ci/tmp/temp as a word) or
# ALLOW_DB_TESTS_ON_NAMED_DATABASE must equal its exact name; otherwise vitest refuses to start (§26.3)
WALLET_RUN_DB_TESTS=true npx vitest run src/services/__tests__/walletVerificationService.dbIntegration.test.ts
                               # real-Postgres atomicity/cross-account-claim proof (§17.1) — disposable DB only
npx vitest run src/pump/__tests__/eventDecoding.test.ts src/pons/__tests__/ponsAdapter.test.ts
                               # offline decoder checks against captured mainnet data (10 tests)
PUMP_RUN_DB_TESTS=true npx vitest run src/pump/__tests__/pumpTrade.dbIntegration.test.ts
                               # duplicate constraint + replay using a fresh Prisma client (§18)
PONS_RUN_DB_TESTS=true npx vitest run --no-file-parallelism src/pons src/researchApi/__tests__/robinhoodTokens.dbIntegration.test.ts
                               # real Postgres; canned chain input; real Express HTTP reads (§19.8)
npm run test:intelligence     # intelligence subset
npm run test:api-v1           # /api/v1 gateway subset only (src/researchApi) — §16
PAPER_RUN_DB_TESTS=true npx vitest run --no-file-parallelism src/services src/media src/researchApi
                               # evidence snapshots, paper positions, logo cache (§25) — disposable DB only
npm run openapi:generate      # writes openapi.json (committed since Phase 7D.3; the live route always regenerates)
npm run openapi:check         # CI drift check between Zod contracts and the committed openapi.json

cd evm-verification && scripts/install-deps.sh && forge test -vv      # Foundry 1.8.1, no RPC
ROBINHOOD_FORK_RPC_URL=<archive RPC> scripts/fork-verify.sh           # actual-Pons fork suite; exit 0/1/78 (§25)
npx prisma@6.5.0 validate

npm run dev                   # see §0/§8 — also starts the Telegram bot (non-custodial, allowlisted); API_ENABLED=true additionally starts src/api/index.ts (bearer-authenticated)
npm run pumpfun                # Pump.fun mint Discord only, no trading surfaces
npm run api                    # Canonical /api/v1 gateway, wallet/realtime + Robinhood token reads (§16–§19)
npm run api:server             # main2's read-only standalone status API
npm run forensics:worker       # disabled by default (FORENSICS_WORKER_ENABLED=false)
npm run pons:worker            # starts the Pons V1 + V2 loops; required config must be exported (§19.7)
npm run candles:worker         # candle aggregation (§21)
scripts/dev-stack.sh start     # api + pons + candles, supervised, one owner each (RUNBOOK.md)
npm run forensics:fixture      # synthetic, zero live network calls — safe to run any time
npm run x:smoke                # only place X_BEARER_TOKEN is read
```

All opt-in DB suites require `DATABASE_URL` to point at an already migrated **disposable database**. Pons suites reuse fixture identities and checkpoint sources and must run serially; their cleanup deletes those rows. `src/pons/scripts/liveVerification.ts` is a separate live-RPC harness that also deletes/reseeds Pons checkpoints, so use it only with a disposable verification database (§19.8). Neither live chain harness runs in CI.

CI (`.github/workflows/ci.yml`) has two jobs. **`build-and-test`** runs, on Node 20, for every push/PR to `main`/`master`: `npm ci` → `prisma generate` → `prisma validate` → wait for a disposable `postgres:16` **service container** to report ready (`pg_isready`) → `prisma migrate deploy` against that container → `tsc --noEmit` → `npm run openapi:check` → `vitest run` → every opt-in DB suite serially (`PONS/PUMP/FORENSICS/WALLET/CANDLES/PAPER_RUN_DB_TESTS=true`) → the real-anvil reorg proof → `npm run build`. **`foundry-verification`** (Phase 7D.3.2) installs Foundry **v1.8.1**, runs the test-hook suite, then `scripts/fork-verify.sh` against the `ROBINHOOD_FORK_RPC_URL` secret, annotating BLOCKED (exit 78) rather than failing when no archive RPC is available. The historical description of the original single-job pipeline follows: `npm ci` → `prisma generate` → `prisma validate` → wait for a disposable `postgres:16` **service container** to report ready (`pg_isready`) → `prisma migrate deploy` against that container (a real clean-install migration run every time — not a placeholder, and not a shared or persistent database; it starts empty on every job and is discarded when the job ends) → `tsc --noEmit` → `vitest run` → `npm run build`. This is a Phase 7A.1 change: CI previously used a `DATABASE_URL` string Prisma Client never actually connected with (`prisma generate` only needs it to be *set*, not reachable), which is exactly how the missing `20250324020906_init` migration (§3, §5.6) went unnoticed — `prisma migrate deploy` was never actually exercised in CI before. The default suite mocks database/provider boundaries and uses local HTTP/WebSocket transports; the six opt-in DB files connect to real PostgreSQL only when explicitly enabled — `src/api/__tests__/index.test.ts` mocks `../discord/discord` and `../telegram/telegramBot` before importing `src/api/index.ts` for exactly this reason (importing the real modules would call `client.login(DISCORD_BOT_TOKEN)` at module scope). The `src/presentation/`/`src/researchApi/`/`src/assets/`/`src/x/`/`src/forensics/` execution-boundary tests still only scan those directories (unchanged); `src/telegram/`, `src/discord/`, and `src/api/` now have their own separate regression coverage instead (§3 Phase 6 note, §8.2's intent-hardening tests, §8.3's auth tests) — so CI verifies both that the trading surface compiles *and* that its auth/allowlist/non-custodial invariants hold, but the live Solana Pay flow (a real wallet app fetching `/pay/*` and signing) is still not exercised by CI or by any test in this repo; see §14.

**What migration validation covers:** CI applies the full current chain (18 migrations at this snapshot) to a fresh `postgres:16` database; its ordinary `vitest run` does not enable the six opt-in DB suites. The historical Phase 7A.1 upgrade proof covered migrations 1–6 plus migration 7 with an existing `Wallet` row. It does not establish upgrade safety for every later migration. In particular, the second Pons migration adds required pool-context columns without defaults; apply both Pons migrations before ingestion, or plan enrichment of existing rows if upgrading a database populated between them (§19.3). No production database snapshot replay is recorded.

Prefer `npm`/`npx` (not Yarn) in this environment — `yarn.lock` has repeatedly drifted from `package-lock.json` (registry-host-only diffs) with no clear trigger found; CI only uses `npm ci`, so `yarn.lock` is not load-bearing. Also: local `npm install`/`npm ci` was found to resolve some optional transitive dependencies (`arweave`, `socks`) differently between npm 11 (many local dev machines) and npm 10.8.x (the CI runner's bundled npm on Node 20) — if `npm ci` passes locally but fails in CI with a "not in sync" lockfile error, regenerate `package-lock.json` with Node 20 (`nvm install 20 && nvm use 20 && npm install`) rather than assuming the lockfile is simply stale.

---

## 12. Environment (names only)

See `.env.example` for the names that are actually documented there — it now includes the `main2`/Solana Pay vars below.

| Area | Keys | In `.env.example`? |
|------|------|---------------------|
| DB | `DATABASE_URL` | Yes |
| RPC | `HELIUS_HTTPS_URI`, `HELIUS_WSS_URI`, `HELIUS_HTTPS_URI_TX`, `GEYSER_RPC`, `RPC_ENDPOINT` (used by `jupiterService.ts`'s non-custodial builder) | Yes |
| Moralis | `MORALIS_API_KEY`, optional `MORALIS_TIMEOUT_MS` | Yes |
| Discord | `DISCORD_BOT_TOKEN`, channel IDs | Yes |
| AI | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_TIMEOUT_MS`, `ANTHROPIC_MAX_TOKENS` | Yes |
| X (Phase X) | `X_BEARER_TOKEN`, `X_API_BASE_URL`, `X_STREAM_ENABLED`, `X_REQUEST_TIMEOUT_MS` | Yes |
| Forensics worker (Phase 5D) | `FORENSICS_WORKER_ENABLED`, `FORENSICS_WORKER_CONCURRENCY`, `FORENSICS_JOB_POLL_MS`, `FORENSICS_JOB_LEASE_MS`, `FORENSICS_JOB_HEARTBEAT_MS`, `FORENSICS_JOB_MAX_ATTEMPTS`, `FORENSICS_JOB_BASE_BACKOFF_MS` | Yes |
| Forensics integration (Phase 5E) | `FORENSICS_ENQUEUE_ENABLED`, `FORENSICS_RECONCILIATION_ENABLED`, `FORENSICS_AI_RESYNTHESIS_ENABLED` | Yes |
| Research API / `/api/v1` gateway (Phase 6, evolved in Phase 7B.1 — §16) | `API_PORT` (default 8787), `API_KEYS` (internal/admin only — §16.4), `API_PUBLIC_READS`, `PRESENTATION_RATE_LIMIT_PER_MIN`, `SCAN_ENQUEUE_LIMIT_PER_HOUR` | Yes — but see §8.4, this `API_PORT` is easy to confuse with `main2`'s unrelated same-named var |
| Supabase JWT auth (Phase 7B.1, §16.4) | `SUPABASE_URL` (only required setting — enables JWKS-based ES256/RS256 verification automatically; currently project `weafhrsgxuwrtabkjbmk`), `SUPABASE_JWT_SECRET` (legacy HS256 only), `SUPABASE_JWT_AUDIENCE`. Local-only admin tooling may also use `SUPABASE_SECRET_KEY` (never in the frontend, never committed) | Yes |
| `/api/v1` CORS (Phase 7B.1, §16.6) | `CORS_ALLOWED_ORIGINS` (never a wildcard — config load throws if `*` is present), `CORS_DEV_ORIGINS` (non-production only) | Yes |
| `/api/v1` rate-limit backend (Phase 7B.1, §16.7) | `RATE_LIMIT_BACKEND` (`memory`\|`redis` — required explicitly when `NODE_ENV=production`), `REDIS_URL` (required when backend is `redis`) | Yes |
| Wallet-challenge binding (Phase 7B.2, §17.1) | `ONLYPUMP_DOMAIN` (default `onlypump.me`), `ONLYPUMP_URI` (default `https://onlypump.me`) — baked into every challenge message server-side, never from request input | Yes |
| Realtime event bus + WS ticket store (Phase 7B.2, §17.5) | `REALTIME_BACKEND` (`memory`\|`redis` — required explicitly when `NODE_ENV=production`, reuses `REDIS_URL`), `WS_TICKET_TTL_MS`, `WS_MAX_MESSAGE_BYTES`, `WS_MAX_SUBSCRIPTIONS_PER_CONNECTION`, `WS_MAX_CONNECTIONS_PER_USER`, `WS_IDLE_TIMEOUT_MS` | Yes |
| Robinhood Chain connection (Phase 7B.4, §19.7) | `ROBINHOOD_CHAIN_ID`, `ROBINHOOD_RPC_HTTPS`, `ROBINHOOD_RPC_WSS`, `ROBINHOOD_EXPLORER` — all required | Yes |
| Robinhood RPC failover (Phase 7D.3.1, §24) | `ROBINHOOD_RPC_HTTPS2`, `ROBINHOOD_RPC_HTTPS3`, `DEAFULT_RPC_HTTPS` (real spelling), `ROBINHOOD_RPC_WSS2`, `ROBINHOOD_RPC_WSS3`, `DEAFULT_RPC_WSS` — optional, tried in that order after the primary | Yes |
| Pons contract identity (Phase 7B.4 / 7D) | `PONS_FACTORY`, `PONS_LOCKER`, `PONS_FACTORY_LEGACY`, `PONS_LOCKER_LEGACY`, `WETH_QUOTE`, `PONS_V2_FACTORY`; optional `BLOCKSCOUT_API_KEY` | Yes |
| Token-logo cache (Phase 7D.3.2, §25) | `TOKEN_IMAGE_IPFS_GATEWAYS` (comma-separated `https://` gateways; defaults to `ipfs.io`, `dweb.link`) | Yes |
| Foundry fork verification (CI / local, §25) | `ROBINHOOD_FORK_RPC_URL` (archive RPC; CI secret) | No — CI secret / shell only |
| Pons polling (optional defaults, §19.7) | `PONS_POLL_INTERVAL_MS`, `PONS_GRADUATION_POLL_INTERVAL_MS`, `PONS_MAX_BLOCK_RANGE_PER_POLL`, `PONS_CONFIRMATION_LAG_BLOCKS`, `PONS_FRESH_START_LOOKBACK_BLOCKS` | Yes |
| Opt-in DB verification | `PUMP_RUN_DB_TESTS`, `PONS_RUN_DB_TESTS`, `FORENSICS_RUN_DB_TESTS`, `WALLET_RUN_DB_TESTS`, `CANDLES_RUN_DB_TESTS`, `PAPER_RUN_DB_TESTS`; `ALLOW_DB_TESTS_ON_NAMED_DATABASE` (exact database name, §26.3); live Solana capture: `PUMP_LIVE_CAPTURE_MAX`, `PUMP_LIVE_CAPTURE_TIMEOUT_MS`, `PUMP_LIVE_CAPTURE_SPACING_MS` | No |
| Telegram bot (main2) | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHANNEL_ID`, `TELEGRAM_CHANNEL_ALERTS_ENABLED`, `TELEGRAM_ADMIN_IDS` (trading-command allowlist, fails closed — §8.6) | Yes |
| Discord trading allowlist | `DISCORD_ADMIN_IDS` (fails closed — §8.6) | Yes |
| **main2 API server — ⚠️ see §8.3-8.4** | `API_ENABLED` (default `false` — must be `true` to start the server at all), `API_HOST` (default `0.0.0.0`), `API_PORT` (default 3001, collides in name with Phase 6's), `API_PORT_MAIN` (default 3030), `API_AUTH_TOKEN` (bearer token required on every `/api/*` route — fails closed with 503 if unset) | Yes |
| **Non-custodial trading (§8.2)** | `SOLANA_PAY_BASE_URL` (required for `/buy`/`/sell` to produce a working link — no default) | Yes |
| Legacy trade | Jupiter URLs (`JUP_HTTPS_QUOTE_URI`, `JUP_HTTPS_SWAP_URI`), `PRIV_KEY_WALLET` | Partial |

Never commit real values. Never log API keys. **`PRIV_KEY_WALLET` is still a live-money credential for the legacy `transactions.ts` path (§8.1) — treat it accordingly.** A real `TELEGRAM_BOT_TOKEN` in a local `.env` starts a live Telegram bot the moment `npm run dev` runs, but per §8.2/§8.6 it can no longer spend anyone's funds by itself (every trade needs that person's own wallet approval) and only allowlisted user IDs can invoke its trading commands at all.

---

## 13. Known gaps (still true, plus new ones from the `main2` merge)

**Still open, from `main2` (see §8 for full detail):**

1. Real PumpSwap AMM swap execution was never implemented (`getPumpFunBuyInstructions`/`getPumpFunSellInstructions` were always empty placeholders, and are now removed along with the custodial signing that called them) — Jupiter is the only working swap path.
2. Any private key already imported via the old Telegram/Discord/Sniperoo flows, before the non-custodial fix, is still sitting in plaintext in Postgres (`Wallet.walletPk`, now nullable but not retroactively cleared) — those wallets should be treated as compromised and rotated.
3. `SOLANA_PAY_BASE_URL` has no real value in this dev environment, so the non-custodial buy/sell flow is verified only by unit test here, not live end-to-end — do that once deployed somewhere with a real HTTPS URL.

**Resolved (kept here for history — see §8.2-8.3, §8.6 for detail):**

- ~~Telegram/Discord/API trading executed real transactions with no RugCheck gate, no simulation flag, no confirmation step.~~ Fixed — trading is now non-custodial; every trade requires the user's own wallet approval.
- ~~Private keys imported via Telegram or created via Sniperoo were stored in plaintext in Postgres.~~ Fixed — this bot never generates, imports, or stores a private key anywhere anymore. `sniperooService.ts` is deleted.
- ~~Three independent trading backends coexisted with no shared safety layer.~~ Reduced to one working, non-custodial backend (Jupiter); the other two custodial backends are removed.
- ~~`src/api/index.ts` had no authentication on any route and started unconditionally.~~ Fixed — off by default (`API_ENABLED`), bearer-authenticated on every `/api/*` route when enabled.
- ~~`/buy`/`/sell` weren't restricted to an admin/allowlisted user.~~ Fixed — `TELEGRAM_ADMIN_IDS`/`DISCORD_ADMIN_IDS` allowlists, fail closed.
- ~~`.env.example` didn't document the Telegram/`main2`-API/Solana-Pay env vars.~~ Fixed — see §12.
- ~~The original `20250324020906_init` Prisma migration file was missing from the repo, so `prisma migrate deploy` failed against a fresh database.~~ Fixed in Phase 7A.1 — restored byte-for-byte from `origin/main`; clean-install and upgrade paths validated against real disposable PostgreSQL, and CI now runs the same clean-install validation on every push/PR (§3, §5.6, §11).
- ~~`UserPreference` had no migration.~~ Fixed in Phase 7B.1 (`20260828071721_add_user_preference`, §16.2).

**New since Phase 7D.3.2 (see §25.8, §26.4 for detail):**

12. ~~The local development database carried 11,977 Pons V2 rows wrongly marked `ORPHANED` by a DB test run.~~ Repaired 2026-09-15 (§26.4). Still open: V2 discovery lags ~1.6M blocks with 10-block polls, so V2 trades and candles are not ingested (§26.4).
13. Progressive token enrichment via `alchemy_getTokenMetadata` is **pending**: the method works on the third Alchemy key but is not wired in; enrichment uses standard ERC-20 reads through failover (§26.2).
14. A signed-out Supabase access token keeps verifying until it expires (Supabase design); the API does not check `auth.sessions`.
15. `GET /api/v1/media/token-logos/robinhood/:token` is not in the OpenAPI document; public IPFS gateways rate-limit (429) and delay logos.

**Discovery/ingestion follow-up:** §18 distinguishes the completed Solana decoder/schema slice from durable ingestion; §19.9 records Pons testnet, reorg recovery, discovery/trade coordination, price semantics, and API freshness limits. Candle tables do not yet imply candle aggregation or candle routes.

**Pre-existing (still true):**

5. Config pool named `"pumpswap"` still listens to **Pump.fun program**, not `pAMMBay…` → intelligence `source` is usually `UNKNOWN`.
6. `sendTokenAlert` still skips non-`pump` mints.
7. `pumpfun15k` npm script path is wrong.
8. No Chroma/RAG, no intelligence → Discord/Telegram notifications, no X streaming (checkpoint only).
9. `swap.amount: "1000000"` is **0.001 SOL**, not 0.1 SOL (comment wrong); this specific path stays simulation-gated regardless.
10. Multiple Discord clients may login the same bot token from separate processes (`index.ts`, `pumpfun-sniper.ts`, `discord-pumpfun-15k.ts` each construct/login their own client).
11. `yarn.lock` drifts from `package-lock.json` on plain `npm install`/`ci` for reasons not fully diagnosed (registry-host-only diffs); not load-bearing since CI only uses `npm ci`.

---

## 14. Suggested next work

**Before deploying anywhere network-reachable:**

1. Verify the Solana Pay flow live end-to-end once a real `SOLANA_PAY_BASE_URL`/deployment exists (open the generated link in an actual wallet app and confirm the transaction it shows is correct).
2. Rotate any wallet whose private key was ever imported through the old custodial flow, before this session's fixes.
3. Address the ingestion limits in §19.9 before relying on a complete, fresh discovery feed: coordinate discovery/trade progress, expose source health, and define automatic reorg recovery. Verify the actual Robinhood RPC provider under expected traffic.
4. Set real `TELEGRAM_ADMIN_IDS`/`DISCORD_ADMIN_IDS`/`API_AUTH_TOKEN` values before relying on any of §8.3/§8.6's gates — they fail closed, but only once actually configured; an empty `.env` still means "nobody" for the allowlists (correct) and "server refuses everything" for the API (also correct, but means the API literally won't work until you set a token).

**Further product work:**

5. Build durable Solana ingestion behind `ChainAdapter` using the completed `src/pump/` decoders (§18), with measured provider throughput, checkpoint recovery, and transaction ordering. The live capture harness already subscribes to both programs, but the legacy runtime has not been rewired.
6. Implement real PumpSwap AMM swap instructions, or remove the vestigial `SwapService.PUMPFUN` preference option that no longer changes anything at execution time.
7. Chroma semantic projection (Postgres remains source of truth).
8. A *safe*, read-only chat surface for the intelligence/forensics layer, following the exact pattern already proven and then reverted for Phase 6's Telegram prototype (execution-boundary-tested, no wallet input, no buy buttons) — do not reuse or extend the `main2` bot for this.
9. Fix `pumpfun15k` script path when touching scripts.
10. Add discovery-product OHLCV, Pons scam/rug scoring, ranking, AI queries, and frontend integration as separate slices; raw PostgreSQL facts remain their input (§19).

---

## 15. One-line truth

**`npm run api` serves the canonical research, wallet-ownership, realtime-job and Robinhood token APIs, plus block-pinned Pons quotes, simulations, market evidence and per-user paper positions that never sign or broadcast; `npm run pons:worker` independently ingests Pons V1/V2 launches, trades and graduation state into PostgreSQL with source checkpoints; `npm run candles:worker` turns those trades into candles. Pump.fun/PumpSwap decoding is implemented, with durable Solana ingestion still pending. The legacy `npm run dev` process separately runs Discord/listeners and the allowlisted non-custodial Telegram flow (§0, §8); the new discovery path never signs or submits transactions. Current proof and ingestion limits are recorded in §18–§19.**

---

## 16. Phase 7B.1 — the canonical `/api/v1` gateway

Phase 7B.1 turned the Phase 6 research API (`src/researchApi/`) into the versioned REST foundation the OnlyPump Vite web app and future Expo mobile app build against. It adds no new data sources and no execution — every route is either a pure Prisma read (via the existing `riskViewLoader`/`toApiJson`) or the same idempotent forensics-scan enqueue Phase 6 already had. What changed is who can call it and how: Supabase-authenticated instead of internal-only, versioned and documented, with the request/error/CORS/rate-limit hygiene a public-facing gateway needs.

### 16.1 Canonical branch

`main` was fast-forwarded to `master`'s tip (`7ba40f4`, `--ff-only`, no force, no history rewrite) and is once again the sole canonical branch — it was already GitHub's default branch throughout, and `main` **remains** that default. `master` was left in place (not deleted) as an alias pointing at the same commit; new work should target `main` going forward. This feature branch (`feature/phase-7b1-api-gateway`) was cut from the updated `main`. Setting branch-protection to require the CI check on `main` was **not completed** in this session — it needs a permission this sandbox's own tool-use policy declined for repo-settings mutations, not a GitHub permissions gap (the acting account has admin access); do it manually from GitHub's branch protection settings, or re-run this step somewhere that allows it.

A pre-existing local `main` branch (not pushed to any remote) carried one commit ("feat: add token intelligence phase 3.1", predating this session) not reachable from `master`. It was left untouched — the canonical-branch fast-forward above operated on `origin/main`/`master` directly (`git push origin master:main`), never on that local branch ref, so nothing local was discarded.

### 16.2 The `UserPreference` decision

`schema.prisma` declared `UserPreference` (`userId` unique, `pumpSwapEnabled` boolean, default `true`) with no migration anywhere in the repo's history — found while restoring the init migration in Phase 7A.1 (§3, §5.6). Before writing a migration, every reference to the model and to `pumpSwapEnabled` was inspected:

- `src/telegram/commands/togglePumpSwap.ts` — the `/togglepumpswap` command (registered, live, `src/telegram/commands/index.ts`) reads/writes it directly.
- `src/telegram/alerts.ts` — `sendTokenAlert` reads it to decide whether to DM a given user about a new Pump.fun-sourced token.
- Nowhere else. In particular: **no execution/trading-surface file reads it** — `jupiterService.ts`, `pumpswapService.ts`, `solanaPayService.ts`, and `src/api/index.ts` were all grepped and contain zero references (pinned as a regression test, `src/__tests__/migrationChain.test.ts`).

This is genuine, live, wired behavior — not a vestigial/dead field — so per phase7b1.txt §3's decision rule it was **kept, not deleted**, and given an additive migration (`prisma/migrations/20260828071721_add_user_preference`, generated via `prisma migrate dev --create-only` against a disposable Postgres 16 container and reviewed before applying — `CREATE TABLE` + one `CREATE UNIQUE INDEX`, no `ALTER`/`DROP` of anything else).

The "unsafe implication" phase7b1.txt warned about — a preference that claims to enable PumpSwap trading when no such execution exists — turned out not to apply here: despite the name, `pumpSwapEnabled` **only gates a Telegram DM notification**, never a trade. Real PumpSwap AMM execution remains unimplemented anywhere in this codebase (§8.2), and this field has no path to it. `schema.prisma`'s model now carries an explicit doc comment saying so, and both the "notification only" claim and the "default `true` is not a trading default" claim are pinned as regression tests, not just documentation.

Validated: `prisma migrate deploy` against a fresh, disposable PostgreSQL 16 database applies all 8 migrations (the restored init through this one) cleanly, in order; `prisma migrate status` reports up to date; the resulting `UserPreference` table's columns match `schema.prisma` exactly.

### 16.3 Route map

All of the following live in `src/researchApi/`, mounted under `/api/v1` by `src/researchApi/server.ts`'s `createApiServer(db, config)`. `npm run api` is the only thing that ever calls `.listen()` on it (`require.main === module` guard, same discipline as the forensics worker).

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/api/v1/health` | none | Liveness only — proves the process is alive, no dependency checks (phase7b1.txt §6) |
| GET | `/api/v1/ready` | none | Readiness — checks `SELECT 1` against Postgres; never returns the connection string or underlying driver error, only `ok`/`error` |
| GET | `/api/v1/openapi.json` | none | The live OpenAPI 3.1 document, generated on every request from the same Zod schemas the routes validate against (§16.5) |
| GET | `/api/v1/docs` | none | Swagger UI over the same document |
| GET | `/api/v1/me` | **Supabase only** | Returns `{userId, email?}` derived from the verified token's `sub`/`email` claims — never raw claims, never accepted from an internal API key (there is no "self" for a server-to-server key) |
| GET | `/api/v1/me/wallets` | **Supabase only** | Caller's verified wallets (§17.1) |
| DELETE | `/api/v1/me/wallets/:walletId` | **Supabase only** | Unlink caller's ownership-proof row (§17.1) |
| POST | `/api/v1/wallets/challenges` | **Supabase only** | Issue a wallet-ownership challenge (§17.1) |
| POST | `/api/v1/wallets/verify` | **Supabase only** | Verify signed challenge and record ownership (§17.1) |
| POST | `/api/v1/realtime/tickets` | **Supabase only** | Issue a short-lived, single-use WebSocket ticket (§17.4) |
| WS | `/api/v1/realtime` | Single-use ticket | Authenticated, user-scoped job subscriptions (§17.4) |
| GET | `/api/v1/tokens/robinhood` | Supabase or API key* | Recently discovered tokens with graduation state (§19.6) |
| GET | `/api/v1/tokens/robinhood/:tokenAddress` | Supabase or API key* | Token detail with raw trades (§19.6) |
| GET | `/api/v1/tokens/:mint/report` | Supabase or API key* | Deterministic risk view (unchanged from Phase 6, reused via `riskViewLoader`/`toApiJson`) |
| GET | `/api/v1/tokens/:mint/forensics` | Supabase or API key* | Latest `SolanaForensicsRun` for the mint, if any |
| POST | `/api/v1/tokens/:mint/scans` | Supabase or API key | Idempotent forensics-scan enqueue (renamed from Phase 6's `/scan`) — `202` on a freshly queued job, `200` with the same `jobKey` on a repeat call for the same mint |
| GET | `/api/v1/jobs/:jobKey` | Supabase or API key* | Poll a forensics job's status |
| GET | `/api/v1/tokens/robinhood/status` | Supabase or API key* | Ingestion source health (§20.5) |
| GET | `/api/v1/tokens/robinhood/:tokenAddress/candles` | Supabase or API key* | Candles (§21.13) |
| GET | `/api/v1/tokens/robinhood/:tokenAddress/pool` | Supabase or API key* | **Deprecated** — V4 pool evidence (§24); superseded by `market-evidence` |
| GET | `/api/v1/callouts`, `/api/v1/callouts/:mint` | Supabase or API key* | Verified callouts (§22.4) |
| POST | `/api/v1/tokens/robinhood/:tokenAddress/quotes` | Supabase or API key* | Block-pinned quote + evidence snapshot; 20/min limiter (§25.4) |
| POST | `/api/v1/tokens/robinhood/:tokenAddress/simulations` | Supabase or API key* | `eth_call` route simulation of a live quote (§25.5) |
| GET | `/api/v1/tokens/robinhood/:tokenAddress/market-evidence` | Supabase or API key* | Spot, depth at reference sizes, liquidity semantics (§25.6) |
| GET | `/api/v1/evidence/:snapshotId` | Supabase or API key* | Immutable evidence snapshot by id (§25.7) |
| POST / GET | `/api/v1/me/paper-positions` | **Supabase only** | Caller's paper positions; POST requires `Idempotency-Key` (§25.7) |
| GET | `/api/v1/media/token-logos/robinhood/:tokenAddress` | none | Cached, byte-verified logo or 404 with `X-Image-Status` (§25.8); not in OpenAPI |

\* Falls back to public/unauthenticated when `API_PUBLIC_READS=true` (unchanged Phase 6 behavior) — `POST /scans` never does, regardless of that flag.

Every response — success or error — carries an `X-Request-Id` header the server generates itself (never trusts a client-supplied one, to keep log correlation from being spoofable by a public caller).

### 16.4 Authentication: Supabase JWT + internal API key

`src/researchApi/middleware/supabaseAuth.ts` verifies a Supabase access token (`jose`, no other JWT library): signature, issuer (`${SUPABASE_URL}/auth/v1`), expiration, and audience (when `SUPABASE_JWT_AUDIENCE` is configured) are all checked before the `sub` claim is trusted as the application user id. Two signing mechanisms are supported, selected by the token's own (unverified) header `alg`, never by guessing:

- **Modern (ES256/RS256):** verified against the project's own published JWKS (`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`), fetched and cached by `jose`'s `createRemoteJWKSet`. No `SUPABASE_JWT_SECRET` needed — `SUPABASE_URL` alone is enough.
- **Legacy (HS256):** verified against `SUPABASE_JWT_SECRET` (Supabase project Settings → API → JWT Settings), only if that env var is set; an HS256 token is rejected outright if it isn't.

`jose`'s `jwtVerify` always checks the cryptographic signature — there is no code path here (or anywhere in this file) that trusts a merely-decoded, unsigned (`alg: none`), or unverified JWT; that's asserted directly by `src/researchApi/__tests__/supabaseAuth.test.ts`, all of it run against **local test keys** (`jose`'s `generateKeyPair`/`SignJWT`), never Supabase's real endpoint.

`src/researchApi/middleware/authenticate.ts` combines this with the Phase 6 internal `API_KEYS` bearer check (kept as the "explicitly internal/admin compatibility" path phase7b1.txt §5 asked for — this API's own equivalent of the trading API's `API_AUTH_TOKEN`, a **different** credential from a **different** file): a request is authenticated if it presents *either* a valid Supabase token *or* a value in `API_KEYS`. `GET /me` is the one exception — it strictly requires a real Supabase identity, since an opaque internal key has no "self" to return. With neither mechanism configured at all, every authenticated route fails closed with `503 AUTH_NOT_CONFIGURED` rather than silently accepting anything.

**`API_KEYS` (and the trading API's separate `API_AUTH_TOKEN`) must never reach the Vite web app or the Expo mobile app** — those are server-to-server/admin credentials only; public clients authenticate solely with their own Supabase access token. Nothing in this repository puts either value into frontend code, and `.env.example`'s comments say so explicitly.

### 16.5 Contracts: one Zod source for validation, responses, and OpenAPI

`src/researchApi/contracts/` is the single place request/response shapes are declared — `src/researchApi/contracts/openapi.ts` generates the `/api/v1/openapi.json` document directly from the same Zod schemas (`@asteasolutions/zod-to-openapi`) the routes use, so there's one definition instead of separately hand-maintained Express validation, OpenAPI JSDoc comments, and response shapes. (The mint-format check itself still goes through the existing `src/assets/assetResolver.ts` via `validateMint.ts`, reused rather than re-implemented — Phase 4's Solana `PublicKey` validation didn't need rebuilding in Zod to get an OpenAPI-documented `mint` parameter.)

Every error response uses the same envelope (`src/researchApi/contracts/errors.ts`):

```json
{
  "error": {
    "code": "INVALID_MINT",
    "message": "The supplied token mint is invalid.",
    "requestId": "b3e1..."
  }
}
```

`contracts/errors.ts` maps each error code to an HTTP status. The current set includes `BAD_REQUEST`, `INVALID_MINT`, `INVALID_ADDRESS`, `UNAUTHORIZED`, `AUTH_NOT_CONFIGURED`, `FORBIDDEN`, `NOT_FOUND`, `CHALLENGE_EXPIRED`, `CHALLENGE_ALREADY_USED`, `WALLET_ALREADY_CLAIMED`, `RATE_LIMITED`, and `INTERNAL_ERROR`. The global error handler logs unexpected errors server-side with redaction and returns only `INTERNAL_ERROR`; response envelopes do not expose raw SQL errors, credentials, connection strings or stacks.

### 16.6 CORS

`src/researchApi/middleware/cors.ts` — an explicit allowlist (`CORS_ALLOWED_ORIGINS`), never a wildcard (`loadApiConfig` throws at startup if `*` appears in it). A request with no `Origin` header (native mobile, server-to-server, curl) is never touched by this middleware — CORS is a browser-only concept. Outside `NODE_ENV=production`, an additional `CORS_DEV_ORIGINS` list (defaulting to the usual local Vite (`:5173`) and Expo (`:19006`/`:8081`) ports) is also honored; in production, only `CORS_ALLOWED_ORIGINS` counts. Since Phase 7D.3.3 the defaults also include the web app's Vite port under both host spellings (`http://localhost:8080`, `http://127.0.0.1:8080`) — browsers treat the two as different origins — and allowed requests may send `Authorization`, `Content-Type` and `Idempotency-Key`. A denied origin gets no `Access-Control-*` headers at all on a normal request (the browser enforces the block), and an outright `403` on a preflight `OPTIONS` so the browser never proceeds to the real request.

### 16.7 Rate limiting

`src/researchApi/middleware/rateLimit.ts` now sits behind a `RateLimiterStore` interface — `MemoryRateLimiterStore` (single-process fixed window, the only kind Phase 6 had) or `RedisRateLimiterStore` (shared counters via `INCR`/`PEXPIRE` against `REDIS_URL`, using `ioredis`). Which one is used is `RATE_LIMIT_BACKEND` (`memory` | `redis`), and `loadApiConfig` **fails closed on this specifically**: with `NODE_ENV=production`, `RATE_LIMIT_BACKEND` must be set explicitly (no silent default that would pretend a single process's in-memory counters are shared across a multi-instance deployment), and `RATE_LIMIT_BACKEND=redis` without `REDIS_URL` refuses to start at all. Outside production, an unset `RATE_LIMIT_BACKEND` still quietly defaults to `memory` — fine for local dev and tests. Read and scan-creation limits remain the separate Phase 6 policies (`PRESENTATION_RATE_LIMIT_PER_MIN`, `SCAN_ENQUEUE_LIMIT_PER_HOUR`); health/docs/openapi.json are never rate-limited (they're free, and a client needs them before it can even authenticate).

### 16.8 Logging

`src/researchApi/lib/logger.ts` wraps the already-installed (previously unused) `pino`, configured with a redaction path list covering `Authorization`/`Cookie` headers, any `apiKey`/`token`/`accessToken` field, and — as defense-in-depth, even though nothing in this gateway should ever hold one — `walletPk`/`privateKey`/`secretKey`/`mnemonic`/`seedPhrase`/`databaseUrl` wherever they appear in a logged object. Redaction happens inside pino's own serializer, not at each call site, so a future call that accidentally logs a whole request or config object still can't leak these paths.

### 16.9 Legacy `/api/*` (unversioned)

`src/api/index.ts` (the `main2` trading surface, §8) is unchanged and explicitly marked `⚠️ DEPRECATED / INTERNAL` in its own header comment — it still exists only for the Telegram/Discord non-custodial trading flow that already depends on `/api/wallet/connect`, `/api/transaction/{buy,sell}`, and the public `/pay/*` Solana Pay callbacks (§8.2-8.3). No new frontend work should target it; it is not part of `/api/v1` and never will be. Its Phase 7A security behavior (fail-closed bearer auth, off by default, no wallet-create/import routes) is unchanged and still covered by `src/api/__tests__/index.test.ts`.

### 16.10 New environment variables

All names-only in `.env.example`; see §12 for the full table. New in this phase: `SUPABASE_URL`, `SUPABASE_JWT_SECRET`, `SUPABASE_JWT_AUDIENCE`, `CORS_ALLOWED_ORIGINS`, `CORS_DEV_ORIGINS`, `RATE_LIMIT_BACKEND`, `REDIS_URL`.

### 16.11 Gateway follow-up (after Phase 7B.4)

1. Branch protection on `main` requiring the CI check was not set (§16.1 — sandbox tool-use policy, not a GitHub permissions gap).
2. Live end-to-end Supabase auth against a real Supabase project was not exercised — everything here is proven against local test keys (§16.4); do that once the OnlyPump frontend actually calls this gateway.
3. `RedisRateLimiterStore` was proven against a mocked `ioredis` client, never a live Redis instance — validate against a real (disposable/staging) Redis before relying on `RATE_LIMIT_BACKEND=redis` in production.
4. ~~Authenticated WebSockets~~ — built in Phase 7B.2 (§17). X/Ansem monitoring, wallet-following intelligence, token creation, and PumpSwap execution are still explicitly out of scope and remain unbuilt.
5. No TypeScript client was generated from the OpenAPI document yet — the contract layer (§16.5) was built to make that possible later, not to do it now.
6. `GET /api/v1/tokens/:mint/report` and `/forensics` still 404 a mint that was only ever `POST`ed to `/scans` and hasn't completed — this is unchanged Phase 6 behavior (see `riskViewLoader.ts`), not new to this phase, but worth deciding whether the frontend needs a "processing" distinction from "never analysed."

---

## 17. Phase 7B.2 — wallet-ownership verification and realtime job events

Delivers the backend half of "Supabase login → connect Solana wallet → prove wallet ownership → inspect token → request scan → receive authenticated realtime completion" (phase7b2.txt). No execution, no custodial signing, no trading — this phase proves a user controls an address and delivers job-lifecycle notifications faster than REST polling; it does not let a wallet proof, a social signal, or anything else trigger a trade.

### 17.1 Wallet-ownership verification (Sign-In-With-Solana style)

`src/services/walletVerificationService.ts` — the only place a signature is checked. Flow:

1. `POST /api/v1/wallets/challenges` (Supabase-only auth, like `/me`) takes a Solana address, returns a `challengeId`, a human-readable `message`, and an `expiresAt` (~5 minutes out).
2. The message is generated server-side from fields bound at creation time — the authenticated Supabase user id, the address, `ONLYPUMP_DOMAIN`/`ONLYPUMP_URI` (never taken from request input), a cryptographically random nonce, issued-at, and expiry — and states plainly that it proves ownership, signs the user into/connects the wallet to OnlyPump, and does **not** authorize a transaction or transfer funds. It also says (for user reassurance) that it never grants access to a private key or seed phrase.
3. The frontend has the wallet sign those exact message bytes with `signMessage` (never a transaction) and calls `POST /api/v1/wallets/verify` with `{challengeId, address, signature}`.
4. The server re-derives the same message from the stored challenge row, verifies the detached Ed25519 signature (`tweetnacl`) against it and the submitted public key, checks the challenge hasn't expired or already been consumed, and that it was issued to this same Supabase user for this same address.
5. On success, an atomic `updateMany` (guarded by `consumedAt: null` — never a separate read-then-write) marks the challenge consumed, and a `VerifiedWallet` row is created. **Real-Postgres-verified**: two simultaneous verify calls for the same challenge — only one ever succeeds (`src/services/__tests__/walletVerificationService.dbIntegration.test.ts`, opt-in, `WALLET_RUN_DB_TESTS=true`).

Persistence (`prisma/migrations/20260828082913_add_wallet_verification_and_scan_ownership`, additive):

- `WalletChallenge` — stores `challengeHash` (sha256 of the raw challenge id handed to the client), never the raw id itself ("store hashes where practical instead of reusable plaintext secrets," phase7b2.txt §2). The full `message` text *is* stored — unlike the challenge id, the message is meant to be publicly readable; it's what the signature is actually checked against.
- `VerifiedWallet` — a dedicated, non-custodial model. **Not** a reuse of `Wallet.walletPk` (§8's legacy, nullable, never-written custodial column) — this table has no secret-key column of any kind, checked by both a unit test and a migration-content regression test. `@@unique([network, address])` means one address can be verified by at most one OnlyPump account at a time — the default "prevent cross-account claims" phase7b2.txt §2 asked for, enforced by Postgres itself (real-Postgres-verified in the same opt-in integration test) as well as in application code. Re-verifying the same address under the *same* user is idempotent, not an error.
- Unlinking (`DELETE /api/v1/me/wallets/:walletId`) only deletes the ownership-proof row for the caller's own wallet (`userId` + `id`, both checked) — it never touches `SolanaForensicsRun`, `TokenIntelligenceReport`, or any other data that address may appear in.

### 17.2 User-scoped scan/job access

The underlying `SolanaForensicsJob` stays globally deduplicated by mint + analysis policy (Phase 5D, unchanged) — many users requesting the same mint around the same time still share one job. What's new is `UserScanRequest` (`userId` + `mint` + `jobKey`, `@@unique([userId, jobKey])`, additive in the same migration as §17.1): an ownership/subscription mapping recorded by `POST /api/v1/tokens/:mint/scans` for every Supabase-authenticated caller (an internal API-key caller has no Supabase user id to scope to, and keeps its prior unscoped access instead — see below).

`GET /api/v1/jobs/:jobKey` now checks this mapping (`src/services/scanOwnershipService.ts`'s `userOwnsJob`) for a Supabase-authenticated caller before returning anything — an unowned or unknown `jobKey` both return a plain `404`, so the response never confirms a job exists to someone who isn't allowed to see it. An internal `API_KEYS` caller (admin/server-to-server, §16.4) is deliberately **not** scoped this way — that's the intended difference between an end-user credential and an internal one, same principle already used for the `/api/v1/tokens/*` read routes. The WebSocket subscribe path (§17.4) uses the exact same `userOwnsJob` check before adding a subscription, so the REST and realtime authorization stories are identical, not two separately-maintained rules.

### 17.3 Realtime event envelope

`src/researchApi/realtime/eventEnvelope.ts` — one authoritative, versioned shape:

```json
{ "version": "1", "eventId": "uuid", "type": "scan.completed", "occurredAt": "ISO-8601", "data": {} }
```

Zod-validated (`RealtimeEventEnvelopeSchema`), and the same schema module (`contracts/zodOpenApi.ts`) as every REST contract. Six event types are defined: `connection.ready`, `scan.accepted`, `scan.started`, `scan.completed`, `scan.failed`, `token.report.updated`. **Only the first five are currently emitted anywhere** — `token.report.updated` is defined (so the type union, validation, and any future client generation already account for it) but no code path publishes it yet in this phase; wiring it to the intelligence pipeline's own report-save path (separate from the on-demand forensics-scan flow this phase built) is future work, not silently claimed as done.

`scan.accepted` fires from `POST /api/v1/tokens/:mint/scans` (the API process) right after the enqueue call has genuinely succeeded — including on the idempotent-repeat path, since a second subscriber to an already-in-flight job still needs to see it. `scan.started`/`scan.completed`/`scan.failed` fire from inside `ForensicsWorker` (`src/forensics/forensicsWorker.ts`'s new optional `onJobLifecycleEvent` callback, wired only from `forensicsWorkerMain.ts`, mirroring the existing `onRunPersisted` reconciliation-callback pattern) — always *after* the corresponding DB status transition has committed, never before or instead of it. `scan.failed` fires only on a **genuinely terminal** failure (`failForensicsJob`, permanent or retries-exhausted) — a retryable failure that requeues the job (`retryForensicsJob`) does not fire an event, per phase7b2.txt §5's "do not emit artificial progress ... only emit states the backend genuinely knows." A lifecycle-callback failure is logged and swallowed; it never fails or blocks the underlying job.

**The job record and REST API remain the source of truth.** Realtime delivery is best-effort — `GET /api/v1/jobs/:jobKey` (or `/report`) is always the way to reconcile true state after a reconnect or a missed event; nothing in this backend assumes a WebSocket message was actually delivered.

### 17.4 Authenticated WebSocket: `/api/v1/realtime`

Never a Supabase JWT (or any other long-lived credential) in the WebSocket query string. Instead:

1. `POST /api/v1/realtime/tickets` (Supabase-authenticated REST) issues a cryptographically random, single-use ticket bound to the caller's user id, good for `WS_TICKET_TTL_MS` (default 45s, within phase7b2.txt §4's ~30-60s window).
2. The client connects to `wss://.../api/v1/realtime?ticket=<ticket>`. The upgrade handler (`src/researchApi/realtime/websocketServer.ts`) atomically consumes the ticket (`TicketStore.consume` — a single `GETDEL` against Redis in production, an unconditional-delete-then-check `Map` operation in memory; either way, a second consume attempt for the same ticket always returns null, even under a real race — see `src/researchApi/__tests__/ticketStore.test.ts`) before completing the handshake. Missing, unknown, expired, or already-used tickets all get the upgrade rejected outright (no 101 Switching Protocols).
3. **Origin is checked independently of the CORS middleware** — browser CORS/preflight machinery does not apply to a WebSocket upgrade at all, so `isAllowedOrigin()` re-checks the `Origin` header (when present — a missing Origin means a non-browser/native client, not subject to this check) against the exact same `CorsConfig` allowlist, in its own code path, before the ticket is even looked up.
4. Once connected, the server immediately sends `connection.ready`. The client then sends `{type:"subscribe", jobKey}` for each job it wants updates on — checked against `userOwnsJob` (§17.2) every time, denying an unowned/unknown job with a plain `NOT_FOUND` error frame (never confirming existence). `{type:"unsubscribe", jobKey}` reverses it. Any other message shape — including one that tries to smuggle an `apiKey`/`jwt`/credential-shaped field — is simply an unrecognized shape, rejected the same as any other invalid message (`src/researchApi/__tests__/websocketServer.test.ts` asserts this explicitly).
5. Hygiene, all configurable via `RealtimeConfig` (`../config.ts`): `ws`'s own `maxPayload` enforces `WS_MAX_MESSAGE_BYTES` (default 8KB) and terminates a connection that exceeds it; `WS_MAX_SUBSCRIPTIONS_PER_CONNECTION` (default 20) and `WS_MAX_CONNECTIONS_PER_USER` (default 5) are enforced in-process; a ping/pong heartbeat (`WS_IDLE_TIMEOUT_MS`, default 60s) terminates connections that stop responding; `attachRealtimeServer()` returns a `close()` handle used for graceful shutdown (closes every open connection with code 1001, then the `WebSocketServer` itself) — wired into `server.ts`'s existing `SIGINT`/`SIGTERM` handler.

All of the above is proven with a real ephemeral `http.Server` + a real `ws` client per test — the same "real transport, disposable instance" principle already used for Postgres integration tests, never a live/shared endpoint (`src/researchApi/__tests__/websocketServer.test.ts`, 18 tests: ticket valid/missing/unknown/expired/reused, allowed/disallowed/absent Origin, invalid JSON, schema-invalid message, oversized message, unauthorized subscribe, end-to-end event delivery through the real event bus, unsubscribe, subscription/connection limits, no-credentials-accepted, graceful shutdown).

### 17.5 Distributed event bus and ticket store

`src/researchApi/realtime/eventBus.ts` (`EventBus`) and `.../ticketStore.ts` (`TicketStore`) are both built the same way as Phase 7B.1's `RateLimiterStore` (§16.7): an interface, an `InMemoryEventBus`/`MemoryTicketStore` (single-process only — fine for tests and local dev), and a `RedisEventBus`/`RedisTicketStore` for anything multi-process. `RedisEventBus` uses real Redis Pub/Sub with **two** connections (`ioredis`'s own convention — a connection issuing `SUBSCRIBE` cannot run any other command, so publish and subscribe never share one). Both are governed by one new config knob, `REALTIME_BACKEND` (`memory`|`redis`, reusing `REDIS_URL`) — chosen as a single shared setting rather than two separate ones because a multi-process deployment needs *both* the event bus and the ticket store to be distributed simultaneously to work at all (unlike rate limiting, which merely degrades — a per-process ticket store or event bus would be **broken**, not just weaker, the moment there's more than one process). Same fail-closed rule as `RATE_LIMIT_BACKEND`: `NODE_ENV=production` refuses to start without `REALTIME_BACKEND` set explicitly, and `REALTIME_BACKEND=redis` without `REDIS_URL` refuses to start at all.

`forensicsWorkerMain.ts` (a **separate process** from the API/WebSocket server) constructs its own `EventBus` from the same config and publishes job-lifecycle events onto it — proving the cross-process design requires an actual Redis instance in production; the worker and the API only ever agree on job state through Postgres and, for realtime delivery, through Redis Pub/Sub. All bus/ticket-store tests use a **mocked** `ioredis` client (`vi.fn()`-based fakes simulating `INCR`/`PEXPIRE`/`GETDEL`/`SUBSCRIBE`/`PUBLISH`) — never a live Redis connection, per phase7b2.txt §11.

### 17.6 Wallet/realtime follow-up (after Phase 7B.4)

1. `RedisEventBus`/`RedisTicketStore` are proven against mocked `ioredis` clients only — validate against a real (disposable/staging) Redis instance before relying on `REALTIME_BACKEND=redis` in production (same open item as §16.7's `RedisRateLimiterStore`).
2. `token.report.updated` is defined in the event-type union but not wired to any emitter yet (§17.3) — needs a decision on whether/how to connect it to the intelligence pipeline's own report-save path.
3. No live Supabase project, no live Solana wallet-adapter signature, and no live multi-process (API + worker) Redis relay were exercised end-to-end — everything here is proven with local test JWT keys, an ephemeral test keypair for signing, and disposable/mocked infrastructure. Do the real thing once there's a real deployment to test against.
4. `ONLYPUMP_DOMAIN`/`ONLYPUMP_URI` need real values before any challenge message is meaningful outside this dev environment.
5. The frontend integration (`only-pump-me`) is tracked separately — see that repository's own `ARCHITECTURE.md`/README for its side of this phase.

---

## 18. Phase 7B.3A1 — Pump.fun/PumpSwap decoding and schema foundation

Commit `a1c4507` adds `src/pump/` and migration `20260904080939_add_pump_lifecycle_and_trades`. This completes the decoder/schema slice: it does not start a persistent Solana ingestion worker, update the legacy listeners, implement lifecycle-state resolution, or expose candle routes.

### 18.1 Event decoding and identity

`eventWalker.ts` requires `meta.err === null` before inspecting a transaction, finds recognized Anchor self-CPI events from both Pump.fun and PumpSwap, and reconstructs enclosing calls from inner-instruction `stackHeight`. `borshReader.ts`, `discriminators.ts`, and `eventDecoder.ts` implement the verified field layouts for Pump creation, trades, completion and AMM migration, plus PumpSwap buys/sells. Pool-creation/boost event envelopes are also recognized by the walker. Routed trades resolve their mint/quote mint from the actual enclosing call accounts using `instructionAccounts.ts`.

`eventIdentity.ts` defines the persistent identity `(signature, outerInstructionIndex, innerPosition, emittingProgram)`. `innerPosition` is non-null, with `-1` reserved for a direct-event sentinel, so PostgreSQL cannot admit duplicate identities through nullable unique-key fields. Both `PumpLifecycleEvent` and `PumpTrade` enforce this identity with `@@unique`.

`normalizeTrade.ts` projects trade events to `NormalizedPumpTrade`, with string amounts/prices and `priceUsd: null`. PumpSwap buys use `baseAmountOut` and `userQuoteAmountIn`; sells use `baseAmountIn` and `userQuoteAmountOut`. The buy mapping is verified against actual account-balance deltas. The successful routed sell fixture proves decoding/account resolution, but its intermediate-hop balances cannot independently prove isolated sell proceeds. `blockTime` comes from the transaction; a missing value prevents normalization. Event timestamps remain separate provenance. `priceQuote` is a raw quote/token amount ratio, computed with integer arithmetic to 18 fractional digits.

### 18.2 Persistence and runtime boundary

The migration adds six models:

| Model | Role |
|---|---|
| `PumpLifecycleEvent` | Versioned JSON facts, source/status, pool/curve addresses, transaction and instruction provenance |
| `TokenLifecycleState` | Latest per-mint lifecycle projection; resolver service remains future work |
| `PumpTrade` | Raw trades, decimal-safe `Decimal(24,0)` token/quote amounts, canonical event deduplication |
| `PumpCandle` | Candle schema with `Decimal(38,18)` OHLC and raw volumes; no aggregator yet |
| `PumpCandleRevision` | Serialized revisions with an increasing sequence; no revision publisher yet |
| `SolUsdRate` | Provider feed/rate provenance; no rate ingestion service in this slice |

Transaction position is nullable in persisted provenance. The schema documents a cached `getBlock` signature-array lookup as the future ordering fallback; a running ordering/reconciliation service has not landed. These tables remain separate from Phase 7B.4's generic discovery tables. No Solana implementation of `ChainAdapter` currently bridges the two.

### 18.3 Recorded validation and remaining throughput work

[Fixture provenance](./src/pump/__tests__/fixtures/mainnet/SOURCE.md) documents six real mainnet captures, including creation plus developer buy/completion, atomic migration across both programs, routed sells, a direct buy, and a failed slippage transaction. Six offline decoder tests consume these captures. `pumpTrade.dbIntegration.test.ts` opts into real PostgreSQL to verify unique-key rejection and replay idempotency using a fresh Prisma client; this simulates a restart, not an operating-system process kill.

Commit `a1c4507` records migration validation against disposable PostgreSQL 16 and live read-only capture through the configured Helius endpoint. `scripts/liveCaptureVerification.ts` subscribes to both programs and decodes fetched transactions, but has no DB/checkpoint writer. Its header records a failed initial attempt with 111,769 rate-limit responses in 75 seconds and zero decodes; the revised harness uses serial, spaced HTTP requests and measures dropped notifications/latency. It demonstrates capture capability, not complete ingestion at production traffic. A provider-capacity decision and durable recovery remain prerequisites for the Solana adapter.

---

## 19. Phase 7B.4 — Robinhood Chain / Pons ingestion

Commit `874166f` implements and tests the ingestion foundation requested in [phase7b4.txt](./phase7b4.txt): real Pons launch/trade data in PostgreSQL, independent persisted checkpoints, graduation state reads, and canonical token read routes. The commit records live mainnet validation with **9 discovered tokens, 180 decoded trades, and 1 real graduation**, plus checkpoint/restart recovery and reorg detection. The evidence and limits are separated in §19.8–§19.9; the original brief's subscription, event-supply, and pricing descriptions are not exact descriptions of the shipped code.

### 19.1 Chain identity, transport and verified ABI

The configured mainnet identity is Robinhood Chain `4663` (`0x1237`); testnet is `46630`. The checked-in phase evidence identifies `rpc.mainnet.chain.robinhood.com` as the public HTTP RPC and `feed.mainnet.chain.robinhood.com` as a raw Arbitrum Nitro sequencer feed. The latter ignored the recorded `eth_subscribe("newHeads")` probe, so **the worker uses HTTP `eth_getLogs` polling**, with no JSON-RPC WebSocket subscription. `ROBINHOOD_RPC_WSS` stays independently configured and required, but is never opened by this worker.

Only `PONS_FACTORY` is watched for `TokenLaunched`. The active address recorded by the ABI/fixtures is `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB`. Locker and legacy factory/locker settings are retained but not queried by the loops; legacy-factory history is outside this slice. Pons tokens launch directly into a Uniswap V3 pool. Graduation is a state change read from the factory, with no migration event or pool/venue move.

[`src/pons/abi.ts`](./src/pons/abi.ts) records the official Pons repository/contract metadata provenance and live verification. Captured mainnet block `9019252`, transaction `0x92476c6f12444023711b221057dcffab166f673027479008f959ca37f5f21eb7`, contains both events below:

| Event | Matched topic0 | Log index |
|---|---|---|
| `TokenLaunched(address,address,address,address,address,uint256,uint256,uint256,uint256,uint256)` | `0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a` | 15 |
| `Swap(address,address,int256,int256,uint160,uint128,int24)` | `0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67` | 19 |

The launch identifies token `0x055650555Be80649397084Cd3f8a09b4350e8612` and pool `0x8f4F723f10fc7bAD28742d25c91158C728557C4c`. **Supply is not in `TokenLaunched`**: discovery must enrich it with `getLaunchedToken(token)`, which also supplies `isToken0` and `poolFee`. The fixture's enrichment returned supply `1000000000000000000000000000`, `isToken0=true`, and `poolFee=10000`. The recorded `graduationStatus` read returned `[1827844566659732282, 4200000000000000000, false]`; viem decodes these three outputs as a positional tuple. See [Pons fixture provenance](./src/pons/__tests__/fixtures/SOURCE.md).

`WETH_QUOTE` identifies `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`, whose recorded bytecode is a proxy. The current worker reads neither `deposit()`/`withdraw()` nor `decimals()`; trade context uses the launch's `pairToken`. Proxy semantics and human-unit price conversion remain outside the implemented path.

### 19.2 Normalized event contract and adapter seam

`src/discovery/types.ts` defines **`ChainAdapter<TRawDiscovery, TRawTrade>`**, with synchronous `decodeTokenDiscovered` and `decodeTrade` methods. The concrete `ponsAdapter` in `src/pons/ponsAdapter.ts` receives fetched logs and enrichment without performing network or database I/O. `src/discovery/decimal.ts` provides integer division to 18 fractional digits.

- `NormalizedTokenDiscovered`: chain/venue, token, deployer, nullable pool, quote token, supply, initial buy, provenance and observation time.
- `NormalizedTradeExecuted`: chain/venue, token/pool, side, token/quote amounts, quote token, price, trader, provenance and observation time; `priceUsd` stays null and is not stored/exposed by these routes.
- `ChainProvenance`: source height/hash, transaction hash and event index. Heights and monetary values are decimal strings; `observedAt` is processing time, not block time.
- `NormalizedGraduationStatus`: separate poll-result contract, excluded from the event union. The current poller writes its decoded tuple directly to the discovered-token row.

The current event union has discovery and trade facts; there is no standalone `liquidityEstablished` event. Pool presence is carried on discovery. The interface reserves `robinhood` and `solana`, but Pons is the only implementation. The listeners still explicitly invoke `ponsAdapter`, and persisted `isToken0`/`poolFee` remain Pons pool context; adding Solana requires adapter and integration work.

### 19.3 PostgreSQL source of truth

Two additive migrations complete this phase:

1. `20260906024200_add_robinhood_chain_ingestion` — creates the three tables below.
2. `20260906024417_add_discovered_token_pool_context` — adds required `DiscoveredToken.isToken0` and `poolFee`, plus a chain/pool index. These columns have no defaults: apply both migrations before starting ingestion. A database populated after only the first migration requires an explicit enrichment/backfill plan before the second can apply.

| Model | Contents and constraints |
|---|---|
| `DiscoveredToken` | Launch identity, deployer, pool/quote, supply/initial buy, pool context, source provenance, observation time and graduation fields. Unique `(chain, tokenAddress)`; indexes for chain/time, graduation and pool. |
| `ChainTrade` | Raw buy/sell amounts, quote token, `priceQuote`, recipient as `trader`, pool and source provenance. Unique `(chain, sourceTxHash, sourceIndex)`; index `(chain, tokenAddress, sourceHeight)`. |
| `ChainIngestionCheckpoint` | Primary key `source`, `lastHeight: BigInt`, `lastHash`, and `updatedAt`; separate discovery and trade positions. |

Raw amount columns use **`Decimal(78,0)`** to accommodate uint256 values; `ChainTrade.priceQuote` uses **`Decimal(60,18)`**. This intentionally differs from Solana's `Decimal(24,0)` raw amounts. All EVM addresses written by listeners are lowercased before unique-key lookup/persistence. The tables preserve normalized provenance, not complete raw log JSON; raw ABI captures are test fixtures.

`src/assets/chainRegistry.ts` also adds canonical `ROBINHOOD` with numeric chain ID string `4663`. Robinhood route validation passes that chain explicitly to `resolveAsset`; unhinted EVM addresses retain the existing Ethereum/BNB ambiguity behavior. Ingestion writes `DiscoveredToken`/`ChainTrade`, not `Asset`/`AssetObservation`.

### 19.4 Discovery, trades, checkpoints and reorg handling

`DiscoveryListener.runOnce()` reads the chain tip minus the confirmation lag, verifies the stored checkpoint block hash when present, and fetches a bounded `TokenLaunched` range from the active factory. Every decoded launch is enriched before writing. If enrichment or a required RPC read is unavailable, that range is not committed. Launch upserts and the range-end checkpoint commit in one Prisma transaction, including ranges with zero launches.

`TradeListener.runOnce()` loads discovered Robinhood pools and persisted token ordering, polls their `Swap` logs, and commits trade upserts plus its own range-end checkpoint atomically. With no tracked pools it returns `NO_POOLS_TRACKED`. Positive V3 token amounts mean tokens entered the pool (sell); negative means tokens left it (buy). The adapter stores absolute token/quote amounts, uses `recipient` as `trader`, and computes **`priceQuote = abs(quoteAmount) / abs(tokenAmount)`**, truncated to 18 fractional digits. It does not derive spot price from `sqrtPriceX96`, adjust token decimals, or identify a router's ultimate economic trader.

Checkpoint sources are `robinhood:pons:discovery` and `robinhood:pons:trades`. Restart begins at `lastHeight + 1`; a fresh source starts within the configured lookback window. Each tick covers at most `PONS_MAX_BLOCK_RANGE_PER_POLL` blocks. Writes and checkpoints share a transaction, so a failed commit cannot advance the position past uncommitted rows; database uniqueness makes replay idempotent.

Both listeners compare the saved checkpoint hash with the chain before proceeding. A mismatch returns `REORG_DETECTED`, logs an error, and leaves rows/checkpoint unchanged. The timer continues checking on later ticks, but ingestion cannot advance while the mismatch persists. Automatic rollback, orphan marking and replay are deferred. The worker has no claim/lease mechanism: operate one worker per source/database. Discovery and trade checkpoints are independent; coordinating them for newly discovered pools remains an open completeness issue (§19.9).

### 19.5 Graduation poller and worker lifecycle

`GraduationPoller.runOnce()` reads `graduationStatus(token)` for tracked rows with `graduated=false`. Successful reads update paired principal, threshold, graduated flag and `graduationCheckedAt`; one token's RPC failure is counted/logged and does not block other tokens. Failed reads preserve the previous state. Graduated rows are not polled again. Until the first successful read, the boolean defaults to false and the nullable status fields/timestamp distinguish an unchecked token.

`scripts/ponsWorkerMain.ts` constructs one Prisma client and one `PonsChainClient`, then explicitly starts discovery, trade and graduation timers. Each loop exposes `runOnce`, `start` and `stop`, and schedules its next tick after the prior tick finishes. Library imports do not start ingestion. The entrypoint handles `SIGINT`/`SIGTERM` by stopping timers, disconnecting Prisma and exiting; it does not explicitly await in-flight ticks before disconnecting.

`PonsChainClient` wraps viem HTTP reads behind the injectable `ChainReader` interface. Defaults are an 8-second transport timeout and up to three wrapper retries with jittered exponential delay (200 ms base, 4-second cap); viem transport retry behavior can add attempts. Results are typed `AVAILABLE`/`UNAVAILABLE`, with `TIMEOUT`, `RATE_LIMITED`, `NETWORK_ERROR` or `RPC_ERROR`; non-retryable RPC rejection ends the wrapper retry loop. There is no fixture fallback. Worker logging currently uses prefixed console methods, not the gateway's redacting Pino logger; raw provider failure reasons can flow into worker diagnostics (§19.9).

### 19.6 Canonical read routes

`src/researchApi/routes/robinhoodTokens.ts` is mounted before the generic mint router. It only reads PostgreSQL and reuses authentication, rate limiting, server-generated request IDs and the existing error envelope. `contracts/robinhoodTokens.ts` supplies the Zod query/response schemas registered in the shared OpenAPI generator; `validateRobinhoodAddress.ts` reuses canonical asset resolution.

| Route | Behavior |
|---|---|
| `GET /api/v1/tokens/robinhood` | Recently observed tokens, newest first; `limit` defaults to 25 (1–100), optional ISO datetime `cursor`, response `{tokens, nextCursor, observedAt}`. |
| `GET /api/v1/tokens/robinhood/:tokenAddress` | Token with newest raw trades ordered by source height; `limit` defaults to 50 (1–200), response `{token, trades, observedAt}`. |

Reads accept Supabase JWT/internal API keys, or unauthenticated access when `API_PUBLIC_READS=true`. Bad query values return `400 BAD_REQUEST`, malformed addresses `400 INVALID_ADDRESS`, and an undiscovered address `404 NOT_FOUND`. Decimal values use Prisma `toFixed()` to preserve complete non-exponential strings; heights are strings and dates are ISO timestamps. List pagination currently uses only `observedAt`, so equal timestamps at a page boundary have no unique tie-breaker; detail has no trade cursor or within-block secondary ordering.

These responses expose stored facts. They do **not** probe RPC health or expose ingestion lag/checkpoints; the top-level `observedAt` is response time. An unavailable chain can therefore leave the API serving older data without an explicit source-unavailable indicator. `/ready` checks PostgreSQL only. No Pons realtime notifications are emitted in this phase.

### 19.7 Configuration and operation

`loadRobinhoodChainConfig()` is called explicitly at worker startup. It requires all nine connection/contract settings listed in §12, validates positive integer settings and 20-byte hex addresses, and returns frozen configuration. URL settings are checked for presence, not scheme/provider identity, and the worker does not compare a live `eth_chainId` with configured `ROBINHOOD_CHAIN_ID` at startup.

| Optional setting | Default |
|---|---|
| `PONS_POLL_INTERVAL_MS` | `5000` |
| `PONS_GRADUATION_POLL_INTERVAL_MS` | `60000` |
| `PONS_MAX_BLOCK_RANGE_PER_POLL` | `2000` |
| `PONS_CONFIRMATION_LAG_BLOCKS` | `5` |
| `PONS_FRESH_START_LOOKBACK_BLOCKS` | `1000` |

All tuning values must be positive safe integers; zero is rejected. Required connection/contract values have no built-in mainnet defaults. `npm run pons:worker` starts ingestion immediately once configuration is valid; there is no worker-enabled flag. Export configuration before running it: the entrypoint does not preload dotenv. For an explicitly selected local `.env`, `node -r dotenv/config -r ts-node/register src/pons/scripts/ponsWorkerMain.ts` provides that preload. The tracked `.env.example` has not yet been extended with these settings.

Run `npm run api` separately for HTTP reads. Neither command needs the legacy trading API or Telegram bot to start. The phase brief records public Robinhood endpoint rate limits; an Ethereum-mainnet RPC URL is not a Robinhood endpoint, and public feed URLs must not be derived unconditionally from HTTP URLs.

### 19.8 LOCALLY PROVEN — recorded evidence and reproducible checks

The following is the implementation's recorded verification, not a claim that live infrastructure was re-exercised during this documentation update:

| Evidence | What it establishes |
|---|---|
| Commit `874166f` completion record | Reports live mainnet RPC → PostgreSQL validation: 9 tokens, 180 trades, 1 graduation, checkpoint/restart recovery and reorg detection. |
| `abi.ts` and [fixture provenance](./src/pons/__tests__/fixtures/SOURCE.md) | Real launch/swap topic0 matches at block `9019252`, launch enrichment and a sane graduation tuple. Four offline adapter tests decode these captures and reject mismatched event shapes. |
| `discoveryListener.dbIntegration.test.ts` | Real PostgreSQL launch/checkpoint persistence, resume using a new listener, no duplicate row, and checkpoint-hash mismatch detection. Chain reads are simulated; this is not a live-chain or OS process-kill test. |
| `tradeListener.dbIntegration.test.ts` | Real PostgreSQL trade/checkpoint persistence, no-pool behavior and replay idempotency with a simulated restart and canned chain reads. |
| `robinhoodTokens.dbIntegration.test.ts` | Real Express HTTP requests against real PostgreSQL: list/detail with seeded token/trade rows, decimal-safe output, 404 and malformed-address 400. It enables public reads and uses synthetic DB seed addresses; it is not proof of an authenticated live-chain-to-HTTP run. |
| `scripts/liveVerification.ts` | Live mainnet harness invoking actual discovery/trade `runOnce` methods from a checkpoint preceding block `9019252`, with a range cap of 50,000 blocks. It writes rows and reseeds checkpoints in its target DB. |

Use the commands in §11 to run the offline tests and opt-in DB suites. The DB suites must use a migrated disposable database and run serially. With the same disposable setup and exported Pons configuration, `npx ts-node src/pons/scripts/liveVerification.ts` exercises live discovery/trades; it does not itself test graduation, HTTP, process kills or RPC failures, and its final message alone is not a comprehensive success assertion. Both Pons migrations must already be applied.

**Documentation-update verification:** the two offline Pump/Pons decoder files passed, **10 tests total**. Live RPC, migrations, DB integration and deployment were not rerun for this documentation-only change.

### 19.9 NOT PROVEN / deferred / implementation limits

1. **Testnet Pons ingestion:** recorded testnet reachability returned the expected chain ID/blocks, but the documented mainnet factory and quote addresses had no testnet bytecode. The completed live proof therefore used mainnet read-only HTTP calls. A verified testnet Pons deployment is needed for testnet-specific launch/trade proof; an `eth_subscribe` proof was not delivered by this HTTP implementation.
2. **Crash and completeness proof:** the commit reports checkpoint/restart recovery, while checked-in regression tests simulate restarts. No checked-in harness kills the worker mid-write and verifies all missed live blocks after restart. Trade polling can advance independently of discovery and uses a pool list loaded before the tick; a newly discovered pool can have earlier trades below the trade checkpoint. Coordinated progress or per-pool catch-up and a real crash/restart test are needed before claiming a gap-free feed across concurrent loops.
3. **Reorg recovery:** detection preserves existing rows and refuses to advance; canonical rollback/replay, orphan visibility in reads, and graduation-state reconciliation are unimplemented. Manual remediation needs a concrete recovery procedure rather than blindly deleting checkpoints.
4. **Outage behavior and diagnostics:** the RPC wrapper has typed failures/retries, but these tests do not reproduce live rate limiting/unreachable-RPC behavior. Discovery/trade timer callbacks ignore returned `UNAVAILABLE` results, API reads have no source-health/lag indicator, and console worker logging lacks Pino redaction. Verify outage behavior, report ingestion status, and redact provider error details before using credential-bearing RPC diagnostics operationally.
5. **Prices, provenance and pagination:** stored `priceQuote` is a truncated raw-amount execution ratio, not decimal-adjusted `sqrtPriceX96` spot price or USD price. Full raw logs/block timestamps are not persisted. Cursor timestamp ties, within-block trade ordering, and trader attribution through routers remain limitations described in §19.4–§19.6.
6. **Later product slices:** historical/legacy backfill, candles/OHLCV, Pons scam/rug scoring, trending/momentum, AI queries, frontend, and a Solana/Pump.fun `ChainAdapter` remain deferred. Required pool-context columns and existing Solana CPI identity need an explicit mapping when generalizing consumers/persistence. Worker leases, in-flight shutdown draining, verified endpoint identity, and production provider capacity also remain future hardening work.

---

## 20. Phase 7B.5A — hardening the Pons ingestion pipeline for candles

Commit `9b2a892` implements and tests the hardening requested in [phase7b5a.txt](./phase7b5a.txt), on top of Phase 7B.4 (§19), which is complete and merged (`874166f`, fast-forwarded into `main` at `c7ec120`). This phase does not build the OHLCV/candle service itself — it closes the specific gaps §19.9 flagged as blockers for treating `ChainTrade` as an authoritative live feed: the discovery/trade race, detect-only reorg handling, an unbounded trade-polling address set, serial one-bad-token-aborts-everything enrichment, and no backend-owned health signal. Database remains the source of truth; WebSocket/events are still out of scope.

### 20.1 Discovery/trade coordination — the discovery-before-trades barrier

The race: the trade loop loaded its tracked-pool set and computed its own `toBlock` from the chain tip and its own checkpoint, entirely independent of discovery's progress. If the trade loop's timer fired before discovery had processed the range containing a brand-new pool's launch, the trade loop could commit a checkpoint past that pool's launch block. Since a pool can only ever appear in the tracked set after discovery persists it, the trades in the skipped range became permanently unreachable.

The fix is an explicit, deterministic barrier in `TradeListener.runOnce()` (`src/pons/tradeListener.ts`), not a sleep or a lock: on every tick, before computing its scan range, the trade loop reads the discovery checkpoint and computes

```
barrierHeight = min(discoveryCheckpoint.lastHeight, earliestPendingEnrichmentHeight - 1)
effectiveTip  = min(safeTip, barrierHeight)
```

and never advances past `effectiveTip`. `earliestPendingEnrichmentHeight` (the lowest `sourceHeight` among `CANONICAL`/`PENDING`-enrichment rows at or below the discovery checkpoint) closes a second, related gap: a pool whose `TokenLaunched` log decoded but whose `getLaunchedToken()` enrichment is still retrying (§20.4) has no `isToken0`, so the trade loop cannot yet decode its `Swap` direction — the barrier holds trade ingestion back from that pool's block instead of silently excluding just that one pool from an otherwise-advancing range. If no discovery checkpoint exists yet at all, `runOnce()` returns `WAITING_ON_DISCOVERY` rather than fresh-starting independently. This is correct by construction: discovery commits a launch's row and its own checkpoint atomically in one transaction (already true since Phase 7B.4), so any pool with `sourceHeight <= discoveryCheckpoint.lastHeight` is guaranteed already persisted by the time trade queries the tracked set for a range capped at that height — regardless of which loop's timer fires first, and safe under the existing single-worker-per-source assumption (§19.4/§19.9 — no cross-process lease is added or required by this fix).

`TradeTickResult` gained `WAITING_ON_DISCOVERY` (blocked by the barrier or by no discovery baseline yet) alongside the pre-existing `UP_TO_DATE`/`NO_POOLS_TRACKED`/`PROCESSED`/`UNAVAILABLE`. `NO_POOLS_TRACKED` is still checked first, before any barrier computation, unchanged from Phase 7B.4 (nothing to do if nothing has ever been discovered), and now also requires `enrichmentStatus: COMPLETE` so a fully-pending pool set doesn't look "trackable."

`src/pons/__tests__/coordinationBarrier.dbIntegration.test.ts` reproduces the historical race directly: seeds both checkpoints at height 49 with one already-tracked pool, presents a fake chain whose tip is already at 100 with a second pool's launch (block 60) and trade (block 70) both already "on-chain," then drives the trade loop's tick *before* discovery's — proving it returns `WAITING_ON_DISCOVERY` and does not advance past 49 — then drives discovery, then drives trade again and proves it resumes from exactly block 50 (no gap, no re-processing) and captures the new pool's trade. A second test proves a fresh listener instance reads the same barrier from Postgres after a simulated restart.

### 20.2 Reorg recovery — bounded rollback/replay

Phase 7B.4 could only detect a checkpoint-hash mismatch and halt. `src/pons/reorgRecovery.ts` (`attemptReorgRecovery`) is the real automatic response, invoked by both listeners the moment a mismatch is detected:

1. Walk a new per-chain `ChainBlockCheckpoint` history table (`chain`, `height`, `hash`; `@@id([chain, height])`) newest-to-oldest, comparing each recorded hash against a fresh `getBlockRef` read, until one matches — that height is the common canonical ancestor. Both listeners write into this same table on every committed tick (`checkpointStore.recordChainBlockCheckpoint`), pruned to `PONS_REORG_MAX_DEPTH_BLOCKS` (default 500) on every write so it never grows unbounded — this *is* the configured recovery window, and exhausting it without a match is exactly the fail-closed case.
2. If found: one transaction (a) marks every `DiscoveredToken`/`ChainTrade` row with `sourceHeight` above the ancestor `CANONICAL → ORPHANED` (rows are never deleted — `orphanedAt` is set, and orphaned launches have their `graduated`/`graduationPairedPrincipal`/`graduationThreshold`/`graduationCheckedAt` reset to unchecked, since a graduation read against a no-longer-canonical launch is unknown, not falsely "not graduated"); (b) rolls every `ChainIngestionCheckpoint` for the chain (both discovery and trades — reorg is chain-scoped, not source-scoped, so this stays consistent with the barrier in §20.1) back to `min(existing, ancestor)`; (c) prunes block-history entries above the ancestor. The next ordinary tick then replays forward from the ancestor; idempotent upserts (below) make that replay safe whether the canonical chain repeats the same facts or produces different ones.
3. If no match is found within the retained window: `REORG_UNRESOLVED`. The listener records `reorgUnresolvedAt`/`reorgUnresolvedReason` on its checkpoint (only if not already set, preserving the original detection time) and returns without touching any row — no partial/best-effort rollback, ever.

Discovery's and trade's upserts (`chain_tokenAddress` / `chain_sourceTxHash_sourceIndex`, unchanged unique keys) now also *revive* a matching `ORPHANED` row back to `CANONICAL` with the freshly observed provenance during replay, rather than leaving `update: {}` as a no-op — necessary because a reorg can relaunch the same token address or re-mine the same transaction, and a stale `ORPHANED` row must not linger as a false negative once its fact is canonical again.

`DiscoveryTickResult`/`TradeTickResult` replaced the old blanket `REORG_DETECTED` with `REORG_RECOVERED { ancestorHeight }` and `REORG_UNRESOLVED { reason }`. `src/pons/__tests__/reorgRecovery.dbIntegration.test.ts` covers: a shallow reorg (finds the ancestor a few history entries back, orphans the affected token/trade, rolls back both checkpoints, prunes history); a launch revived to `CANONICAL` on replay after being orphaned, with graduation state proven reset; no common ancestor within the window (fails closed, mutates nothing, `searchedDepth` reported); repeated detection after a successful recovery (idempotent — second call finds the same ancestor, orphans/rolls back nothing further); and a simulated restart immediately after recovery (a fresh listener instance resumes cleanly from the rolled-back checkpoint). `discoveryListener.dbIntegration.test.ts`'s original reorg test now exercises the genuinely-unresolvable case (only one, now-mismatched, history entry exists) and additionally asserts idempotent repeated detection.

**Proof against a genuinely reorging node (not Robinhood Chain itself):** `src/pons/__tests__/reorgRecovery.anvilFork.test.ts` drives the exact same production code — the real `PonsChainClient` (real viem HTTP JSON-RPC, no mocked transport), `DiscoveryListener`, and `reorgRecovery.ts` — against a real local Foundry `anvil` node, using `evm_snapshot`/`evm_revert` to make it genuinely fork: deploy a tiny mock contract (`fixtures/mockContracts.ts`) emitting the exact real Pons `TokenLaunched` topic0 this repo already verified on-chain, launch "token A," snapshot, let discovery persist it, revert the node (token A's block no longer exists on this node), launch a different "token B" at the same height range, and prove discovery detects the real hash mismatch, finds the real pre-fork ancestor, orphans token A, and replays to canonically discover token B — with a final assertion that a canonical-only query never returns the orphaned one. This is the standard EVM-tooling technique for testing reorg handling without needing a live chain to misbehave, and it is real infrastructure (a real Ethereum JSON-RPC node) — just not Robinhood Chain mainnet, which cannot safely be forced to reorg on demand (phase7b5a.txt §11). It runs in CI (`foundry-rs/foundry-toolchain`).

This test also **surfaced and fixed a real latent bug**: `PonsChainClient.getBlockNumber()` had no explicit `cacheTime`, so it inherited viem's default ~4s block-number cache — calling it twice within that window returned the same stale height even after new blocks were mined. Fixed by passing `cacheTime: 0` so every confirmation-lag/safe-tip calculation always sees the true current tip. This had not surfaced against a scripted `FakeChainReader` (which has no cache) or in production polling (where `PONS_POLL_INTERVAL_MS`'s 5s default usually exceeds the 4s cache window) — exactly the kind of gap a real-node test, not a mock, is positioned to catch.

**Not proven live against Robinhood Chain itself:** no real Robinhood Chain mainnet reorg was observed or manufactured — see §20.8. That remains categorically different from and cannot substitute for the anvil-fork proof above; phase7b5a.txt §2 draws that line deliberately and this document preserves it.

### 20.3 Pool-set scaling — chunked queries, not a working-set/aging model

`TradeListener` now issues `eth_getLogs` in address chunks of `PONS_TRADE_POOL_CHUNK_SIZE` (default 40), fetched with bounded concurrency `PONS_TRADE_QUERY_CONCURRENCY` (default 3) via a new shared `mapWithConcurrency`/`chunk` helper (`src/pons/concurrency.ts`). **No pool is ever aged out, and no working-set/coverage model was introduced** — every `CANONICAL`, enrichment-`COMPLETE` pool is queried on every tick, full stop. This was the deliberate choice over chain-wide `topic0` filtering (option A) or a windowed/backfill-on-demand active-pool model (option C): this phase had no measured Robinhood Chain-wide Uniswap V3 Swap volume or provider address-array/rate-limit numbers to justify either alternative with evidence, and phase7b5a.txt explicitly warns against both guessing that chain-wide scanning is affordable *and* against an aging model that would make historical-completeness claims false. Chunking is the only option of the three that adds no risk to completeness while still bounding the cost of any single RPC call as the tracked-pool count grows — the honest tradeoff is that total RPC call volume per tick still scales with pool count (`⌈pools / 40⌉` calls), which is exactly why this phase also adds the metrics below rather than asserting the tradeoff is fine forever.

`TradeTickResult`'s `PROCESSED` variant now reports `poolsQueried`, `rpcLogCalls` (chunk count), and `retryEvents` (chunks whose `ChainClientResult` reported `attempts > 1` — `ChainClientResult` gained an `attempts` field for exactly this). These, plus each tick's log line, are the evidence a future phase needs to decide whether/when to revisit chain-wide filtering: if `rpcLogCalls` or `retryEvents` climb in production, that is the measured evidence phase7b5a.txt asked for and this phase didn't yet have.

`src/pons/__tests__/tradePoolScaling.dbIntegration.test.ts` seeds 97 tracked pools (deliberately not a multiple of the chunk size), proves exactly `⌈97/40⌉ = 3` `getLogs` calls are made, that observed concurrency never exceeds `tradeQueryConcurrency` but does exceed 1 (genuinely concurrent, not serial), and — the completeness invariant that matters most — that all 97 pools' trades are recorded, none dropped.

### 20.4 Batch discovery enrichment — bounded concurrency, PENDING rows, never a fake default

`getLaunchedToken()` enrichment (supply/`isToken0`/`poolFee`) for a tick's newly-decoded `TokenLaunched` logs now fans out through `mapWithConcurrency` at `PONS_ENRICHMENT_CONCURRENCY` (default 5) instead of one call at a time, and — the more important fix — a single failed enrichment call no longer aborts the whole tick. `DiscoveredToken.supply`/`isToken0`/`poolFee` became nullable (additive migration below); a token whose enrichment fails is still persisted immediately (so its `TokenLaunched` log, which only appears once in the scanned range, is never lost) with `enrichmentStatus: PENDING`, `lastEnrichmentError` set to the redacted failure reason, and `enrichmentAttempts` incremented — never a fabricated `0`/`false`/default. Every discovery tick also retries up to `PONS_ENRICHMENT_RETRY_BATCH_SIZE` (default 25) existing `PENDING` rows, oldest-`sourceHeight`-first, with the same bounded concurrency, *before* scanning new logs — this runs even on a tick that finds nothing new to scan (it happens ahead of the `fromBlock > safeTip` early return), so a backlog of pending enrichments keeps draining even during a quiet period. The trade-listener barrier (§20.1) is what keeps a `PENDING` pool from having its future trades skipped over in the meantime.

`src/pons/__tests__/enrichmentBatching.dbIntegration.test.ts` proves: a 12-token launch burst enriches with observed peak concurrency `<=5` (and `>1`, proving it isn't accidentally serial) and persists all 12 as `COMPLETE`; a 5-token tick with 2 simulated enrichment failures persists all 5 (nothing discarded), the 2 failures as `PENDING` with `supply`/`isToken0`/`poolFee` left `null` and `lastEnrichmentError` set, and the discovery checkpoint still advances (a bad token never stalls the stream); and a later tick's retry pass resolves a since-fixed `PENDING` row to `COMPLETE` while leaving a still-failing one `PENDING` with `enrichmentAttempts: 2`.

### 20.5 Ingestion source-health projection

`src/pons/sourceHealth.ts` (`computeIngestionHealth`) is a pure read of persisted `ChainIngestionCheckpoint` metadata — never a live RPC call per computation, so checking health can never itself slow down an already-degraded feed. Both listeners now record, on every tick regardless of outcome (`checkpointStore.ts`'s `set`/`recordUpToDate`/`recordFailure`/`markReorgUnresolved`): `lastObservedChainHeight`, `lastPollAt`, `lastSuccessAt`, `lastError`/`lastErrorAt`, `lastReorgAt`, `reorgUnresolvedAt`/`reorgUnresolvedReason`. A source with no checkpoint row at all (never yet succeeded once) reports `UNAVAILABLE` by design — there is nothing to persist poll metadata against until a first successful tick creates the row.

Per-source classification, in priority order: `reorgUnresolvedAt` set → `REORG_RECOVERY`; no poll or no success within `PONS_HEALTH_STALE_MS` (default 120s) → `UNAVAILABLE`; a `lastError` newer than the last success within `PONS_HEALTH_ERROR_WINDOW_MS` (default 60s) → `DEGRADED`; blocks-behind (`lastObservedChainHeight - lastHeight`) over `PONS_HEALTH_LAGGING_BLOCKS` (default 50) → `LAGGING`; else `LIVE`. The overall status is the worst-of the discovery and trade sources.

Exposed at `GET /api/v1/tokens/robinhood/status` (`src/researchApi/routes/robinhoodTokens.ts`), registered ahead of the `:tokenAddress` route for the same reason this whole router is mounted ahead of the generic mint router (Express route-order precedence). Zod-defined (`RobinhoodStatusResponseSchema`/`SourceHealthDetailSchema`, `src/researchApi/contracts/robinhoodTokens.ts`) and registered in the shared OpenAPI generator. The route reuses the existing auth/rate-limit middleware and reads health thresholds via a new `loadPonsHealthThresholds()` (`src/pons/config.ts`) deliberately independent of `loadRobinhoodChainConfig()` — the read-only API process can serve this route without needing the RPC/contract settings only the worker process requires. The response never includes RPC credentials, raw provider URLs, stack traces, or internal database errors — only the redacted operational reason string a listener itself recorded (`chainClient.ts`'s `classifyError` already produced safe strings; nothing new here re-exposes a raw thrown error).

`src/pons/__tests__/sourceHealth.dbIntegration.test.ts` covers all five states plus the redaction property (serialized response contains no `http(s)://` or stack-trace-shaped text). `robinhoodTokens.dbIntegration.test.ts` adds a real-HTTP check of the same route and shape, plus a redaction check at the HTTP boundary. `openapi.test.ts` asserts the route is documented ahead of the generic path and its 200 response references `RobinhoodStatusResponse`.

### 20.6 Price semantics — unchanged

`priceQuote` remains exactly what §19.4/§19.6 documented: a truncated raw-amount execution ratio (`abs(quoteAmount)/abs(tokenAmount)` via `decimalDivide`), not a decimal-adjusted spot or USD price. Nothing in this phase touches `ponsAdapter.ts`'s price computation or adds a normalized-price helper — phase7b5a.txt §6 permitted one only "if required solely as a pure reusable primitive," and nothing here required it.

### 20.7 Logging and operational safety

`src/pons/logger.ts` adds a redacting Pino instance (`ponsLogger`/`ponsComponentLogger`) — the same already-installed `pino`, not a new framework, with its own small `REDACTED_PATHS` list (kept independent of `src/researchApi/lib/logger.ts` so `src/pons/**` has no dependency on `src/researchApi/**`, preserving the architecture boundary in §20.8). `ponsWorkerMain.ts` now uses it in place of prefixed `console.*` calls. All three listeners/pollers gained `waitForIdle()`: `stop()` still just clears the timer synchronously (unchanged signature), but the worker entrypoint's shutdown handler now `await`s each loop's in-flight tick (tracked via a `currentTick` promise) before calling `db.$disconnect()`, so a `SIGINT`/`SIGTERM` during an in-flight transaction no longer risks disconnecting Prisma mid-write (transactions were already atomic, so this was not a correctness gap — it removes a needless disconnect-during-commit race and the spurious errors/replay it could cause).

**Transaction timeout:** Prisma's default interactive-transaction timeout is 5s. Both listeners' commit transactions upsert one row per discovered token/trade sequentially, so duration scales with how many facts one tick found — normally trivial, but found to matter in practice: running the worker against real mainnet with an aggressive catch-up `PONS_MAX_BLOCK_RANGE_PER_POLL` (while wiring the OnlyPump frontend to live data) produced a discovery tick that found ~1,300 tokens and threw `Transaction already closed` partway through the commit. Both `$transaction()` calls now pass `{ timeout: 60_000 }`, which comfortably covers realistic burst sizes without masking a genuinely stuck transaction. Re-run after the fix: the same worker, same aggressive range, committed a ~1,300-token tick successfully.

### 20.8 Architecture boundaries

Unchanged: `src/discovery/**` stays chain-neutral, `src/pons/**` stays Robinhood/Pons-only, `src/researchApi/**` stays the only `/api/v1` surface. No execution/signing/wallet/trading/Telegram/Discord code was added anywhere in this phase. `src/pons/__tests__/executionBoundary.test.ts` is new — the same pattern as `src/forensics/__tests__/executionBoundary.test.ts` — and additionally asserts `reorgRecovery.ts`/`checkpointStore.ts` never call `.delete`/`.deleteMany` on `DiscoveredToken`, `ChainTrade`, or `ChainIngestionCheckpoint` (reconciliation only ever marks/updates, per phase7b5a.txt §2's "do not blindly delete checkpoints").

### 20.9 Database changes

One additive migration, `20260906192052_harden_pons_ingestion_reorg_health`:

| Change | Detail |
|---|---|
| `DiscoveredToken.supply`/`isToken0`/`poolFee` | `NOT NULL → NULL`-able (§20.4) |
| `DiscoveredToken`/`ChainTrade` add `canonicalStatus` (`ChainFactStatus`: `CANONICAL`\|`ORPHANED`, default `CANONICAL`) and `orphanedAt` | §20.2 |
| `DiscoveredToken` adds `enrichmentStatus` (`EnrichmentStatus`: `COMPLETE`\|`PENDING`, default `COMPLETE`), `enrichmentAttempts` (default `0`), `lastEnrichmentAttemptAt`, `lastEnrichmentError` | §20.4 |
| `ChainIngestionCheckpoint` adds `lastObservedChainHeight`, `lastPollAt`, `lastSuccessAt`, `lastError`, `lastErrorAt`, `lastReorgAt`, `reorgUnresolvedAt`, `reorgUnresolvedReason` | §20.5 |
| New table `ChainBlockCheckpoint` (`chain`, `height`, `hash`, `recordedAt`; `@@id([chain, height])`) | §20.2 |
| New indexes | `DiscoveredToken(chain, canonicalStatus, sourceHeight)`, `DiscoveredToken(chain, enrichmentStatus, sourceHeight)`, `ChainTrade(chain, canonicalStatus, sourceHeight)`, `ChainBlockCheckpoint(chain, height)` |

Applied and validated against a fresh, disposable local PostgreSQL 16 container (`prisma migrate deploy` on an empty database) — never the shared development database. Existing unique keys (`DiscoveredToken`'s `[chain, tokenAddress]`, `ChainTrade`'s `[chain, sourceTxHash, sourceIndex]`) are unchanged and remain the idempotency mechanism for both ordinary replay and post-reorg revival (§20.2).

### 20.10 Configuration

All new settings are optional with defaults (`src/pons/config.ts`); none change what was already required to start the worker.

| Setting | Default | Used by |
|---|---|---|
| `PONS_ENRICHMENT_CONCURRENCY` | `5` | §20.4 |
| `PONS_ENRICHMENT_RETRY_BATCH_SIZE` | `25` | §20.4 |
| `PONS_TRADE_POOL_CHUNK_SIZE` | `40` | §20.3 |
| `PONS_TRADE_QUERY_CONCURRENCY` | `3` | §20.3 |
| `PONS_REORG_MAX_DEPTH_BLOCKS` | `500` | §20.2 |
| `PONS_HEALTH_LAGGING_BLOCKS` | `50` | §20.5 |
| `PONS_HEALTH_STALE_MS` | `120000` | §20.5 |
| `PONS_HEALTH_ERROR_WINDOW_MS` | `60000` | §20.5 |

`.env.example` was also extended with the full Phase 7B.4 Pons block (never added at the time — §19.7 noted this gap) alongside these new settings, since this phase touched the same file anyway.

### 20.11 Tests

68 new/changed test cases across 13 files (all under `src/pons/__tests__/` and `src/researchApi/__tests__/`), on top of Phase 7B.4's 14: `concurrency.test.ts` (8, pure — `mapWithConcurrency`/`chunk`), `executionBoundary.test.ts` (8, new), `coordinationBarrier.dbIntegration.test.ts` (2), `reorgRecovery.dbIntegration.test.ts` (5), `reorgRecovery.anvilFork.test.ts` (1, real reorging anvil node — see §20.2), `enrichmentBatching.dbIntegration.test.ts` (3), `tradePoolScaling.dbIntegration.test.ts` (1), `sourceHealth.dbIntegration.test.ts` (7), `discoveryListener.dbIntegration.test.ts` (3, one rewritten for real recovery semantics), `tradeListener.dbIntegration.test.ts` (3, unchanged count, re-seeded for the new barrier), `robinhoodTokens.dbIntegration.test.ts` (8, was 4 — status route, redaction, orphan-exclusion), `openapi.test.ts` (+1). A new `src/pons/__tests__/testSupport.ts` centralizes the fake chain reader (now with per-address enrichment control, address filtering, and `attempts` reporting), real viem-ABI-encoded synthetic log builders (`makeTokenLaunchedLog`/`makeSwapLog` — not hand-typed hex, so burst/scaling tests aren't limited to the one real captured fixture), and concurrency-tracking `ChainReader` wrappers. `src/pons/__tests__/fixtures/mockContracts.ts` holds the compiled bytecode/ABI (Foundry, Solc 0.8.33, `--via-ir`) for two minimal mock contracts used only by `reorgRecovery.anvilFork.test.ts`.

CI (`.github/workflows/ci.yml`) previously never set any `*_RUN_DB_TESTS` flag, so every `*.dbIntegration.test.ts` file in the whole repo — Pons, Pump, forensics job service, wallet verification, this phase's new ones — silently skipped in every run despite CI's disposable Postgres being exactly the environment they need. Fixed by adding a second, serial (`--no-file-parallelism`) test step with all four flags set, run after the existing default `npx vitest run` (left untouched, so its behavior is unchanged) — this is a strict coverage increase, not a behavior change to what was already green. CI also now installs Foundry (`foundry-rs/foundry-toolchain`) and runs `reorgRecovery.anvilFork.test.ts` as its own step, so the real-reorg proof re-runs on every push, not just once locally.

### 20.12 LOCALLY PROVEN — recorded evidence and reproducible checks

| Evidence | What it establishes |
|---|---|
| `npx prisma migrate deploy` against a fresh disposable PostgreSQL 16 container (not the shared dev database) | The full migration chain, including this phase's, applies cleanly to an empty database. |
| `npx tsc --noEmit` | Clean. |
| `npx vitest run` (default flags, matching CI's existing step) | 69 passed / 11 skipped files, 728 passed / 39 skipped tests — up from Phase 7B.4's baseline of 67 passed / 6 skipped files, 711 passed / 17 skipped tests; nothing pre-existing broke. |
| `npx vitest run --no-file-parallelism` with `PONS_RUN_DB_TESTS`/`PUMP_RUN_DB_TESTS`/`FORENSICS_RUN_DB_TESTS`/`WALLET_RUN_DB_TESTS=true` (matching the new CI step) | 80 passed files, 767 passed tests, zero skipped — every opt-in DB-integration suite in the repo, not just this phase's. |
| `npm run build` | Clean. |
| §20.1–§20.5's dedicated dbIntegration suites | The coordination barrier, reorg recovery, enrichment batching, pool-chunking, and health-projection mechanics described above, each against real PostgreSQL with a fake (non-network) chain reader. |
| Real read-only Robinhood Chain mainnet run, `npx ts-node src/pons/scripts/liveVerification.ts` (unchanged script, still the Phase 7B.4 historical range `[9019252, 9069251]`), executed twice in immediate succession | First run: connected at live tip block 56,240,741; discovery found the same **9 tokens** and trade found the same **180 trades** Phase 7B.4's commit recorded for this exact range. Second run (tip advanced to 56,241,100, proving a live, non-cached connection): identical counts — 9 `DiscoveredToken` rows, 180 `ChainTrade` rows, no duplicates — proving idempotent upsert behavior against genuinely live chain data, not just the canned-chain dbIntegration tests. |
| `computeIngestionHealth()` invoked directly against the checkpoint rows the live run above produced | Correctly reported `LAGGING` with `blocksBehind: "47171849"` — real lag, not a canned number, since the one-shot script advances the checkpoint only to the historical range's end while the live tip is ~47M blocks further. |
| `reorgRecovery.anvilFork.test.ts` against a real local Foundry `anvil` node, run 3 times consecutively with identical results | A genuine `evm_snapshot`/`evm_revert` node-level fork is detected by the real `PonsChainClient`, the real pre-fork ancestor is found, the reorged-out launch is orphaned, and the canonical replacement is discovered on replay — using this repo's actual production code, not a scripted fake. Also surfaced and fixed a real bug: `PonsChainClient.getBlockNumber()` was returning a stale ~4s-cached height (viem's default `cacheTime`) even after new blocks were mined; fixed with an explicit `cacheTime: 0`. |

### 20.13 NOT PROVEN / deferred / implementation limits

1. **Live reorg recovery against Robinhood Chain mainnet specifically:** no real Robinhood Chain reorg was observed or manufactured, and none was forced (phase7b5a.txt §11 explicitly forbids forcing/simulating destructive behavior against mainnet). §20.2's rollback/replay, orphaning, graduation reset, and revival-on-replay *are* now proven against a genuinely reorging real EVM node (`reorgRecovery.anvilFork.test.ts`, via Foundry `anvil`'s `evm_snapshot`/`evm_revert`) using the real production `PonsChainClient`/`DiscoveryListener`/`reorgRecovery.ts` code path — this is real infrastructure, just not the specific chain this project talks to in production. What remains unproven is exclusively "this exact behavior against Robinhood Chain's own consensus forking," which cannot responsibly be tested any other way.
2. **Live crash-mid-write proof:** as in §19.9, no checked-in harness kills the real worker process mid-transaction against live infrastructure. The atomicity argument (one Prisma `$transaction` per tick) and the restart-resumes-cleanly dbIntegration tests are the evidence; an actual `kill -9` against a live-ticking worker is not.
3. **Live outage/rate-limit behavior:** `ChainClientResult.attempts` and the `retryEvents` metric are new and unit-provable, but no live rate-limited or intermittently-unreachable RPC endpoint was exercised end-to-end during this phase — `getLogsUnavailableOnce`/`enrichmentByAddress` failure injection in tests is a fake-chain simulation, not a live one.
4. **Pool-set scaling at real production pool counts/RPC limits:** chunking (§20.3) was chosen without measured Robinhood Chain-wide Swap volume or the RPC provider's actual address-array/log-range limits — there was no live traffic to measure. The `poolsQueried`/`rpcLogCalls`/`retryEvents` metrics this phase adds are exactly what would let a future phase make that decision with real numbers instead of a guess.
5. **Testnet:** unchanged from §19.9 item 1 — still no verified testnet Pons deployment available to this project.
6. **Everything §19.9 item 6 already deferred:** candles/OHLCV (explicitly out of scope for this phase — see handoff below), historical backfill, Pons scam/rug scoring, trending/momentum, AI queries, frontend, and the Solana/Pump.fun `ChainAdapter` remain untouched.

### 20.14 Handoff to Phase 7B.5B

`ChainTrade` is now safe to aggregate into OHLCV candles: trades can no longer be silently skipped by the discovery/trade race (§20.1), a detected reorg either cleanly reconciles orphaned rows and rolls back checkpoints or halts the ingestion stream rather than aggregating on top of stale data (§20.2), and `canonicalStatus: CANONICAL` is the exact, already-indexed filter a candle aggregator must apply to never fold an orphaned trade into a bar. Recommended scope for 7B.5B:

- Aggregate `ChainTrade` rows (filtered to `canonicalStatus: CANONICAL`) into fixed-interval OHLCV candles, keyed by `(chain, tokenAddress, interval, bucketStart)`.
- Decide and implement real decimal-adjusted/USD pricing as its own explicit, tested primitive (§20.6 kept `priceQuote` untouched on purpose) — this is the first phase where that decision is actually load-bearing.
- Handle a candle bucket that straddles a reorg's ancestor boundary: a bucket partially built from now-`ORPHANED` trades needs either full recomputation from `CANONICAL` rows or an explicit invalidation signal — this phase did not design that (candles didn't exist yet), and it is the one place §20.2's reconciliation model directly constrains 7B.5B's design.
- Expose candle read routes under `/api/v1` alongside (not replacing) the existing raw trade/detail routes, reusing this phase's `canonicalStatus` filtering convention.
- Surface candle-service-specific health (e.g., "aggregation lag" behind ingestion) as an extension of `sourceHealth.ts`'s pattern (§20.5), not a parallel mechanism.
- Revisit pool-set scaling (§20.3) once real `poolsQueried`/`rpcLogCalls` production numbers exist.

---

## 21. Phase 7B.5B — the first candle/OHLCV service

Implements [phase7b5b.txt](./phase7b5b.txt) on top of Phase 7B.5A (§20), which is complete and merged. This phase does not touch the frontend, does not fabricate historical USD prices, and does not weaken any Phase 7B.5A ingestion/reorg guarantee — it adds a new, read-derive-persist-only domain (`src/candles/**`) plus a thin Pons-specific adapter (`src/pons/candleFeed.ts`, `src/candles/decimalsResolver.ts`) that turns already-canonical `ChainTrade` rows into materialized OHLCV candles. Database remains the source of truth; the API still never calls Robinhood RPC to serve a request.

### 21.1 Target pipeline and where each piece lives

```
Robinhood Chain (real logs)
  → Pons ingestion (pons:worker, unchanged in this phase except the two additive changes in §21.2)
  → canonical ChainTrade (PostgreSQL)
  → src/pons/candleFeed.ts        (Pons-specific adapter boundary: verified decimals, optional USD rate)
  → src/candles/aggregate.ts      (pure, chain-neutral OHLCV aggregation)
  → src/candles/persistCandles.ts (idempotent MarketCandle upserts)
  → candles:worker (independent process, src/candles/scripts/candlesWorkerMain.ts)
  → PostgreSQL MarketCandle
  → GET /api/v1/tokens/robinhood/:tokenAddress/candles (src/researchApi/routes/robinhoodTokens.ts)
  → existing OnlyPump chart (Phase 7B.5C, not built in this phase)
```

`src/candles/**` is the chain-neutral core: `aggregate.ts`, `types.ts`, `resolutions.ts`, `finality.ts`, `usdPricing.ts` know nothing about Pons, EVM, `viem`, or Prisma models named `ChainTrade`/`DiscoveredToken` (proven by `src/candles/__tests__/executionBoundary.test.ts`). Everything Robinhood/Pons-specific — reading `ChainTrade`, resolving verified decimals, optionally attaching a USD rate — happens once, at the adapter boundary (`src/pons/candleFeed.ts`), exactly as phase7b5b.txt §4 asked. A future Solana/Pump.fun candle feed would implement the same `CandleTradeInput[]`-producing shape from Pump.fun's own normalized trades and hand it to the identical `aggregateTrades()`; nothing in `src/candles/**` would change.

### 21.2 Source-time semantics

`ChainTrade.sourceTimestamp` (additive, nullable `DateTime`) is the real source-chain block time — never DB insertion time or API observation time. `TradeListener.runOnce()` (`src/pons/tradeListener.ts`) resolves it for every trade in a tick: it collects the distinct `sourceHeight` values among that tick's decoded trades, calls `chainClient.getBlockRef(height)` **once per unique height** (deduplicated/cached in a local `Map` for the tick — never one redundant RPC read per trade, per phase7b5b.txt §1), and reuses the `toBlock` ref it was already fetching for the checkpoint commit rather than requesting it twice. If any needed block's timestamp can't be resolved, the whole tick fails closed (`UNAVAILABLE`, nothing committed) — the same discipline the existing `getBlockRef(toBlock)` failure path already used.

`RawBlockRef` (`src/pons/chainClient.ts`) gained a `timestamp: bigint` field (the block's own `timestamp`, Unix seconds) — additive to every existing `getBlockRef()` call site, including `reorgRecovery.ts`'s ancestor search, which is what lets §21.10 below capture a real ancestor timestamp with no second RPC round trip.

`ChainIngestionCheckpoint.lastHeightTimestamp` (additive, nullable) is the **trade** checkpoint's confirmed chain time only — discovery's checkpoint never sets it (`CheckpointStore.set()`'s new fourth parameter is only ever passed by `tradeListener.ts`). This is the one fact `src/candles/finality.ts` needs to know "ingestion has safely progressed beyond bucket X" (§21.9) without ever consulting wall-clock time.

**Backfill for pre-existing rows:** `npm run pons:backfill-timestamps` (`src/pons/scripts/backfillTradeTimestamps.ts`) resolves `sourceTimestamp` for any `ChainTrade` row that predates this phase (`sourceTimestamp: null`), in bounded batches (500 rows/batch, one `getBlockRef` per distinct height in the batch), never fabricating a value it can't resolve — a row it can't resolve is simply left `null` for a later run. `src/pons/candleFeed.ts` never reads a row with `sourceTimestamp: null` (excluded by its own query filter) — an unresolved row simply cannot contribute to a candle, exactly per phase7b5b.txt §1's "Do not fabricate timestamps for rows that cannot be resolved."

### 21.3 Source-order semantics

**Audited and proven, not assumed:** `ChainTrade.sourceIndex` is the EVM `logIndex` from the decoded `Swap` event (`ponsAdapter.ts`'s `raw.log.logIndex`, itself viem's own `log.logIndex`). The EVM assigns log indexes sequentially and uniquely across **every** log in a block — in the exact order transactions execute and emit logs — never scoped to one transaction and never reused; this is a standard, universally-relied-upon EVM property (the same one every block explorer and indexer uses to order events within a block). `sourceHeight` (the block number) breaks ties across blocks; `sourceIndex` breaks ties within one block; together `(sourceHeight, sourceIndex)` is therefore a genuine total order over any set of trades from this chain — no additional ordering column was needed.

`src/candles/aggregate.ts` establishes this order itself, once, via `Array#sort` on `(sourceHeight, sourceIndex)` — it never trusts input order, Prisma row order, insertion order, or `sourceTimestamp` ties (multiple trades in the same block share one block timestamp, so timestamp alone cannot order them). `src/candles/__tests__/aggregate.test.ts`'s *"orders multiple swaps in the same block by sourceIndex (EVM logIndex), never insertion order"* test proves this directly: two trades with the same `sourceHeight` are passed to `aggregateTrades()` in reverse-`sourceIndex` order, and the resulting candle's `open`/`close` still resolve correctly by `sourceIndex`, not array position. `src/candles/__tests__/candleAggregationService.dbIntegration.test.ts` reproduces the same proof against real PostgreSQL, seeding the higher-`sourceIndex` row first.

### 21.4 Normalized execution price

`src/discovery/normalizedPrice.ts` (chain-neutral, alongside `decimalDivide`) is the primitive phase7b5b.txt §2 asked for, kept entirely separate from `ChainTrade.priceQuote` (raw ratio, untouched — §20.6's promise held):

```
normalizeAmount(rawAmount, decimals)      = rawAmount / 10^decimals

computeNormalizedPrice(quoteAmountRaw, quoteDecimals, tokenAmountRaw, tokenDecimals)
    = (quoteAmountRaw / 10^quoteDecimals) / (tokenAmountRaw / 10^tokenDecimals)
    = (quoteAmountRaw * 10^tokenDecimals) / (tokenAmountRaw * 10^quoteDecimals)
```

computed as **one** decimal-safe BigInt division (`decimalDivide`, scale 18) — never two separately-rounded intermediate divisions. `tokenAmountRaw = 0` (the only zero-denominator case `ponsAdapter.decodeTrade` can ever produce — it already refuses to decode a zero-token-amount swap) safely returns `"0"` rather than throwing, matching `decimalDivide`'s existing zero-division protection.

`src/discovery/__tests__/normalizedPrice.test.ts` (14 tests) proves this against representative 6/9/18-decimal combinations (a 6-decimal quote against an 18-decimal token, a 9-decimal token against an 18-decimal quote, mixed 6/9), a round-trip through the new `parseDecimalToScaledBigInt`/`formatScaledBigInt` fixed-point helpers (`src/discovery/decimal.ts`), and — the Phase 7B.4 regression this phase was warned not to reintroduce — that very large/very small values format without scientific notation.

### 21.5 Token/quote decimal provenance

**Never assumed to be 18.** `src/pons/abi.ts` gained the standard ERC-20 `decimals()` view function fragment (universal EIP-20 interface, selector `0x313ce567` — no separate on-chain verification needed the way the Pons-specific fragments above it required, since every ERC-20 token on an EVM chain is expected to implement it). `src/candles/decimalsResolver.ts`'s `resolveTokenDecimals()` reads it for both the token and its quote asset via `readContract`, caches the result on `DiscoveredToken.tokenDecimals`/`quoteDecimals` (additive nullable `Int` columns), and treats a reverted/malformed response as **unresolved** — never a fabricated default. A token whose decimals can't be resolved contributes no candles until a later tick succeeds (fail closed, surfaced as a per-tick error in the candle worker's summary/health, never silently defaulted).

**Deliberate architectural choice — decimals resolution lives in the candle worker, not `discoveryListener.ts`.** Phase 7B.5A's launch-enrichment pipeline (`EnrichmentStatus`, bounded-concurrency batch enrichment, `PENDING`-row retry — §20.4) is already implemented and exhaustively tested end-to-end. Folding `decimals()` into that exact machinery would change what `EnrichmentStatus: COMPLETE` means and risk regressing a proven pipeline for a concern it was never designed around. Instead, `resolveTokenDecimals()` is its own small, independent, idempotent, DB-cached read step — the "Robinhood/Pons-specific enrichment... at the adapter boundary" phase7b5b.txt §4 asked for — run only by `candles:worker`, using its own read-only RPC client. `discoveryListener.ts` and `tradeListener.ts` are **untouched** by this decision (their own extensive dbIntegration test suites, §20.11, all remain green unmodified — see §21.19).

### 21.6 Chain-neutral candle domain

`src/candles/aggregate.ts`'s `aggregateTrades(trades, resolutions)` is a pure function: `CandleTradeInput[]` in, `Map<CandleResolutionId, CandleBucket[]>` out, no I/O, no Prisma, no `viem`. It:

1. Sorts once by `(sourceHeight, sourceIndex)` (§21.3) — the only ordering step, shared by every resolution.
2. For each resolution, buckets by the deterministic UTC boundary `bucketStart = floor(unixSeconds / intervalSeconds) * intervalSeconds` (`src/candles/resolutions.ts`) — no local timezone math anywhere.
3. Computes open (first trade), close (last trade), high/low (extrema), token/quote volume (sums of the already-normalized, always-positive amounts), USD volume (sum **only** if every trade in the bucket had a non-null USD amount — never partially estimated), trade count, and distinct-trader count, using the fixed-point BigInt helpers from §21.4 throughout (never a JS float).
4. **Emits a bucket only for an interval that had at least one trade** — "no-trade interval = no candle" (phase7b5b.txt §5), proven directly by `src/candles/__tests__/aggregate.test.ts` and by the dbIntegration suite seeding an ORPHANED-only bucket and asserting zero `MarketCandle` rows.

Honest chain/venue vocabulary, not the frontend's Solana-era terms: rows carry `chain`/`venue`/`tokenAddress`/`quoteAddress`, never `mint`, and `venue` is `"pons"`, never `"pump"`/`"pumpswap"`/`"mixed"` (phase7b5b.txt §4/§13). Phase 7B.5C is expected to adapt the frontend contract to this, not the other way around.

### 21.7 Supported resolutions and trader-count semantics

All seven existing chart resolutions: `1s 5s 15s 1m 5m 15m 1h` (`src/candles/resolutions.ts`'s `CANDLE_RESOLUTIONS`, matching only-pump-me's `candle.ts` verbatim). Stored via a Prisma enum (`S1|S5|S15|M1|M5|M15|H1` — not legal starting with a digit) and mapped losslessly to/from the string literals at every domain/API boundary (`resolutionIdToDb`/`resolutionDbToId`).

**`uniqueTraders` is `COUNT(DISTINCT ChainTrade.trader)` within the bucket — the observed swap recipient/router-facing address, not a verified ultimate economic trader** (phase7b5b.txt §6, unchanged limitation already documented for `ChainTrade.trader` itself in §19.4/§19.6). This phase does not strengthen that claim; the API response carries an explicit `uniqueTraderSemantics` string saying exactly this, and `Candle.trades`/`uniqueTraders` are otherwise the same field names/meaning the frontend contract already expects.

### 21.8 Schema and migrations

One additive migration, `20260907015813_add_candle_domain` (applied cleanly, in sequence after `20260906192052_harden_pons_ingestion_reorg_health`, against a fresh disposable PostgreSQL 16 container — never the shared dev database — see §21.19):

| Change | Detail |
|---|---|
| `ChainTrade.sourceTimestamp` | New nullable `DateTime` (§21.2) |
| `ChainIngestionCheckpoint.lastHeightTimestamp` | New nullable `DateTime`, set only by the trade checkpoint (§21.2) |
| `DiscoveredToken.tokenDecimals`/`quoteDecimals` | New nullable `Int` columns (§21.5) |
| New enums `CandleResolution` (`S1..H1`), `CandleStatus` (`PROVISIONAL`\|`FINAL`) | §21.7/§21.9 |
| New table `MarketCandle` | `(chain, tokenAddress, resolution, bucketStart)` unique + indexed identity; `open/high/low/close Decimal(60,18)` (normalized price); `volumeToken/volumeQuote Decimal(78,18)` (normalized, self-contained — never raw uint256, so a reader never needs to re-join `DiscoveredToken` decimals to interpret a row); `volumeUsd Decimal(38,8)?`; `tradeCount`/`uniqueTraders Int`; `status CandleStatus`; `firstSourceHeight`/`lastSourceHeight BigInt` (diagnostic, not identity); `revision Int` (bumped only when a row's values genuinely change — §21.13's realtime sequencing) |
| New table `CandleInvalidation` | `(chain, tokenAddress, invalidatedFromTimestamp, processedAt?)` — durable, append-only reorg-invalidation record (§21.10) |
| New table `CandleAggregationCheckpoint` | `(chain, tokenAddress)` primary key; `lastSourceHeight`/`lastSourceIndex` — per-token forward-progress marker, independent of the Pons trade checkpoint |
| New table `CandleWorkerRunState` | One row per chain — whole-tick operational summary (§21.14/§21.15) |

Existing `ChainTrade`/`DiscoveredToken`/`ChainIngestionCheckpoint` unique keys, indexes, and every Phase 7B.4/7B.5A column are unchanged. `MarketCandle`/`CandleInvalidation`/`CandleAggregationCheckpoint` are never deleted from by the candle domain's own reorg-recovery-adjacent code (only `deleteCandlesFrom` in `persistCandles.ts`, which removes **only its own derived candle rows**, never `ChainTrade`/`DiscoveredToken` — proven by `src/candles/__tests__/executionBoundary.test.ts`).

### 21.9 Aggregation algorithm and the recompute engine (forward progress, backfill, and reorg invalidation share one function)

**One recompute engine, not three.** `src/candles/recompute.ts`'s `recomputeCandlesFromTimestamp()` is the ONLY place candles are ever written from trades. It:

1. Aligns the requested `fromTimestamp` down to the coarsest resolution's own bucket boundary (1h) — so every finer-resolution bucket inside that hour is also cleanly covered by the same window, never split.
2. Deletes every existing `MarketCandle` row for that token at or after the aligned start, across **all** resolutions (`deleteCandlesFrom`) — the clean-slate half.
3. Loads canonical (`canonicalStatus: CANONICAL`, `sourceTimestamp` not null) trades in that window via `src/pons/candleFeed.ts` (bounded page size, reports `truncated` rather than silently dropping trades past the cap).
4. Calls the pure `aggregateTrades()` (§21.6) and persists via `persistCandleBuckets()` (idempotent upsert, revision bump only on a genuine value change — §21.13).

This single function serves three different callers with three different justifications for calling it, each in `src/candles/candleAggregationService.ts`:

- **Ordinary forward progress** (§21.11): a token with a `CandleAggregationCheckpoint` gets a small window, starting from the earliest genuinely-new canonical trade since the checkpoint — a cheap, steady-state no-op when nothing changed.
- **Historical backfill/rebuild** (phase7b5b.txt §11): a token with **no** checkpoint yet gets `fromTimestamp = epoch(0)` — the exact same function, naturally bounded/paginated across ticks by the same trade-page cap, restart-safe and idempotent for free. This is explicitly scoped to rebuilding from `ChainTrade` rows this project **already has** — it never fetches additional history from the chain (that remains the separate, still-deferred legacy-factory backfill project, phase7b5b.txt §11's "keep these concepts separate").
- **Reorg invalidation** (§21.10 below): the recompute window starts at the reorg's own ancestor timestamp.

Sharing one function is a deliberate simplification over three separately-argued code paths: "fully recompute the affected window from canonical trades" is the single invariant phase7b5b.txt §9 asked for, and it is now literally one function, not three implementations of the same idea that could drift apart.

### 21.10 Reorg-safe candle recomputation (mandatory, phase7b5b.txt §9)

**Never incremental arithmetic.** No code anywhere in `src/candles/**` subtracts an orphaned trade's contribution from an existing candle — every affected bucket is always fully rebuilt from `ChainTrade WHERE canonicalStatus = CANONICAL` via §21.9's recompute engine.

**Invalidation is written in the same transaction as the orphaning itself.** `src/pons/reorgRecovery.ts`'s `attemptReorgRecovery()` — the exact, unmodified-in-behavior Phase 7B.5A algorithm (§20.2) — gained one additive step inside its existing `$transaction`: immediately before orphaning `ChainTrade` rows above the ancestor height, it captures the distinct `tokenAddress` values about to lose canonical trades, then (after orphaning) writes one `CandleInvalidation` row per affected token with `invalidatedFromTimestamp = ` the real ancestor block's own timestamp (captured from the same `getBlockRef` call the ancestor search already made — §21.2's `RawBlockRef.timestamp` addition — no second RPC round trip). Using the ancestor's own timestamp as a conservative lower bound can cause one extra bucket to be recomputed unnecessarily; it can never miss one. A crash between orphaning trades and writing the invalidation record cannot happen — they commit atomically or not at all.

**Convergence.** The candle worker processes unprocessed `CandleInvalidation` rows **before** any forward progress on any token, every tick (`processInvalidations()` in `candleAggregationService.ts`), grouping multiple pending rows for the same token into one recompute call (`min(invalidatedFromTimestamp)`). After a successful recompute: if any canonical trade remained in the window, `CandleAggregationCheckpoint` is set to that trade's `(sourceHeight, sourceIndex)`; if the window is now genuinely empty (everything in it was orphaned and nothing has replayed back to canonical yet), the checkpoint is **deleted** rather than left pointing at now-orphaned history — the next forward tick then treats the token as a fresh full recompute, which is exactly what correctly picks up a later-revived trade regardless of its height (proven directly — see below). The `CandleInvalidation` rows are marked `processedAt` only after a successful recompute; a `DECIMALS_UNAVAILABLE` failure leaves them unprocessed for a later tick (durable, restart-safe — survives a worker crash between detection and recompute).

**Provisional/final interaction.** `determineCandleStatus()` (§21.11) checks `unresolvedReorg` as an independent, first-priority condition — an unresolved reorg on either the discovery or trade checkpoint (`reorgUnresolvedAt` set) forces every bucket to `PROVISIONAL`, and the cheap finality-promotion sweep (§21.11) skips entirely while unresolved, so **no bucket can become newly FINAL while a reorg is unresolved**, independent of how much confirmed time has otherwise passed.

**Tested against the real Phase 7B.5A reorg-recovery algorithm** (`src/candles/__tests__/reorgInvalidation.dbIntegration.test.ts`, real PostgreSQL, calling the actual unmodified `attemptReorgRecovery()`):

- a bucket with multiple trades where one becomes orphaned → the whole bucket is recomputed, excluding exactly the orphaned trade's contribution to open/high/low/close/volume;
- a reorg spanning two adjacent 1h buckets → both buckets are correctly recomputed (the coarsest-boundary-aligned window covers the whole affected range in one pass);
- a trade orphaned and later canonically revived on replay (the same `chain_sourceTxHash_sourceIndex` upsert reviving `canonicalStatus: CANONICAL`, exactly what `tradeListener.ts` does on replay) → the candle converges back to including it, via the "checkpoint deleted on empty window → next tick does a fresh full recompute" mechanism above;
- after convergence, every persisted candle across every resolution is checked and never reflects the orphaned-only outlier value.

### 21.11 Provisional vs. final — the exact invariant

```
status(bucket) = FINAL   iff   NOT unresolvedReorg
                            AND tradeCheckpoint.lastHeightTimestamp is known
                            AND tradeCheckpoint.lastHeightTimestamp >= bucketStart + resolutionSeconds
                 else PROVISIONAL
```

(`src/candles/finality.ts`'s `determineCandleStatus()`.) **Never** "wall clock moved past the bucket end" — the only evidence used is the Pons **trade** checkpoint's own confirmed chain time (`ChainIngestionCheckpoint.lastHeightTimestamp`, §21.2), which only ever advances after the trade listener commits a real, `PONS_CONFIRMATION_LAG_BLOCKS`-lagged block range — itself already a safe/confirmed-progress signal, not the live tip. If that evidence is missing entirely (trade listener has never yet ticked), the bucket stays `PROVISIONAL` indefinitely rather than defaulting to anything else.

**A bucket can become final without new trades for that specific token.** Finality is purely a function of `(bucketStart, resolution, checkpoint state)` — never of whether a given token saw new trades. `runCandleAggregationTick()` therefore runs a separate, cheap, bounded sweep every tick (`promoteFinalizedCandles()` — one `updateMany` per resolution, never per-row/per-token) that flips any eligible `PROVISIONAL` row to `FINAL` directly, independent of forward/invalidation processing. This does not bump `revision` (a pure status flip, not a value change) and is not published as a realtime event — a documented, deliberate simplification (§21.13/§21.20 discusses what this defers).

Tested directly and in isolation (`src/candles/__tests__/finality.test.ts`, pure unit tests: no checkpoint evidence → provisional; confirmed progress before/at/after the bucket end; unresolved reorg overrides everything; resolution width changes the threshold) and end-to-end (`candleAggregationService.dbIntegration.test.ts`'s *"provisional/final transition"* test: a bucket starts provisional with no checkpoint, becomes final once confirmed progress passes its end **on a later tick with no new trades for that token**, and reverts to provisional the moment an unresolved reorg is recorded even with confirmed progress far past the bucket).

### 21.12 Worker lifecycle

`npm run candles:worker` (`src/candles/scripts/candlesWorkerMain.ts`) — a separate process from `pons:worker` and `api`, matching the target pipeline in §21.1. Every tick: process pending invalidations (§21.10, bounded to `CANDLES_MAX_INVALIDATION_TOKENS_PER_TICK` distinct tokens), forward-process a bounded batch of tokens (`CANDLES_MAX_FORWARD_TOKENS_PER_TICK`), sweep finality promotions (§21.11), record a `CandleWorkerRunState` summary (§21.14), sleep `CANDLES_POLL_INTERVAL_MS`. Restart-safe and idempotent (every write path is upsert-or-full-recompute — proven directly by dedicated "restart idempotency"/"rebuild idempotency" tests, §21.19, and by a real worker-process restart against live mainnet data, §21.18). Never holds an unbounded in-memory trade history (`recompute.ts`'s `cap` bounds every trade page). Graceful `SIGINT`/`SIGTERM`: awaits the in-flight tick before disconnecting Prisma, same pattern as `ponsWorkerMain.ts`.

**Single-replica only, documented explicitly** (phase7b5b.txt §8 requires this be stated, not implied): like `pons:worker`, this process has no lease/partitioning mechanism. Two replicas would double-process (idempotent writes make this safe from a *correctness* standpoint, but wastes RPC calls and could interleave a token's recompute+checkpoint-advance non-atomically across processes) — do not run more than one instance per chain/database. This is explicitly deferred Kubernetes-readiness work, not built in this phase (phase7b5b.txt: "the process boundary merely needs to be Kubernetes-ready later").

Needs read-only Robinhood RPC access (the same `ROBINHOOD_RPC_HTTPS`/`PONS_*`/`WETH_QUOTE` env as `pons:worker`) — not to ingest facts (it never writes `DiscoveredToken`/`ChainTrade`), but because `decimalsResolver.ts` resolves each token's verified `decimals()` lazily (§21.5). The `/api/v1` process itself still never calls RPC to serve a candle request (§21.13) — only this worker does, and only for decimals.

### 21.13 API contract

`GET /api/v1/tokens/robinhood/:tokenAddress/candles` (`src/researchApi/routes/robinhoodTokens.ts`, registered on the same router as the existing token/trade/status routes; contracts in `src/researchApi/contracts/candles.ts`, registered in the shared OpenAPI generator). Reads `MarketCandle` only — never Robinhood RPC inline.

Query: `resolution` (required, one of the seven — §21.7), `from`/`to` (optional Unix seconds, `from > to` → `400 BAD_REQUEST`), `limit` (1–1000, default 500), `cursor` (opaque, the next Unix second to resume strictly at-or-after — ascending pagination).

Response, in full: `chain`, `venue`, `tokenAddress`, `quoteAddress`, `resolution`, `candles[]` (`startTime` Unix seconds, `open/high/low/close/volumeToken/volumeQuote` decimal-safe strings via Prisma `Decimal#toFixed()` — never scientific notation, `volumeUsd` string-or-null, `trades`, `uniqueTraders`, `status: "provisional"|"final"`, `updatedAt`), `nextCursor` (Unix seconds or `null`), `observedAt`, `freshness` (`live|lagging|degraded|reorg_recovery|unavailable` — the worse of candle-aggregation health §21.14 and upstream Pons ingestion health §20.5, never inferred client-side), `pricingBasis` (a human-readable description of what open/high/low/close actually are — §21.4), `uniqueTraderSemantics` (§21.7's exact caveat, in every response, not just documentation), and `usd: { available, provider, note }` (§21.5's honest USD-availability status).

Candles are returned **ascending by `bucketStart`** — the documented, deterministic order for chart rendering and cursor-forward backfill merging (phase7b5b.txt §12). Malformed address → `400 INVALID_ADDRESS` (reusing `validateRobinhoodAddress`); invalid resolution/time range → `400 BAD_REQUEST` (reusing the standard error envelope); undiscovered token → `404 NOT_FOUND`; a resolution/range with genuinely no candles → `200` with an empty `candles` array (not an error). All of this proven with real PostgreSQL + real Express + real `supertest` HTTP requests, no mocked DB layer (`src/researchApi/__tests__/robinhoodCandles.dbIntegration.test.ts`).

### 21.14 Realtime contract (implemented, within the existing Phase 7B.2 model)

Inspected Phase 7B.2's realtime architecture first (§17.3–§17.5) — this reuses the exact same `EventBus`/WebSocket infrastructure, not a second WebSocket server. A new event type, `token.candle.updated` (`RealtimeEventType.TOKEN_CANDLE_UPDATED`), published via a new `publishCandleEvent()` (`src/researchApi/realtime/eventPublisher.ts`) to a new channel convention `candle:{chain}:{tokenAddress}:{resolution}` (`candleChannel()`), carrying the exact fields phase7b5b.txt §14 required: stable event identity (the existing envelope's `version`/`eventId`), token address, chain, resolution, a **complete** latest candle snapshot (same shape as the REST `Candle`), a deterministic sequence (`MarketCandle.revision`), and an observed timestamp.

**Subscription model — a deliberately narrow, documented extension, not a rewrite.** Candle data is public market data, not user-owned, unlike the existing `subscribe`/`unsubscribe` (job-key, gated by `userOwnsJob`). Two new client message types, `subscribeCandles`/`unsubscribeCandles` (`{chain, tokenAddress, resolution}`, schema-validated against the same seven resolutions), were added to `websocketServer.ts`'s existing message handler with **no additional ownership check** — the read-access boundary is identical to the REST route's: the WebSocket connection itself is already authenticated (a ticket only issues from an authenticated `POST /api/v1/realtime/tickets` call), which is the same gate REST candle reads sit behind. This was assessed as a narrow, backward-compatible addition (new message types, new channel helper, no change to the existing job-subscription code path or its security model) rather than "a major unrelated rewrite of the Phase 7B.2 WebSocket authorization/subscription model" phase7b5b.txt §14 said to avoid — so it was implemented, not stopped short at a documented-only contract.

**Emitted sparingly, by design.** The candle worker publishes `token.candle.updated` **only** from steady-state forward progress (never from bulk backfill or reorg-driven recompute — those touch potentially many historical buckets and are not "live" news), and only for the single most-recently-changed bucket per resolution per tick — never every bucket that changed. The provisional→final sweep (§21.11) does not publish an event at all (a pure status flip, no revision bump).

**Realtime is an optimization only.** REST reconciliation (`GET .../candles`) is authoritative after any disconnect/reconnect — nothing in the realtime path is required for correctness, and `MarketCandle.revision` lets a client detect and discard an out-of-order/duplicate event on its own.

Not implemented: dedicated automated tests for the WebSocket candle-subscription wire protocol itself (the existing `websocketServer.test.ts`/realtime suites were not extended with a candle-specific subscribe/reconnect test in this phase — see §21.20). The event contract, channel convention, and publish-gating logic above are implemented and exercised indirectly by the candle worker's realtime call (`onCandleUpdated`) in `candlesWorkerMain.ts`, but a dedicated WS-level test is deferred.

### 21.15 Candle service health

`src/candles/health.ts` extends `sourceHealth.ts`'s pattern (§20.5) — same vocabulary (`LIVE|LAGGING|DEGRADED|REORG_RECOVERY|UNAVAILABLE`), same "pure read of already-persisted state, never a live probe per request" discipline — rather than a parallel mechanism. `CandleWorkerRunState` (one row per chain, §21.8) is written once per tick (`recordCandleWorkerRunState`/`recordCandleWorkerFailure`) with the whole-tick summary: `lastTickAt`/`lastSuccessAt`/`lastError`/`lastErrorAt`, `lastTokensProcessed`, `lastCandlesWritten`, `lastBucketsRecomputed`, `lastInvalidationsProcessed`, `lastTickDurationMs`.

`computeCandleHealth()` classifies, in priority order: no run-state row ever written → `UNAVAILABLE`; last tick older than `CANDLES_HEALTH_STALE_MS` → `UNAVAILABLE` (the loop itself appears stopped); any `CandleInvalidation` rows still unprocessed → `REORG_RECOVERY`; the most recent tick recorded a per-token error within `CANDLES_HEALTH_ERROR_WINDOW_MS` → `DEGRADED`; last successful tick older than `CANDLES_HEALTH_LAGGING_MS` → `LAGGING`; else `LIVE`. Exposed as the candle-aggregation half of the API response's `freshness` field (§21.13, combined with `sourceHealth.ts`'s ingestion health — the worse of the two wins), read via `loadCandleHealthThresholds()`, deliberately independent of `loadRobinhoodChainConfig()` so the read-only API process can serve `freshness` without needing the RPC/contract settings only the worker requires (same reasoning as `loadPonsHealthThresholds()`, §20.5).

**Documented simplification — `LAGGING` is not yet a precise measurement of aggregation lag behind Pons trade ingestion.** It is currently "the worker's last successful tick isn't recent," a deliberately simple proxy. A true version (comparing the latest processed trade's `sourceTimestamp` against the trade checkpoint's own confirmed height) is future work; the raw per-tick counters this projection already exposes are exactly the evidence a future phase would use to build it — the same "measure before building it" discipline §20.3 used for pool-set scaling.

### 21.16 Decimal serialization and performance

Every accounting value crosses every boundary (aggregation math, persistence, API JSON) as a decimal-safe string or a fixed-point `BigInt` — never a JS float for accounting (phase7b5b.txt §16). `src/discovery/decimal.ts`'s `parseDecimalToScaledBigInt`/`formatScaledBigInt` are the shared fixed-point primitives (scale 18 throughout the candle domain); the API route uses Prisma `Decimal#toFixed()`, the same discipline §19.6/§20's routes already established, never a bare `.toString()` (which the Phase 7B.4 regression proved can emit scientific notation). Tested directly: very small prices (`0.000000000000000001`), very large volumes (60-integer-digit values, the `Decimal(78,18)` column's actual ceiling), 18-decimal exact round-trips, and zero-division protection (`decimalDivide`'s existing `"0"`-on-zero-denominator behavior, reused unchanged) — `src/discovery/__tests__/normalizedPrice.test.ts`, and confirmed against real mainnet-derived values in §21.18.

Performance counters reported every tick (`CandleWorkerRunState`, §21.15): canonical trades processed, candles inserted/updated (`persistCandleBuckets`'s `inserted`/`updated`/`unchanged` split — an unchanged bucket is never rewritten, never bumps `revision`), buckets recomputed, invalidations processed, tick duration. Bounded DB page sizes throughout (`CANDLES_TRADE_PAGE_CAP` per recompute call, `CANDLES_MAX_FORWARD_TOKENS_PER_TICK`/`CANDLES_MAX_INVALIDATION_TOKENS_PER_TICK` per tick); `persistCandleBuckets` batches writes in chunks of 200 within their own transactions rather than one unbounded transaction over an arbitrary candle set — deliberately **not** repeating Phase 7B.5A's "sequentially upsert everything inside one large interactive transaction" pattern (phase7b5b.txt §17 explicitly warned against copying that merely because §20.7 raised its timeout). No N+1 read pattern: decimals are DB-cached per token (checked before any RPC call) and quote-decimals are additionally memoized in-process per tick (nearly every Pons token shares one `WETH_QUOTE`). `npm audit fix --force` was not run.

### 21.17 Tests

New test files (unit + real-PostgreSQL dbIntegration, following this repo's existing conventions exactly — `describe.skipIf(!RUN_DB_TESTS)`, opt-in via `CANDLES_RUN_DB_TESTS=true`):

| File | Coverage |
|---|---|
| `src/discovery/__tests__/normalizedPrice.test.ts` (14) | Normalized amount/price formula, 6/9/18-decimal combinations, fixed-point round-trip, no scientific notation, zero-division protection |
| `src/candles/__tests__/aggregate.test.ts` (12) | Every resolution, deterministic UTC bucket boundaries, open/high/low/close correctness regardless of input order, same-block `sourceIndex` ordering, volume sums, USD-volume all-or-nothing, distinct-trader counting, no-trade-interval = no candle, 18-decimal precision |
| `src/candles/__tests__/finality.test.ts` (6) | The exact provisional/final invariant in isolation, including the unresolved-reorg override |
| `src/candles/__tests__/health.test.ts` (8) | Every `CandleHealthStatus` classification, priority ordering (`REORG_RECOVERY` over `DEGRADED`), self-healing on a clean tick |
| `src/candles/__tests__/usdPricing.test.ts` (2) | `NullQuoteUsdRateProvider` always reports UNAVAILABLE, never a fabricated rate; no raw URL in its name |
| `src/candles/__tests__/executionBoundary.test.ts` (6) | No execution/signing/trading/wallet reachability; `aggregate.ts`/`types.ts`/`resolutions.ts` are Pons/EVM-free; never deletes `ChainTrade`/`DiscoveredToken`; worker only starts inside `main()` |
| `src/candles/__tests__/candleAggregationService.dbIntegration.test.ts` (9) | BUY/SELL + non-18-decimal normalization end-to-end against real Postgres, ORPHANED exclusion, no-candle-for-no-trades, the full provisional→final→reverts-under-unresolved-reorg transition, restart idempotency (fresh `PrismaClient`, zero new writes, `revision` unchanged), rebuild idempotency (checkpoint deleted, recompute converges to identical values), same-block ordering, decimals-unavailable fail-closed |
| `src/candles/__tests__/reorgInvalidation.dbIntegration.test.ts` (4) | The real, unmodified `attemptReorgRecovery()` → `CandleInvalidation` → recompute → convergence pipeline: mid-bucket orphaning, a reorg crossing a candle boundary, orphan-then-revival convergence, and a whole-history sweep proving no orphan-only value survives across every resolution |
| `src/researchApi/__tests__/robinhoodCandles.dbIntegration.test.ts` (8) | Real HTTP + real Postgres: valid history with decimal-safe serialization, invalid resolution, invalid time range, malformed address, 404 for an undiscovered token, empty legitimate result, deterministic cursor pagination, OpenAPI registration |

All existing Phase 7B.4/7B.5A tests remain green, unmodified in behavior (only `src/pons/__tests__/testSupport.ts`'s `FakeChainReader.getBlockRef` gained a deterministic fake `timestamp` field, required by `RawBlockRef`'s additive field — no existing assertion reads it).

**Exact counts, this phase's final run:**

- Default suite (`npx vitest run`): **90 test files (75 passed, 15 skipped), 837 tests (776 passed, 61 skipped)** — up from Phase 7B.5A's baseline of 69 passed/11 skipped files (80 total), 728 passed/39 skipped tests (767 total).
- Opt-in DB-integration suite (`npx vitest run --no-file-parallelism`, `PONS_RUN_DB_TESTS=PUMP_RUN_DB_TESTS=FORENSICS_RUN_DB_TESTS=WALLET_RUN_DB_TESTS=CANDLES_RUN_DB_TESTS=true`): **89 passed / 1 skipped files (90 total), 836 passed / 1 skipped tests (837 total)** — the one skip is `reorgRecovery.anvilFork.test.ts`, gated by its own separate flag.
- Real-anvil reorg proof (`PONS_RUN_ANVIL_REORG_TEST=true npx vitest run src/pons/__tests__/reorgRecovery.anvilFork.test.ts`): **1 passed** — proving `chainClient.ts`'s new `RawBlockRef.timestamp` field and `reorgRecovery.ts`'s new `CandleInvalidation`-writing step did not regress the real-node reorg proof.
- `npx tsc --noEmit`: clean.
- `npm run build`: clean.

### 21.18 Real infrastructure proof

Ran the existing Pons live-verification harness (`npx ts-node src/pons/scripts/liveVerification.ts`, unchanged script) against a fresh disposable PostgreSQL 16 container and real Robinhood Chain mainnet RPC — the same historical range Phase 7B.4/7B.5A already validated (`[9019252, 9069251]`). Result: identical to the prior phases' recorded counts — **9 real `DiscoveredToken` rows, 180 real `ChainTrade` rows**, and — new in this phase — **all 180 trades got a real, RPC-resolved `sourceTimestamp`** (e.g. block `9019252` → `2026-07-13T22:16:02.000Z`), proving §21.2's per-tick timestamp resolution against genuinely live infrastructure, not just the fake-chain dbIntegration tests.

Then ran `npm run candles:worker` (real process, real mainnet RPC for decimals resolution, real PostgreSQL) against that data:

- **First tick:** 9 tokens forward-processed, **552 real candles written** across all seven resolutions (`S1: 152, S5: 136, S15: 116, M1: 72, M5: 37, M15: 24, H1: 15`), decimals genuinely resolved via real `decimals()` calls against Robinhood Chain mainnet (both the sampled token and `WETH_QUOTE` returned `18`).
- **Every subsequent tick (7 more, over 30s):** `0 token(s) forward-processed, 0 candle(s) written` — steady state, no duplicate volume, no duplicate rows.
- **Full process restart** (fresh `PrismaClient`, fresh RPC connection, `SIGTERM` after the first run, new process started): first tick after restart reported `0 token(s) forward-processed, 0 candle(s) written` — resumed cleanly from persisted `CandleAggregationCheckpoint` rows, and the total `MarketCandle` row count was confirmed unchanged (552 before and after) — restart convergence proven against real infrastructure, not a scripted fake.
- **Real HTTP response:** started the real Express app (`createApiServer`) against the same live-verified database and issued a real HTTP `GET` to `/api/v1/tokens/robinhood/0xbf71e7594725d0b537e151a9de8158b24a44fad3/candles` at `1h`, `5m`, and `1m` resolutions — all returned correctly-shaped, decimal-safe (non-exponential) JSON, one `FINAL` and one `PROVISIONAL` bucket at `1h` (provisional/final correctly derived from the one-shot verification run's own checkpoint state — see the honesty note below), and consistent trade counts across resolutions (the `1h` bucket's constituent `5m`/`1m` buckets' `trades` sum to the same total).
- **Manual cross-check of a sample candle against its underlying canonical trades:** the `1m` candle at `startTime=1783981380` (3 trades) was independently recomputed by hand from the raw `ChainTrade` rows (`tokenAmount`/`quoteAmount`, both 18 decimals, verified via real `decimals()` reads) using the exact formula in §21.4 — `open`, `close`, `high`, `low`, `volumeToken`, and `volumeQuote` all matched the API's reported values exactly, digit for digit (`open: 0.000000001396464423`, `volumeToken: 33124569.974242984704180741`, etc.).

**Honesty notes, not overclaimed:**

- This is a **one-shot historical verification run**, not a continuously-polling production deployment — the API response's overall `freshness` correctly reported `unavailable` (Pons ingestion health, §20.5, correctly considers a one-shot checkpoint stale relative to wall-clock `PONS_HEALTH_STALE_MS`), which is honest, expected behavior for this verification methodology, not a defect.
- **USD pricing was not exercised** — `usd.available: false` throughout, exactly as designed (§21.5's `NullQuoteUsdRateProvider`); no historical-rate source was invoked because none exists in this environment.
- **No real Robinhood Chain reorg was observed or forced** during this run (mainnet reorgs cannot safely be manufactured — same rule as §20.8/§20.13). §21.10's reorg-invalidation pipeline is proven against the real, unmodified `reorgRecovery.ts` algorithm with real PostgreSQL (§21.9's dbIntegration suite) and, transitively, against the real-anvil reorg proof (§21.17) that the same `getBlockRef`/`reorgRecovery.ts` code path this phase extended still passes — but "a real Robinhood Chain reorg specifically recomputing real mainnet candles" was not and could not responsibly be observed.
- No real WebSocket client exercised the `token.candle.updated` event against this live data in this verification run (§21.14/§21.20) — the realtime contract's shape and publish-gating logic were verified by direct function-level testing and code inspection, not a live subscriber.

### 21.19 LOCALLY PROVEN — recorded evidence and reproducible checks

| Evidence | What it establishes |
|---|---|
| `npx prisma migrate deploy` against a fresh disposable PostgreSQL 16 container (twice, on two separate containers) | The full migration chain, including `20260907015813_add_candle_domain`, applies cleanly to an empty database |
| `npx prisma validate` / `npx prisma generate` | Schema is valid; client generates cleanly |
| `npx tsc --noEmit` | Clean |
| `npx vitest run` | 75 passed / 15 skipped files (90), 776 passed / 61 skipped tests (837) |
| `npx vitest run --no-file-parallelism` with all five `*_RUN_DB_TESTS` flags | 89 passed / 1 skipped files (90), 836 passed / 1 skipped tests (837) — every opt-in DB-integration suite in the whole repo, not just this phase's |
| `PONS_RUN_ANVIL_REORG_TEST=true npx vitest run src/pons/__tests__/reorgRecovery.anvilFork.test.ts` | The real-node reorg proof still passes unmodified against this phase's `chainClient.ts`/`reorgRecovery.ts` changes |
| `npm run build` | Clean |
| §21.9/§21.10's dedicated dbIntegration suites | Forward aggregation, backfill-via-recompute, and reorg invalidation/recompute mechanics, each against real PostgreSQL |
| §21.18's real mainnet run (`liveVerification.ts` + `candles:worker` + real HTTP) | Real Robinhood logs → canonical `ChainTrade` (with real resolved `sourceTimestamp`) → candle worker (with real resolved `decimals()`) → 552 persisted real candles → real `/api/v1/.../candles` HTTP responses across 3 resolutions → idempotent repeat ticks (0 duplicate writes) → clean process restart convergence (552 candles, unchanged) → one sample candle manually verified digit-for-digit against its underlying trades |

### 21.20 NOT PROVEN / deferred / implementation limits

1. **USD pricing has no real historical source.** `NullQuoteUsdRateProvider` is the only implementation; every `volumeUsd`/`usd.available` in this phase is honestly `null`/`false`. The interface (`QuoteUsdRateProvider`) is ready for a real implementation (e.g. a time-aligned Chainlink round query, or a paid historical-price API with the provenance this codebase's external-protocol rule would require) — that production source decision is unmade, deliberately, per phase7b5b.txt §3's explicit instruction not to invent one.
2. **`LAGGING` candle health is a simplified proxy** ("worker hasn't ticked recently"), not yet a precise measurement of aggregation lag behind Pons trade ingestion specifically — see §21.15's documented-simplification note.
3. **No dedicated WebSocket-level test for `subscribeCandles`/`token.candle.updated`.** The event contract and publish-gating logic (§21.14) are implemented and exercised via the candle worker's `onCandleUpdated` call path, but a `websocketServer.test.ts`-style test subscribing a real WS client, asserting reconnect-relies-on-REST, and checking no cross-user/security regression was not added in this phase.
4. **No real Robinhood Chain mainnet reorg was observed or forced** — §21.10's reorg-invalidation pipeline is proven against the real Phase 7B.5A `reorgRecovery.ts` algorithm (real PostgreSQL) and the real-anvil-node proof (§21.17), not against Robinhood Chain's own consensus forking, which cannot responsibly be tested any other way (same rule as §20.8/§20.13).
5. **Single-worker-per-database only** (§21.12) — no lease/partitioning mechanism; running two `candles:worker` replicas against the same database is not supported, only "not incorrect" (idempotent writes) but wasteful and not interleaving-safe for checkpoint advancement.
6. **Live crash-mid-tick proof.** As with `pons:worker` (§20.13 item 2), no checked-in harness `kill -9`s a live-ticking `candles:worker` process; the atomicity argument (`persistCandleBuckets`'s chunked transactions, `recomputeCandlesFromTimestamp`'s delete-then-reinsert-in-order) and the dbIntegration restart-idempotency tests are the evidence, not an actual process kill.
7. **Production-scale token-count/RPC-limit numbers.** `CANDLES_MAX_FORWARD_TOKENS_PER_TICK`/`CANDLES_TRADE_PAGE_CAP` defaults were chosen without measured production trade volume, the same "no guessing, measure first" caveat §20.3 already applies to Pons trade-pool scaling — the per-tick counters this phase adds (§21.15/§21.16) are what a future phase would use to tune them with real numbers.
8. **Testnet.** Unchanged from §19.9/§20.13 — no verified testnet Pons deployment is available to this project, so no testnet-specific candle proof exists either.
9. **Legacy-factory / pre-`PONS_FACTORY`-activation historical backfill** remains explicitly out of scope (phase7b5b.txt §11's "keep these concepts separate," reaffirmed here) — §21.9's backfill only ever rebuilds from `ChainTrade` rows this project already has, never fetches additional history from the chain.

### 21.21 Handoff to Phase 7B.5C (frontend)

Recommended scope, in the exact order the backend now supports it:

- Replace `adapters/fixtureCandleGateway.ts` with a real `CandleDataGateway` implementation calling `GET /api/v1/tokens/robinhood/:tokenAddress/candles` (§21.13) — the response shape already matches `CandleHistoryResponse` closely (`candles[]`, `nextCursor`, `observedAt`, a `freshness`-like field), but is **chain/venue-explicit** (`chain`, `venue`, `tokenAddress`, `quoteAddress`) rather than using `mint`/`source: pump|pumpswap|mixed` — the frontend adapter is the layer that should map this onto (or extend) its existing `Candle`/`CandleHistoryResponse` types, not the other way around (phase7b5b.txt §13's instruction, honored by not forcing Solana vocabulary into this backend).
- Wire `subscribe(mint, resolution, ...)` to the new `subscribeCandles`/`token.candle.updated` WebSocket contract (§21.14) for a Robinhood-chart context, keeping the existing REST-reconciliation-on-reconnect behavior the frontend contract already documents (`CandleDataGateway`'s own docs already say this — no frontend behavior change needed there, only a new gateway implementation).
- The frontend's `SolUsdRatePoint`/`getSolUsdHistory` concept has no Robinhood/WETH equivalent yet (§21.20 item 1) — the chart should render quote-denominated (WETH) prices only for Robinhood tokens until a real historical USD source exists; `usd.available: false` in every response today is the signal to gate any USD toggle off entirely, not estimate one.
- `uniqueTraders` must be labeled/tooltipped with the exact caveat the API already returns in `uniqueTraderSemantics` (§21.7) — "observed swap recipients," not verified unique users — if the frontend surfaces this number at all for Robinhood tokens.
- `status: "provisional"|"final"` should drive the same visual treatment (if any) the frontend already has planned for Pump.fun candles — the semantics now match exactly (§21.11), just derived from Robinhood-specific ingestion checkpoints instead of Solana slots.
- Do not build this against a fixture — real historical data for the 9 real tokens discovered in §21.18's live run is available in any environment that runs `liveVerification.ts` + `candles:worker` against the same historical range, for real integration testing.

---

## 22. Phase 7F.2 — verified callouts, PnL sharing, and three startup bugs

**Branch:** `feature/phase-7f2-callouts-pnl-sharing`
**Scope:** make the PnL card a first-class, single-sourced artifact; expose the callouts it produces over `/api/v1`; and fix three defects in `npm run dev` startup that this work surfaced.

### 22.1 Why this phase exists

PnL sharing was already the most externally visible thing this backend does — the tracker renders a card and posts it to Discord/Telegram whenever a call crosses +50%. But it existed only as a side effect of the tracker loop: the renderer was duplicated, the results were never queryable, and the OnlyPump UI rendered a `ComingSoonPanel` pointing at this repo. This phase closes that loop.

### 22.2 The three startup bugs (fix these before anything else)

All three were live in `npm run dev`. They are listed in the order they must be understood, because each one masked the next.

1. **The Telegram bot token was printed to stdout in plaintext.** `src/telegram/telegramBot.ts` logged `console.log(telegramToken)` between two separator lines on every boot, so the token landed in every log file, terminal scrollback and CI artifact that ever captured a startup. Now logs `bot token loaded | MISSING`. **Any token that booted this code before this commit should be treated as disclosed and rotated via BotFather.**

2. **Every periodic check was registered twice.** `startPeriodicChecks(client)` and `scheduleDailyTopTokensReport(client, telegramBot)` were called once at module scope in `src/index.ts` *and* again inside `main()`. Two `setInterval` chains ran concurrently, so **every PnL card was rendered and posted to Discord twice** — visible in the startup log as `🔄 Started periodic checks` appearing twice one second apart. The module-scope pair is removed; `main()` remains the single owner.

3. **`main()` hung forever on a second Discord login.** `src/discord/discord.ts` calls `client.login()` at module scope (bottom of file). `main()` then called `await client.login(...)` again on the same client, which never resolves — so everything after it in `main()` was silently skipped. This was invisible while bug 2 existed, because the module-scope `startPeriodicChecks` call kept PnL checks alive. Removing bug 2 exposed it: periodic checks stopped starting at all. `main()` now waits for readiness (`client.isReady()`, else the `ready` event) with a 30s timeout, and never re-logs-in.

A fourth, related fragility was fixed at the same time: `this.bot.launch()` in `telegramBot.ts` had **no `.catch()`**. Telegraf's `launch()` rejects on any polling failure, so a `409 Conflict: terminated by other getUpdates request` — which happens whenever a second instance of the same bot token polls, e.g. a laptop running `npm run dev` against the production token — became an unhandled rejection that **killed the whole detection backend**, not just Telegram. It now logs and degrades: Discord and detection continue.

> **Operational note:** the 409 above is a real, reproducible consequence of running this repo locally with the production `TELEGRAM_BOT_TOKEN`. Two instances cannot poll one bot. Use a separate test bot locally, or leave Telegram unset.

### 22.3 `src/services/pnlImage.ts` — one renderer, not two

`createPnLImage()` existed as two copies: `src/pnl-check.ts` (the standalone `yarn pnl` script) and `src/services/tokenTrackingService.ts` (the live tracker). They were byte-identical across 136 lines except for one extracted variable, meaning every visual change had to be made twice and could silently drift between what `yarn pnl` previewed and what the tracker actually posted.

Both now import the single `src/services/pnlImage.ts`, which uses the already-canonical `getSolPrice()` from `src/utils/tokenUtils.ts`. The card is unchanged: 1200x675, the OG-image aspect ratio, so it previews correctly when a shared link is unfurled.

> **Known duplication left alone:** `getSolPrice()` still exists as **eight** near-identical copies (`pnl-check.ts`, `simulation.ts`, `pumpfun-sniper.ts`, `tokenTrackingService.ts`, `discord/discord-pumpfun.ts`, `api/index.ts`, `api/standalone.ts`, plus the canonical `utils/tokenUtils.ts`). Only the two PnL call sites were migrated here, deliberately — collapsing the other six touches unrelated trading paths and belongs in its own change with its own tests.

### 22.4 `GET /api/v1/callouts` — the verifiable record

`src/researchApi/routes/callouts.ts`, registered at `/api/v1/callouts`, contract in `src/researchApi/contracts/callouts.ts`. Two routes:

| Route | Returns |
|-------|---------|
| `GET /api/v1/callouts?limit=` | Verified callouts, `pnlPercentage` desc then `alertTimestamp` desc. Default 25, max 100. |
| `GET /api/v1/callouts/{mint}` | Callout history for one token; 404 when it has none. |

The invariant that makes these *verifiable*: **a row only appears here after `tokenTrackingService` has checked it against live market data.** The route filters on `checked: true` AND `pnlPercentage >= CALLOUT_MIN_PNL_PERCENTAGE` (50 — the same bar at which the tracker actually shares a card). It performs pure Prisma reads: it never writes, never re-prices, and never computes a PnL of its own. An unchecked alert with a spectacular notional gain is **not** a callout and is excluded.

`multiple` (`currentMarketCap / initialMarketCap`) is returned alongside the percentage because that is how traders read these. It returns `null` rather than `Infinity`/`NaN` when the initial cap is zero or the current cap is missing — the frontend renders that as an em dash, never as `$0`.

The OpenAPI document is regenerated (`npm run openapi:generate`) and now carries **18 paths**, up from 16.

### 22.5 Verification — real data, not fixtures

- `src/services/__tests__/pnlImage.test.ts` (10 tests) rasterises **real PNGs** through node-canvas and asserts the PNG magic bytes and IHDR dimensions, covering negative PnL, 0%, 100,000%, total loss, and long/emoji token symbols. Stress: 25 sequential renders (heap growth < 150MB, slowest < 5s) and 10 concurrent renders asserting the outputs actually differ. Measured: 25 cards in ~2.0s, 10 concurrent in ~750ms.
- `src/researchApi/__tests__/callouts.integration.test.ts` (11 tests) runs against the **real Postgres** named by `DATABASE_URL` and seeds rows from **live DexScreener market data** for real Solana mints (WIF, JUP, POPCAT) — not hand-written fixtures — then drives the real Express app over HTTP. It asserts ordering, the 100-row cap, `limit` validation (400 on `0`/`-5`/`abc`/`1.5`), exclusion of flat and unverified calls, 40 concurrent reads inside budget, and that a burst past the configured limit sheds load with `429` and **never** a `500`.
- One honest caveat: `getSolPrice()`'s live test tolerates CoinGecko's documented `170` fallback, and on a rate-limited run (`429`) that fallback is what gets exercised. A green run proves the fallback is sound, not that a live quote was fetched.

Full backend suite after this phase: **529 passed, 36 skipped, 0 failed** across 54 files.

### 22.6 Known gaps

1. **No PnL card is served over HTTP.** The callouts API returns the numbers; the rendered image still only reaches Discord/Telegram. A `GET /api/v1/callouts/{mint}/card.png` returning the shared renderer's output is the obvious next step and would let the frontend embed the same artifact rather than re-implementing the design in DOM.
2. **`initialSolInvestment` is hardcoded to 1.0 SOL** in `tokenTrackingService`. Every card claims a 1 SOL entry. That is a marketing simplification, not a measured position, and should be labeled as such or driven by real position size.
3. ~~**`checkTokenPriceHistory` can simulate.** When a token has no `currentMarketCap`, it falls back to `initialMarketCap * 7.5` — a fabricated 650% gain.~~ **Fixed in Phase 7D.3 (`07bb9d4`):** missing market data now returns no market cap, which the caller treats as "skip"; 9 regression tests; zero persisted `TokenAlert` rows were affected.
4. **No pagination cursor.** `limit` caps at 100 with no cursor, so a backlog beyond 100 verified calls is not fully reachable. Fine today; not fine at scale.

---

## 23. Phase 7D — Pons V2 on Uniswap V4

**Merged:** PR #16 (`2945b08`). Full write-up, including the separate launchpad contracts project: [PHASE_7D_ROBINHOOD_V2_AND_LAUNCHPAD.md](./PHASE_7D_ROBINHOOD_V2_AND_LAUNCHPAD.md).

- **Why:** the §19 pipeline tracked only Pons **V1** (Uniswap V3, graduation polled). Pons **V2** launches onto a bonding curve and graduates onto **Uniswap V4**. The factory is `PonsV2LaunchFactory` `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` and the pool manager is the V4 singleton `0x8366a39CC670B4001A1121B8F6A443A643e40951`; both were verified on Blockscout.
- **Code:**
  - `src/pons/abiV2.ts`: verified factory and PoolManager ABIs.
  - `ponsV2Adapter.ts`: pure decoders for discovery, graduation, launch metadata from the `launchToken()` calldata, `Initialize` → PoolId, and V4 `Swap`.
  - `discoveryV2Listener.ts`: discovery **and** graduation, both real events.
  - `tradeV2Listener.ts`: V4 swaps filtered by PoolId.
  - `blockscoutTrace.ts`: best-effort fallback for launches routed through a bundler.
- **Schema:** `DiscoveredToken` gains curve address, name/symbol/logo/description/socials, rich-metadata status, V2 graduation fields and `poolId`; `ChainTrade` gains `poolId`. `reorgRecovery.ts` also resets V2 graduation fields keyed on graduation height.
- **Fixed along the way:** every polling loop used to wait a full interval even with known backlog. Loops now wait only once caught up.

## 24. Phases 7D.3 and 7D.3.1 — operating the pipeline honestly

**Merged:** PR #18 (7D.3) and PR #19 (7D.3.1).

### 24.1 Runtime and contract hygiene (7D.3)

- **Supervision:** `scripts/dev-stack.sh` supervises `api`, `pons` and `candles` as separate processes (see [RUNBOOK.md](./RUNBOOK.md)).
  - PID files are cross-checked against `/proc/<pid>/cmdline` and `cwd`, and the process that owns a service's port is authoritative.
  - `start` refuses to run on top of untracked processes.
  - Shutdown is SIGTERM with bounded escalation.
  - `bot` (`src/index.ts`) is opt-in only.
- **Restart safety** was verified live: checkpoints resumed with zero duplicate tokens.
- **Contract:** `openapi.json` is committed, and `scripts/check-openapi-drift.mjs` runs in CI before tests. The frontend pins this file (`only-pump-me/openapi/README.md`).
- **No fabricated PnL:** the `initialMarketCap * 7.5` fallback is removed (§22.6).

### 24.2 V4 pool evidence (7D.3)

- **Read path:** `src/pons/v4PoolState.ts` and `v4PoolEvidenceService.ts` provide a read-only, integer-only path.
  - PoolKey/PoolId follow v4-core.
  - StateLibrary slots (`POOLS_SLOT = 6`, `LIQUIDITY_OFFSET = 3`) are read through `extsload`.
  - Fixtures are real `extsload` words captured at block 61351410.
- **Endpoint:** `GET /api/v1/tokens/robinhood/:tokenAddress/pool` is kept separate from the DB-only token route so an RPC outage degrades one panel, not the page.
  - It always returns 200 with `AVAILABLE` or `UNAVAILABLE` plus a reason code.
  - No USD is ever produced.
  - **Deprecated in 7D.3.2** in favour of `market-evidence` (§25.6).
- **Correction:** the "2% creator tax" and "no V4Quoter deployed" conclusions in `docs/phase-7d3-pool-evidence-research.md` were wrong. See §25.1.

### 24.3 RPC resilience (7D.3.1)

- **Credential leak remediation.** A real Alchemy key reached a public test fixture and pre-redaction logs.
  - Fixtures now use synthetic credentials.
  - Logs were sanitized.
  - Public error messages are now stable codes plus our own sentence; raw provider detail (URL, calldata) stays server-side.
  - **Rotation of the leaked key is still the operator's job.**
- **Failover:** `src/pons/rpcEndpoints.ts` and `failoverChainClient.ts` implement it.
  - Order: `ROBINHOOD_RPC_HTTPS` → `…HTTPS2` → `…HTTPS3` → `DEAFULT_RPC_HTTPS`, and the same for WSS. Empty entries are skipped.
  - A quota-exhausted endpoint cools down for 30 minutes.
  - A request fault such as `-32601` does **not** fail over, because the next provider would say the same.
  - `ChainCaller.call` returns `UNSUPPORTED_CAPABILITY` to move to the next endpoint without a cooldown (used for state-override `eth_call`).
  - One wall-clock deadline covers all retries.
  - `metricsSnapshot()` exposes per-endpoint health by label/host only.
- **Standard RPC vs provider-specific methods:** failover applies to standard JSON-RPC only. Alchemy-specific methods such as `alchemy_getTokenMetadata` exist only on Alchemy endpoints and are not part of the failover contract (§26.2).
- **WebSocket recovery:** `wsSubscriptionManager.ts` handles it.
  - Every (re)connection backfills over HTTP from the durable checkpoint.
  - Live frames and backfill are deduplicated on `txHash:logIndex`.
  - The checkpoint only advances to heights the backfill covered.
  - Stall detection, single-flight reconnect and jittered backoff are built in, and the manager reports `degraded_polling` when every endpoint fails.
  - HTTP polling remains the path carrying ingestion.
- **Block pinning:** `blockPinnedReader.ts` pins one block per read group and records its hash.
  - Reads never fall back to `latest`.
  - The hash is re-verified after the group, and on any mismatch the whole group restarts at a fresh block (`BLOCK_HASH_MISMATCH`).

## 25. Phase 7D.3.2 — verified quotes, simulation and paper positions

**Merged:** PR #20 at `904df05` (merge `b1de963`). The verification record, with its source matrix, contract identities, fork results and failure modes, is [docs/phase-7d3-2-quote-verification.md](./docs/phase-7d3-2-quote-verification.md). This section covers how the code is organised.

### 25.1 Protocol facts the code relies on

| Contract | Address |
|---|---|
| PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` |
| V4Quoter (official, deployed block 9074) | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` |
| StateView | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` |
| UniversalRouter | `0x8876789976decbfcbbbe364623c63652db8c0904` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |
| PonsV2MemeHook | `0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044` |

These live in `src/pons/quote/protocol.ts` with `QUOTE_SOURCE_REFERENCES`; every quote response carries those references.

- **Quoter:** the official quoter's runtime bytecode equals v4-periphery `6601a199…` built with Uniswap's release settings, so **OnlyPump deploys nothing**.
- **Hook fee:** the hook takes `hookFeeBps + creatorTaxBps` from `launches(poolId)` on the unspecified leg. `hookFeeBps` is 100 on every pool; creator tax is 0–500.
- **Pairing:** native ETH is not always `currency0`. 75 of 164 graduated pools pair with an ERC-20 (USDG, cbBTC, tokenized stocks).

### 25.2 Fork verification (`evm-verification/`)

- **Suites:**
  - The test-hook suite runs in a local PoolManager and needs no RPC.
  - The **actual-Pons** suite runs against Robinhood Chain at block 62211539. It checks that 68 of 68 quote rows equal executed swaps through the real UniversalRouter, and it records the failure modes.
- **`scripts/fork-verify.sh`:**
  - Verifies block number and hash across two providers before forking.
  - Exit codes: 0 PASS, 1 FAIL, 78 BLOCKED.
  - Writes `evidence/*.jsonl` and `status.json`.
- **CI:** CI pins **Foundry v1.8.1**. Robinhood Chain is Arbitrum-based, so the EVM `NUMBER` opcode returns the parent-chain block (25970664 at the pinned block) on 1.8.x. The suite therefore pins by `block.timestamp` and accepts either number.
- **Simulator:** `src/PonsRouteSimulator.sol` is exported by `scripts/export-simulator.mjs` to `src/pons/quote/generated/routeSimulator.json`, which the TypeScript simulation service loads.

### 25.3 Pinned reads

- **Reads:** `pinnedReads.ts` batches each read group into one Multicall3 `aggregate3` at a single block, inside the block-pinned reader (§24.3).
- **Precision:** prices use **1e36** scaling. At 1e18, extreme-ratio pools such as LASSIE/USDG truncated to zero impact; a regression test covers this.
- **Hook fee split:** it is recovered from the net quote and can be ambiguous by 1 base unit, so it is reported as a range (`exact: false`).

### 25.4 Quotes — `POST /tokens/robinhood/:token/quotes`

- **Request:** `{ side: "buy"|"sell", amount: <base units, decimal string>, slippageBps: 1–5000 }`.
- **Venue by launch phase** (`quoteService.ts`):

  | Phase | Venue |
  |---|---|
  | Phase 0 | Bonding curve (`curveQuote.ts`): constant product with a virtual quote amount, fees on the quote leg, clamp and refund at the sellable allocation, sells blocked once ready to graduate |
  | Inside the 3-second snipe window | **Refused** |
  | Phase 2 `PoolCreated` | Official V4Quoter via `eth_call` (`v4Quote.ts`) |
  | Swept, Rescued, Pons V1 | `UNSUPPORTED` |

- **Policy** (`QUOTE_POLICY`, `quote-policy-1`):
  - 30-second TTL.
  - Warn at ≥10% all-in impact; refuse at ≥50% (`PRICE_IMPACT_EXCEEDS_POLICY`).
  - Every quote states `QUOTE_IS_NOT_SELLABILITY`.
- **Response:** `QUOTED` (with `snapshotId` and the quote), `UNSUPPORTED` or `UNAVAILABLE`, each with reason codes. The quote limiter is 20 per minute.

### 25.5 Simulation — `POST …/simulations`

`{ quoteId }` of an unexpired quote is simulated by `simulationService.ts`.

- **How it runs:** an `eth_call` at the quote's own block, with a state override. It installs the simulator bytecode plus balance/allowance storage on synthetic account `0x0000000000000000000000000000000051350001`, then routes through the real UniversalRouter (V4) or curve.
- **Balance slots:** each is probed and accepted only if `balanceOf` returns the probed value. Pons tokens and USDG use slot 0; cbBTC and BULL use the OZ v5 ERC-7201 namespace. An ERC-20 input whose slot cannot be verified is quote-only.
- **Reverts** are decoded against verified selectors (`KNOWN_REVERTS`).
- **Result:** `SIMULATED` or `REVERTED`, flagged if the simulated output differs from the quote.
- **Provider support:** a provider without state-override support yields `UNSUPPORTED_CAPABILITY`, and failover moves on.

### 25.6 Market evidence — `GET …/market-evidence`

`marketEvidenceService.ts` produces a block-pinned snapshot of phase, spot price, fees and depth, cached for 8 seconds in `quoteEngineProvider.ts`.

- **Depth:** what fixed reference sizes (0.1%, 1% and 5% of the pair-side reserve) would return, computed by the same methods as quotes.
- **Liquidity:** raw V4 active liquidity appears only as `advanced.activeLiquidityRaw` and is not presented as an amount.
- **Curve reserves:** the curve's pricing reserve includes a virtual amount and is labelled as such.
- **USD:** unavailable.
- **Unsupported reasons:** `UNKNOWN_TOKEN`, `PROTOCOL_MISMATCH`, `GRADUATION_IN_PROGRESS`, `RESCUED`, `POOL_REGISTRATION_INCONSISTENT`.

### 25.7 Evidence snapshots and paper positions

Migration `20260913200000_add_evidence_snapshots_paper_positions_image_cache` adds three models.

- **`EvidenceSnapshot`:**
  - Kind `QUOTE` or `SIMULATION`, with parent lineage.
  - Block number, hash and timestamp, plus policy/calculation version and the full payload.
  - A database trigger (`evidence_snapshot_reject_mutation`) makes rows **immutable**.
  - Readable by id at `GET /api/v1/evidence/:snapshotId`. Snapshots are market evidence and carry no user data.
- **`PaperPosition`:** scoped to the Supabase user (`sub`).
  - `POST /api/v1/me/paper-positions` takes `{ quoteId, simulationId|null }` and an `Idempotency-Key` header of 8–128 characters.
  - Uniqueness is on `(userId, idempotencyKey)` plus a request fingerprint:
    - Same key and same request → `200 created:false`.
    - Same key and a different request → `IDEMPOTENCY_KEY_REUSED`.
    - A concurrent insert race is resolved via P2002.
  - Only an unexpired quote, and only a successful simulation of that same quote, can back a fill. Otherwise the request fails with `QUOTE_EXPIRED`, `SIMULATION_NOT_FOR_QUOTE` or `SIMULATION_NOT_SUCCESSFUL`.
  - `fillBasis` is `EXECUTION_SIMULATION` or `QUOTE`, and every position carries `paper: true`.
  - Amounts are `Decimal(78,0)` base units.
  - `GET` lists only the caller's rows.
- **`TokenImageCache`:** see §25.8.

Service: `src/services/paperTradingService.ts`. Routes: `src/researchApi/routes/paperTrading.ts`. Contracts: `contracts/paperTrading.ts`.

### 25.8 Token-logo cache

- **Serving:** logos are served from OnlyPump's own origin. The browser never loads a third-party image URL.
  - `robinhoodTokens` responses carry `logo: { url, status }`.
  - Read paths enqueue logo URLs idempotently.
  - `startTokenImageWorker` runs inside the API process.
- **Fetching:** `safeImageFetch.ts` resolves `ipfs://` through `TOKEN_IMAGE_IPFS_GATEWAYS` and applies an SSRF guard (https only, private addresses rejected, size and redirect limits).
  - `imageSafety.ts` sniffs the bytes, so the declared type is not trusted.
  - Failures retry with backoff up to 6 attempts.
- **Route:** `GET /api/v1/media/token-logos/robinhood/:token` returns bytes with `nosniff` and a sandboxing CSP. Anything not READY is a 404 carrying `X-Image-Status`.

## 26. Phase 7D.3.3 — browser acceptance and two fixes it found

**Status:** commits `8b7963c`, `3d366a5` and `a097263` landed after PR #20 merged, so they are delivered in **PR #21**. It is open and has not been merged.

### 26.1 Acceptance run

Two dedicated, confirmed Supabase test users were created in project `weafhrsgxuwrtabkjbmk` through the admin API (`email_confirm: true`). The project's email confirmation stays enabled, and credentials live only in the gitignored `only-pump-me/.env.e2e.local`.

A Playwright run against this API and the local frontend passed **11/11** checks:
- User A saves a real quoted and simulated position.
- A refresh restores the position and its evidence.
- Sign-out clears private cached state.
- User B sees none of A's positions, in the UI or via direct API calls with B's token.
- Repeated and same-tick double saves create exactly one position.

Evidence is in `only-pump-me/docs/phase-7d3-2/auth/` (screenshots, `auth-journey.log`, `auth-results.json`).

**Found and fixed:**
1. **CORS rejected `Idempotency-Key`** (`3d366a5`), so every browser save failed at preflight. Server-side tests cannot see this.
2. **The default dev origins omitted the web app's port 8080** (`a097263`). Opening the app at `http://127.0.0.1:8080` was blocked.

### 26.2 `alchemy_getTokenMetadata`

- **Verified 2026-09-14:** the method works on the `ROBINHOOD_RPC_HTTPS3` Alchemy endpoint and returns correct name, symbol and decimals; `logo` is always null.
- **Elsewhere:** the default public RPC returns `-32601` (method not found).
- **Status:** progressive enrichment through this method is **pending**. It is not implemented, and discovery enrichment still uses standard ERC-20 reads through failover (§24.3).
- **If it is added:** it must be an optional, Alchemy-only enhancement. A `-32601` from a non-Alchemy endpoint is a request fault, not a reason to fail over.

### 26.3 Disposable-database guard

`src/testSupport/disposableDatabaseGuard.ts` is a vitest `globalSetup`.
- **Rule:** if any `*_RUN_DB_TESTS` flag is `true`, the database named in `DATABASE_URL` must look disposable, matching `(^|[_-.])(test|tests|ci|tmp|temp)([_-.]|$)`. The only alternative is `ALLOW_DB_TESTS_ON_NAMED_DATABASE` set to that exact name.
- **`.env` handling:** it reads `.env` without loading it into `process.env`.
- **CI:** the database `ci_migrate_test` passes the rule, and CI now also runs `PAPER_RUN_DB_TESTS`.

### 26.4 The `ORPHANED` incident, and its repair

**This was not a chain event.** On 2026-09-14 at 00:41:06Z the DB integration suites were run against the development database `solana_bot`. They deleted checkpoints and ran reorg recovery against a fake chain. That marked **11,977** Pons V2 `DiscoveredToken` rows `ORPHANED` and cleared their graduation data (SMA among them). The worker could not heal them, because it only re-examines heights above its checkpoint.

**Repaired 2026-09-15** with `src/pons/scripts/repairTestOrphanedTokens.ts` (dry run by default, `--apply` writes in one transaction, unit-tested matching rule):

1. **Backup:** `pg_dump` taken first (`/root/db-backups/solana_bot-LIVE-…-pre-orphan-repair-*.dump`, 54 MB, outside the repo). All workers stopped.
2. **Canonicality:** the factory's `TokenLaunched` and `PoolGraduated` logs were re-scanned over blocks 60,947,510–61,639,952 in 10,000-block chunks via `DEAFULT_RPC_HTTPS`, the only endpoint that accepts wide ranges. 40 of 40 sampled block hashes agreed with a second provider.
3. **Restore rule:** a row returned to `CANONICAL` only if its exact launch log matched: block number, block hash, tx hash, log index and token. Result: **11,977 of 11,977** matched; 0 remain orphaned.
4. **Graduations:** re-derived the way `DiscoveryV2Listener` derives them (`PoolGraduated` plus the `Initialize` log in the same block). **206 filled**, 48 already correct, 0 disagreements. 13 graduations belong to tokens launched before this database's history.
5. **Test junk:** two `CandleInvalidation` rows for the fixture token `0x4444…444d` were deleted.

**After:** 15,275 of 15,275 V2 tokens are `CANONICAL`, 254 are graduated, and all 254 have a PoolId.

**Operational finding:** the app's `DATABASE_URL` (`localhost:5432`) reaches a Debian PostgreSQL 16.15 server running in a container that `docker ps` does not list; `ctr -n moby containers ls` shows it. It shares IP `172.17.0.2` with the unrelated, listed `solana-sniper-postgres` (Alpine) container. `docker exec solana-sniper-postgres psql …` therefore inspects a **different, stale database**. Always inspect through `DATABASE_URL`.

**Found while restarting (Phase 7D.4 scope):** V2 trade ingestion is barriered behind V2 discovery, which is ~1.6M blocks behind the tip because `PONS_MAX_BLOCK_RANGE_PER_POLL=10`. The Alchemy endpoints reject wider `eth_getLogs` ranges. Until discovery log scans use an endpoint that accepts wide ranges, no V2 trades or candles are ingested.

### 26.5 Test counts, reconciled

- **Earlier phases:** they reported 1,594–1,711 passing tests. Those runs also collected tests vendored under `evm-verification/lib`, `.claude/` worktrees and `.run/`.
- **Now:** `vitest.config.ts` excludes those directories. The default suite is **1,111 passed, 82 skipped** (2026-09-14). All DB suites on a disposable database: 1,192 passed, 0 failed.
- **Conclusion:** the drop is the exclusion, not lost coverage.

## 27. Phase 7D.4 — market terminal, guided Practice, vanity handoff

**Status:** merged into `main` as PR #23 on 2026-09-19 (`88d6ec4`), on top of the 7D.3.3 follow-up PR #22 (`b0779c4`). The frontend half is `only-pump-me` PR #12 (`fb27831`). The row-by-row delivery record, with sources and blockers, is `docs/phase-7d4/implementation-matrix.md`.

### 27.1 Data paths added

| Path | Where | Notes |
|---|---|---|
| Pons V2 curve trades | `src/pons/curveTradeListener.ts`, `ponsV2Adapter.decodeCurveTrade` | `CurveBuy`/`CurveSell` from the Sourcify-verified factory bundle (solc 0.8.35). The trader is `recipient` (buyer/seller is a router). Topic-only log query, filtered to discovered curve addresses, behind the discovery barrier. Source `robinhood:pons_v2:curve-trades` |
| RPC range caps | `rpcEndpoints.ts` `RANGE_LIMIT` | A block-range cap is a per-request limit: move to the next endpoint without cooldown or retry |
| USD valuation | `src/pons/usd/chainlinkQuoteUsdRateProvider.ts`, `quoteAssetRegistry.robinhood-mainnet.json` | Feeds from the Chainlink directory for Robinhood mainnet, verified on chain (description, decimals). Staleness is heartbeat × 1.1. Historical rounds are walked back within a phase. Chainlink publishes no sequencer uptime feed for this chain, so chain liveness is checked instead |
| Market data | `src/pons/market/*`, `GET /tokens/robinhood/:address/market` | Rolling windows with coverage `COMPLETE`/`PARTIAL`/`NONE`; zero volume only when coverage is complete; USD volume only when every trade was valued; FDV = total supply × last price |
| Discovery filters | `GET /tokens/robinhood?lifecycle=&q=`, `GET /discovery/chains` | Per-row `quoteAsset`; Solana reported `UNAVAILABLE` |
| Metadata gap-fill | `src/pons/metadata/alchemyMetadataFallback.ts` | Alchemy hosts only; null fields only; `metadataProvenance` per field; decimals conflicts recorded, never applied |
| Artwork | `src/media/tokenImageCache.ts` | Queued at discovery; never-tried rows newest first; fetched concurrently |

### 27.2 Practice

Prisma models `Practice*` (migration `20260915024239`). `src/services/practiceService.ts` runs every ledger write in a serializable transaction with row locks and retries on `40001`/`40P01`. CHECK constraints keep balances and holdings non-negative. Creates are idempotent on (user, key) plus a request fingerprint. Lesson steps are derived from stored facts; only reading steps can be acknowledged. Achievements reward learning actions, never profit. Routes live under `/me/practice` (Supabase users only).

Curve exits: `PonsV2BondingCurve.sell()` executes `trackedQuote -= quoteOut` and panics (0x11) when the curve holds less quote than the exit pays. Paper buys add nothing to the real curve, so such quotes are refused as `CURVE_CANNOT_PAY` (`CURVE_QUOTE_CALCULATION_VERSION = "pons-v2-curve-2"`).

### 27.3 Vanity address handoff

- **Mechanism.** `OnlyPump-Vanity-Generator` grinds Solana ed25519 keypairs whose address ends in `pump`. The address is a pump.fun mint, and the mint keypair must co-sign create, so signing material is unavoidable at launch time. Robinhood Chain has no equivalent (the Pons factory assigns addresses) and reports `UNSUPPORTED`.
- **Storage.** `src/services/vanity/keystore.ts`: one AES-256-GCM file per address (address bound as AAD, mode 0600) under `VANITY_KEYSTORE_DIR`, key `VANITY_KEYSTORE_KEY`. `VanityAddress.secretRef` holds only `keystore:v1:<address>`.
- **Import.** `npm run vanity:import -- --file <batch> [--apply]`. It derives each public key from its secret and checks the suffix. It refuses addresses in `exposedVanityAddresses.json`: 283 public keys whose private keys were committed to Git or served by onlypump.me. It refuses any account that already exists on chain (`getMultipleAccounts`) or cannot be checked. A dry run touches neither the database nor the keystore.
- **State machine.** `AVAILABLE → RESERVED → CONSUMED`, plus `RETIRED`, enforced by CHECK constraints (migration `20260915031429`).
  - Reserve takes `FOR UPDATE SKIP LOCKED` under a per-user advisory lock, lasts 15 minutes, and is idempotent. A user holds one live reservation at a time.
  - An expired reservation returns to stock. A consumed address never does.
- **API.**
  - `GET /vanity/availability`.
  - `GET /me/vanity/reservation`, `POST /me/vanity/reservations`, `DELETE /me/vanity/reservations/:id`.
  - `POST /internal/vanity/reservations/:id/consume` requires the internal API key and returns `secretRef` for the launch signer.
  - Nothing signs, deploys or broadcasts.
- **Public JSON.** `VanityHandoffV1` always carries `deployed: false`.

### 27.4 Live market state, Almost bonded, Trending, Stocks and Crypto

**Why it exists.** Cards showed every token as bonding, with price, market cap and liquidity unavailable. The stage was correct: 548 of about 35.5k tokens had graduated. The values were missing because they came only from indexed trades, and curve-trade ingestion was stuck.

- **`TokenMarketSnapshot`** (`src/pons/market/marketSnapshot.ts`, `marketSnapshotWorker.ts`, in the pons worker).
  - Each batch is one Multicall3 read at a pinned block.
  - Bonding curves: spot price from `getReserves()`; liquidity from `realQuoteReserve()`.
  - Bonding progress is measured on the token side, because `readyToGraduate()` is `sellableTokens() == 0`. That makes progress = the bought-out share of `launchSupply − reservedTokens`.
  - Graduated tokens use StateView `getSlot0` and `getLiquidity`. Liquidity is reported as a full-range equivalent, because graduation seeds one full-range position.
  - A token that graduated after discovery's height gets its pool derived the same way the quoter does it. The pool is accepted only if the hook's registration names that token.
  - USD comes from the verified Chainlink provider.
  - Scheduling: active tokens are re-read every 1–2 minutes. Unchanged tokens back off to 6 hours. New tokens are queued on every tick.
- **Trending** (`trendingVolume.ts`, every minute).
  - Ranks by trade-volume surge: last-hour USD volume against the token's average hourly volume over the previous six hours, boosted when the last five minutes run hotter.
  - Guards: at least $500, 10 trades and 3 distinct traders. New launches need $1,000.
  - It is computed only while every Pons trade stream is indexed to within 10 minutes of now. Otherwise `lifecycle=trending` reports `trending.available=false` with the lag.
- **List API.**
  - `lifecycle` accepts `almost-bonded` and `trending`.
  - `sort` accepts `new`, `marketCap`, `liquidity`, `progress`, `volume1h`, `trending` and `change1h`.
  - Every row carries a `market` object.
- **`GET /markets/crypto|stocks`** (`src/markets/coingecko.ts`).
  - Crypto uses CoinGecko `/coins/markets`, ordered by market cap.
  - Stocks use the category `robinhood-chain-stocks-ecosystem`.
  - Robinhood Chain addresses come from `/coins/list?include_platform=true` (platform `robinhood`) and are checked against Robinhood's official list.
  - Responses are cached for 1 minute. A stale list is served and flagged when CoinGecko fails.
- **Curve-trade ingestion fixes.**
  - The listener was livelocked: it read one block per trade height, a single rate-limited read restarted the whole tick, and it kept retrying the same range.
  - It now uses the logs' `blockTimestamp` when present; all logs of a block must agree, or the tick fails closed.
  - Block reads are cached across ticks.
  - The log window adapts: it halves only on size failures and stops growing just below a failing width.
  - Throughput is still bounded by the one public RPC that serves wide `eth_getLogs` ranges.

### 27.5 Verification

- **Default suite:** 1,145 passed, 111 skipped.
- **All DB suites on the disposable `ci_7d4_test`:** 1,255 passed, 1 skipped (the Anvil reorg test).
- **Build checks:** `tsc` clean; `openapi:check` passes with 40 paths.
- **Browser checks (only-pump-me `docs/phase-7d4/`):**

| Check | Result |
|---|---|
| Discovery | 11/11 |
| Terminal | 13/13 |
| Practice journey | 20/20 |
| Vanity | 13/13 |
| Artwork arrival | 3/3 |

**Re-verified after §27.4 (2026-09-19, the state merged as PR #23):**

- **Default suite:** 1,161 passed.
- **All DB suites** on the disposable `ci_7d4_test`.
- `openapi:check` passes with 41 paths.
- Frontend: 275 tests plus build; `docs/phase-7d4/discovery-check.cjs` 18/18 (live prices on new launches, Almost bonded ordering, Trending's honest state, the Stocks/Crypto tables, mobile).

### 27.6 Remaining blockers (not code)

1. ~~**RPC throughput.** Only the public default RPC serves wide `eth_getLogs` ranges, and it rate-limits… A paid wide-range Robinhood RPC removes this.~~ **Wrong — corrected in §28.1.** The wide-range endpoint was returning Cloudflare `403 / error code: 1010` because the client sent no `User-Agent`. It serves 10,000-block windows at up to ~17,000 blocks/s. No purchase was ever required.
2. **Exposed keypairs.** onlypump.me must be redeployed without the removed key files (283 public keys are permanently refused via `exposedVanityAddresses.json`), and the public vanity repository's history still needs a decision.
3. **Credential rotation:** Helius keys (formerly shipped in the frontend), the E2E user B password, the `ROBINHOOD_RPC_HTTPS2` key, and the Supabase secret key.
4. ~~**Blockscout** is behind a Cloudflare challenge from this host.~~ Re-verified 2026-09-19: returns `HTTP 200` in 1.6s (§28.5).
5. **No Solana discovery ingestion**, so Solana is reported `UNAVAILABLE` end to end.


## 28. Phase 7D.5 — Robinhood live-data readiness

**Status:** branch `feature/phase-7d5-live-data-readiness`, draft PR, not merged. Starting point: `88d6ec4` (PR #23) on both repositories' `main`.

### 28.1 The headline correction

Phase 7D.4 closed with one blocker above all others: *"Only the public default RPC serves wide `eth_getLogs` ranges, and it rate-limits… A paid wide-range RPC removes this."* (§27.6, item 1.)

That was wrong, and nothing was ever going to be bought that fixed it.

`rpc-robinhood.blockmachine.io` sits behind Cloudflare. Cloudflare answers a request that carries **no `User-Agent` header** with `HTTP 403` and the `text/plain` body `error code: 1010`. viem's fetch transport sets no `User-Agent`. So every request the backend ever made to the one endpoint that serves wide ranges was rejected before it reached the node, and failover fell back to Alchemy free-tier keys whose plan caps `eth_getLogs` at **10 blocks**.

Measured on 2026-09-19 against the live chain, with a `User-Agent` and nothing else changed:

| Query | Window | Result |
|---|---|---|
| V2 `TokenLaunched` (address + topic) | 10,000 blocks | 254 logs in 0.57s — **~17,000 blocks/s** |
| Curve `CurveBuy`/`CurveSell` (topic-only) | 9,999 blocks | 13,975 logs in 3.38s — **~3,000 blocks/s** |

Chain growth is ~10 blocks/s. The provider was never the constraint. Any non-empty `User-Agent` is accepted, so `chainClient.ts` sends `OnlyPumpBackend/1.0 (+https://onlypump.me)` — it states what the client is rather than impersonating a browser.

### 28.2 The other four defects, each found by measurement

1. **A bot shield read as a dead key.** `classifyRpcFailure` mapped any 401/403 to `QUOTA_EXHAUSTED`, a 30-minute cooldown. So Cloudflare's 1010 parked the only wide-range endpoint for half an hour at a time and reported it as a billing problem. There is now a `BOT_CHALLENGE` class (60s cooldown) matched on shield fingerprints; a plain `403 Forbidden` still means a revoked key.

2. **The graduation poller had no `venue` filter.** `graduationStatus(token)` is a Pons **V1** factory method. V2 curves do not implement it — V2 graduation is a real `PoolGraduated` event read by `discoveryV2Listener`, which is why no V2 poller exists. Without the filter the poller walked every non-graduated V2 token — **39,623 of them against ~150 real V1 rows** — and every call reverted with `0xcbdb7b30`, costing one RPC round trip and one WARN line each, on the endpoints V2 discovery and curve-trade ingestion were starving for. After the fix the poller emits nothing and V1 discovery went from ~790 to **~2,300 blocks/s**.

3. **The curve-trade window narrowed on evidence that was not about width.** `isSizeFailure` counted viem's generic `"Request failed"` — its wording for *any* non-2xx — and any timeout as proof the window was too wide. The window collapsed 1875 → 10 blocks and stayed pinned at the floor; ingestion ran at ~35 blocks/s against a 6.3M-block backlog while the provider served 10,000-block windows happily. It is now a three-way `classifyWindowFailure`: `RANGE` (a provider naming a range or result cap) narrows and remembers, `SOFT` (timeout/deadline) narrows and remembers nothing, `NONE` (throttling, cooldown, transport) leaves the window alone. Listeners and the failover classifier now share one definition of a range failure, `isRangeLimitMessage`.

4. **A range cap from an endpoint that was never capable.** Endpoints are tried best-key-first and the Alchemy keys refuse anything over 10 blocks. When the wide-range endpoint was merely in cooldown, `FailoverChainClient` still surfaced Alchemy's *"up to a 10 block range"*, the listener believed it and halved — repeatedly, down to the floor. A range cap is only evidence about the range when every configured endpoint got to speak; otherwise the failure now reports itself as an availability problem and the window is left alone.

Also corrected: a client-side `"HTTP response body exceeded the size limit"` (viem's 10 MB cap, hit by a topic-only curve query over 10,000 blocks ≈ 10.5 MB) was classified `CONNECTION`, cooling down a healthy endpoint. It is a `RANGE_LIMIT` — no cooldown, narrow the window — which is what lets the curve window settle at its real ceiling instead of oscillating.

And `tradeV2Listener` logged `"No pons_v2 trade checkpoint found — starting fresh at height N"` at WARN on a branch that persists no `lastHeight` and therefore recomputes it every tick: 37 such lines in 4 minutes, drowning the fact that the barrier it waits on — V2 discovery — was the thing actually stuck. It now logs where a scan really begins.

### 28.3 Ingestion, before and after

All figures from the live chain on 2026-09-19. The stack had been down since 2026-09-15 08:36 (the app database is the `onlypump-pg` container, which had exited); the chain had grown ~3.7M blocks meanwhile.

| Stream | Before (7D.4 code) | After | Lag at session end |
|---|---|---|---|
| Pons V1 discovery | ~790 blocks/s | **~800–2,300 blocks/s** | 1.68M blocks (was 3.71M) |
| Pons V2 discovery | ~46 blocks/s | **~97–123 blocks/s**, full 10,000-block windows | 4.66M blocks |
| V2 curve trades | ~19–35 blocks/s, window **pinned at 10** | ticking again, window climbing (10 → 640 and rising) | 6.33M blocks |
| V4 pool trades | never advanced a checkpoint | still barriered on V2 discovery | — |

Chain growth is ~10 blocks/s, so any rate above that shrinks the backlog. Over the session
V1 discovery advanced **2.06M blocks** and `DiscoveredToken` went 39,770 → 42,407.

Note what the "after" column does *not* say. Curve trades recovered from a hard stop to a
climbing window, but they are not fast yet, and the reason is contention — see §28.4.

### 28.4 The remaining bottlenecks, quantified — NOT fixed here

**First, and cheapest to fix: Pons V1 discovery is scanning for nothing, at the expense of everything else.**

In 36 consecutive ticks it discovered **0 tokens**, and the database contains **zero**
`venue = 'pons'` rows — V1 discovery has never produced a single row in this deployment.
Yet it is the heaviest consumer of the one usable wide-range endpoint, running at ~800
blocks/s while it backfills 1.68M blocks. V2 discovery and curve trades, the two streams
that actually feed the product, contend with it for the same provider and are the ones that
get starved and cooled down.

This is a configuration decision, not a code defect, so it is reported rather than changed
unilaterally: with `PONS_FACTORY` set, `ponsWorkerMain` always starts the V1 discovery,
trade and graduation loops. Confirming the V1 factory is genuinely dead on this chain and
then standing that loop down would hand its entire share of the provider to V2 discovery
and curve trades. Expect that to be worth more than any other single change listed here.



**Second: V2 discovery's per-tick enrichment cost.** Each 10,000-block tick finds ~254 launches and enriches each one with three `eth_call`s (`totalSupply`, `name`, `symbol`) plus one `getTransaction` for launch metadata — ~1,016 RPC round trips per tick, at `PONS_ENRICHMENT_CONCURRENCY=5` (default), against three quota-exhausted Alchemy keys and one workhorse endpoint.

At the measured ~97–123 blocks/s against ~10 blocks/s of chain growth, the 4.66M-block backlog closes in roughly **12–14 hours** unattended. It does close — the backlog shrinks — but that is the honest number, and it assumes the contention above is not made worse.

The obvious fix is to batch the three ERC-20 reads through Multicall3, which `marketSnapshot.ts` already does for its own reads (one Multicall3 read per batch at a pinned block); that would cut the dominant per-tick cost by roughly 30×. It is **deliberately not implemented in this phase**: it changes a correctness-sensitive path (enrichment under block pinning and reorg recovery) and deserves its own change with its own fork tests, rather than being appended to a phase whose measurements were only just taken.

### 28.5 Security posture — verified, and one live exposure

`src/services/vanity/exposedVanityAddresses.json` lists 283 public keys and every one of the 281 keypairs served by the site is in it. Verified on 2026-09-19 by deriving the public addresses from the *live* responses: `test_pump.json` 215/215, `test_fan.json` 50/50, `vanity-keypairs.json` 16/16 — **all already permanently rejected**. Removing the files or rewriting history would not change that, and must not.

**Still live, and the reason this section exists:** `https://onlypump.me` was still serving all three files on 2026-09-19, five days after 76a0681 deleted them. Not a SPA fallback — a control path returns `404 text/plain` while these return `application/json` at 41542, 9737 and 5415 bytes, **byte-for-byte the blobs removed from git**. The repository has been clean since 76a0681; the site was never redeployed. `only-pump-me/scripts/checkDeployedSecrets.mjs` (`npm run check:deployed-secrets`) now proves this against a deployed origin, because a clean repository is not evidence of a clean origin — the existing `noShippedSecrets.test.ts` cannot see the live site.

Rotation status that requires account access and could not be verified from here: the two exposed Helius keys, the `ROBINHOOD_RPC_HTTPS2` key, the Supabase secret key, and the E2E user B password. What *is* observable: `ROBINHOOD_RPC_HTTPS` and `ROBINHOOD_RPC_HTTPS2` both answer `429` (quota exhausted) and `ROBINHOOD_RPC_HTTPS3` serves.

**Blockscout is no longer blocked.** §27.6 item 4 recorded it behind a Cloudflare challenge; on 2026-09-19 `robinhoodchain.blockscout.com` returned `HTTP 200` in 1.6s with the browser `User-Agent` `blockscoutTrace.ts` already sends.
