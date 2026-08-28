# Architecture & Handoff Guide

> Source of truth for how this repository works **today** (Phases **1–6**, **X**, plus the trading/Telegram surface merged from the `main2` branch).
> Companion docs: [README.md](./README.md) (operator overview), [src/intelligence/README.md](./src/intelligence/README.md) (intelligence danger zone), [src/forensics/README.md](./src/forensics/README.md) (forensics danger zone).

**Snapshot date:** 2026-08-27
**Latest commits:** `10668e0` (Merge PR #7 `main2` → `master`), `ed1ccd3` (rename `src/api` → `src/researchApi` to resolve a directory collision with `main2`), `516fed2` (Phase 6), `8ad67a4` (Phase X)

**Stack:** TypeScript / Node 18+ (CI runs Node 20), Solana Web3.js, Discord.js v14, **Telegraf** (Telegram bot), Prisma + PostgreSQL, SQLite holdings tracker, Express (three separate HTTP surfaces — see §8.3), Helius RPC/WSS, Geyser WSS, Moralis (supported REST only), DexScreener/Birdeye fallbacks, RugCheck/SolSniffer, Jupiter (three independent integrations — see §8.2), Jito (tip-only, not full bundle submission), Anthropic Claude (AI synthesis), canonical cross-chain research assets, X API (read-only checkpoint), Vitest.

---

## ⚠️ 0. Read this before running `npm run dev`

This section exists because the single most important fact about the current state of this repository does not fit anywhere else without getting lost: `npm run dev` starts a live Telegram trading bot alongside everything it already did. **As of this snapshot, that bot is non-custodial** (trades are approved in the user's own wallet app — see §8.2) **and its trading commands are allowlisted** (§8.6); its HTTP server (`src/api/index.ts`) is **off by default** and, when enabled, requires a bearer token on every `/api/*` route (§8.3). Full detail is in §8 — read it before changing any of that, and definitely before running with `API_ENABLED=true` on a network-reachable host.

---

## 1. What This Project Is

Three layers share one codebase:

| Layer | Purpose | Trading |
|-------|---------|---------|
| **Legacy listeners + Discord** | Detect Pump.fun mints / pool CreatePool events; alert Discord; optional PnL tracking | Simulation-gated (`config.rug_check.simulation_mode`) — keep disabled for production research |
| **Token intelligence (Phases 1–6, X)** | Non-blocking research pipeline on pool/migration discoveries → deterministic report → optional Anthropic synthesis → deterministic forensics → PostgreSQL → read-only HTTP presentation API | **Impossible** from this path — fail-closed, no execution imports, enforced by an automated test (`src/presentation/__tests__/executionBoundary.test.ts`, `src/assets/__tests__/executionBoundary.test.ts`) |
| **Telegram/Discord trading bot + trading services** (merged from `main2`, PR #7) | `/buy`, `/sell`, `/wallet connect <public_address>` via Telegram, Discord, and `POST /api/transaction/*` | **Non-custodial and allowlisted** — this bot never generates, imports, or stores a private key; every trade is a Solana Pay link the user approves in their own wallet app (§8.2), and only allowlisted user IDs can invoke trading commands at all (§8.6). Its HTTP server (`src/api/index.ts`) is off by default and bearer-authenticated when enabled (§8.3). |

**Implemented:** everything in the first two layers (event types, orchestrator, researchers, Prisma report store, non-blocking listener dispatch, Anthropic synthesis, Moralis compatibility cleanup, trench.bot removed from runtime, canonical asset identity, deterministic Solana forensics 5A–5E, read-only presentation HTTP API, an X API read-only capability checkpoint) plus, from `main2`: a Telegraf-based Telegram bot with real buy/sell/wallet commands, a `PumpSwapService` and a `JupiterService` trading class, a websocket/API server, PnL/top-calls/simulation reporting scripts.

**Not implemented yet:** Chroma/RAG, trending history, macro/news beyond the X checkpoint, intelligence → Discord/Telegram notifications, real PumpSwap AMM swap execution (Jupiter is the only working swap path). (`src/api/index.ts` authentication is implemented — bearer-token, fail-closed, off by default — see §8.3.)

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
│  /api/v1/tokens/:mint/{report,forensics,scan}, read-only, bearer-auth│
└──────────────────────────────────────────────────────────────────────┘

┌─ PROCESS C: npm run forensics:worker (separate, disabled by default) ┐
│  Claims SolanaForensicsJob rows (FOR UPDATE SKIP LOCKED), runs        │
│  deterministic analyzers against Helius, persists runs/evidence.     │
│  FORENSICS_WORKER_ENABLED=false by default — must be explicitly on.  │
└──────────────────────────────────────────────────────────────────────┘

┌─ PROCESS D: npm run api (separate, Phase 6 read-only presentation)   ┐
│  src/researchApi/server.ts — Express on its own API_PORT, bearer-key │
│  auth on POST, reads Prisma only. Not the same file or port as the   │
│  main2 API — see §8.3 for the three-servers-named-"api" situation.   │
└──────────────────────────────────────────────────────────────────────┘

┌─ PROCESS E: npm run api:server (main2's standalone read-only API)    ┐
│  src/api-server.ts → src/api/standalone.ts — /health, /, /api/status,│
│  /api/utils/sol-price. No Discord/Telegram/wallet imports, no trades.│
└──────────────────────────────────────────────────────────────────────┘
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

Phase briefs live in `phase2.txt`, `phase3.txt`, `phase3-1.txt`, `phase4.txt`, `phase5*.txt`, `phase6` (repository root, historical prompts). The `main2` merge had no corresponding phase brief — it is independent legacy work with its own history (commits from May 2025), reconciled into `master` in this session (see git log around `10668e0` and the fix commits immediately before it for the merge-damage repairs that were required).

### Phase 4 details

Phase 4 implements a canonical, provider-neutral research foundation for cross-chain assets and market observations. It is intentionally not wired into active listeners, the TokenIntelligenceOrchestrator, Discord alerts, tracker writes, or any execution/trading paths.

Primary artifacts (created under `src/assets/`):

- `src/assets/types.ts` — canonical AssetIdentity types and research observation types
- `src/assets/chainRegistry.ts` — immutable supported-chain registry (`SOLANA`, `ETHEREUM`, `BNB_SMART_CHAIN`)
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

**Note:** the original `20250324020906_init` migration (and `migration_lock.toml`) that created the legacy `Wallet`/`TokenAlert`/`WalletTransaction`/`WalletBalance` tables no longer exists in the migrations folder — it was deleted somewhere in `main2`'s history before the merge (most likely a case-insensitive-filesystem checkout issue, the same class of bug documented in §8.5). The tables themselves are still in `prisma/schema.prisma` and presumably still exist in any already-provisioned database, but `prisma migrate deploy/status` against a **fresh** database, or one that already recorded that migration as applied, may report drift or fail. Regenerate that migration (`prisma migrate diff` against an existing DB, or `prisma db pull` + a fresh baseline) before trusting `prisma migrate deploy` on a new environment. (The `20260827010000_wallet_pk_optional` migration above was applied directly to the local dev DB via `prisma db execute`, bypassing `migrate dev`'s drift check, for exactly this reason — do the same on any other pre-existing database until the missing init migration is regenerated.)

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
- `src/services/riskViewLoader.ts` — the one place Prisma rows are loaded and mapped into `RiskViewInput`; also falls back to a standalone `SolanaForensicsRun` for a mint with no `TokenIntelligenceReport` (e.g. a token only ever manually scanned via `POST /scan`, never seen by the live listener) rather than reporting it as never-analysed.
- `src/researchApi/` — Express, its own `API_PORT` (not the listener's `METRICS_PORT`, and not the same process as `main2`'s `src/api/index.ts` or `src/api/standalone.ts` — see §8.3 for how three different things all end up named "api"). `GET /api/v1/tokens/:mint/report`, `GET /api/v1/tokens/:mint/forensics`, `POST /api/v1/tokens/:mint/scan` (idempotent enqueue via the Phase 5D `forensicsJobService`), `GET /api/v1/jobs/:jobKey`, `GET /api/v1/health`. Bearer-key auth (`API_KEYS`) on `POST`, optionally public on `GET` (`API_PUBLIC_READS`); in-memory per-key/IP rate limiting. `createApiServer()` only ever listens behind `require.main === module`. Named `researchApi` rather than `api` because `main2`'s own unrelated `src/api/` collided with it once merged — merging the two into one directory would have mixed execution-path code into this read-only layer's own execution-boundary scan.

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

Migrations: see the list in §3's Phase 5 section (the original `20250324020906_init` legacy-tables migration file is missing from the repo — see the note there).

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
| Phase 6 research API | `src/researchApi/server.ts` | `API_PORT` (own var, default 8787) | Bearer key on `POST`, optional public `GET` | None — read-only + one idempotent job enqueue | `npm run api` only, behind `require.main === module` |
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
4. Regenerate the missing `20250324020906_init` migration (§3's Phase 5 note) so `prisma migrate deploy/status` behaves predictably on any database.

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
├── assets/                           # Phase 4 canonical identity (see §3)
├── presentation/                     # Phase 6 pure projection layer (see §3)
├── researchApi/                      # Phase 6 read-only HTTP API (see §3, §8.4)
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
npx prisma migrate deploy    # see §3's Phase 5 note about the missing init migration first

npm run build                 # tsc
npx vitest run                # full mocked suite (535 tests as of this snapshot)
npm run test:intelligence     # intelligence subset
npx prisma@6.5.0 validate

npm run dev                   # see §0/§8 — also starts the Telegram bot (non-custodial, allowlisted); API_ENABLED=true additionally starts src/api/index.ts (bearer-authenticated)
npm run pumpfun                # Pump.fun mint Discord only, no trading surfaces
npm run api                    # Phase 6 read-only research API, standalone process
npm run api:server             # main2's read-only standalone status API
npm run forensics:worker       # disabled by default (FORENSICS_WORKER_ENABLED=false)
npm run forensics:fixture      # synthetic, zero live network calls — safe to run any time
npm run x:smoke                # only place X_BEARER_TOKEN is read
```

CI (`.github/workflows/ci.yml`) runs `npm ci`, `prisma generate`, `tsc --noEmit`, `vitest run`, `npm run build` on Node 20 for every push/PR to `main`/`master`. It uses a placeholder `DATABASE_URL` and never talks to a real database or a real Telegram/Discord/Anthropic/Helius/wallet-app endpoint — `src/api/__tests__/index.test.ts` mocks `../discord/discord` and `../telegram/telegramBot` before importing `src/api/index.ts` for exactly this reason (importing the real modules would call `client.login(DISCORD_BOT_TOKEN)` at module scope). The `src/presentation/`/`src/researchApi/`/`src/assets/`/`src/x/`/`src/forensics/` execution-boundary tests still only scan those directories (unchanged); `src/telegram/`, `src/discord/`, and `src/api/` now have their own separate regression coverage instead (§3 Phase 6 note, §8.2's intent-hardening tests, §8.3's auth tests) — so CI verifies both that the trading surface compiles *and* that its auth/allowlist/non-custodial invariants hold, but the live Solana Pay flow (a real wallet app fetching `/pay/*` and signing) is still not exercised by CI or by any test in this repo; see §14.

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
| Research API (Phase 6) | `API_PORT` (default 8787), `API_KEYS`, `API_PUBLIC_READS`, `PRESENTATION_RATE_LIMIT_PER_MIN`, `SCAN_ENQUEUE_LIMIT_PER_HOUR` | Yes — but see §8.4, this `API_PORT` is easy to confuse with `main2`'s unrelated same-named var |
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
2. The original `20250324020906_init` Prisma migration file is missing from the repo (deleted somewhere in `main2`'s history) — `prisma migrate deploy/status` may report drift against a database that already has it recorded as applied (see §3's Phase 5 note).
3. Any private key already imported via the old Telegram/Discord/Sniperoo flows, before the non-custodial fix, is still sitting in plaintext in Postgres (`Wallet.walletPk`, now nullable but not retroactively cleared) — those wallets should be treated as compromised and rotated.
4. `SOLANA_PAY_BASE_URL` has no real value in this dev environment, so the non-custodial buy/sell flow is verified only by unit test here, not live end-to-end — do that once deployed somewhere with a real HTTPS URL.

**Resolved (kept here for history — see §8.2-8.3, §8.6 for detail):**

- ~~Telegram/Discord/API trading executed real transactions with no RugCheck gate, no simulation flag, no confirmation step.~~ Fixed — trading is now non-custodial; every trade requires the user's own wallet approval.
- ~~Private keys imported via Telegram or created via Sniperoo were stored in plaintext in Postgres.~~ Fixed — this bot never generates, imports, or stores a private key anywhere anymore. `sniperooService.ts` is deleted.
- ~~Three independent trading backends coexisted with no shared safety layer.~~ Reduced to one working, non-custodial backend (Jupiter); the other two custodial backends are removed.
- ~~`src/api/index.ts` had no authentication on any route and started unconditionally.~~ Fixed — off by default (`API_ENABLED`), bearer-authenticated on every `/api/*` route when enabled.
- ~~`/buy`/`/sell` weren't restricted to an admin/allowlisted user.~~ Fixed — `TELEGRAM_ADMIN_IDS`/`DISCORD_ADMIN_IDS` allowlists, fail closed.
- ~~`.env.example` didn't document the Telegram/`main2`-API/Solana-Pay env vars.~~ Fixed — see §12.

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
3. Regenerate the missing `20250324020906_init` migration (or a fresh baseline) so `prisma migrate deploy/status` behaves predictably on any database.
4. Set real `TELEGRAM_ADMIN_IDS`/`DISCORD_ADMIN_IDS`/`API_AUTH_TOKEN` values before relying on any of §8.3/§8.6's gates — they fail closed, but only once actually configured; an empty `.env` still means "nobody" for the allowlists (correct) and "server refuses everything" for the API (also correct, but means the API literally won't work until you set a token).

**Everything else (unchanged priority):**

5. Subscribe to real PumpSwap AMM (`pAMMBay…`) **in addition to** current CreatePool watch; keep Pump.fun mint process separate.
6. Implement real PumpSwap AMM swap instructions, or remove the vestigial `SwapService.PUMPFUN` preference option that no longer changes anything at execution time.
7. Chroma semantic projection (Postgres remains source of truth).
8. A *safe*, read-only chat surface for the intelligence/forensics layer, following the exact pattern already proven and then reverted for Phase 6's Telegram prototype (execution-boundary-tested, no wallet input, no buy buttons) — do not reuse or extend the `main2` bot for this.
9. Fix `pumpfun15k` script path when touching scripts.

---

## 15. One-line truth

**`npm run dev` alerts Discord on CreatePool, dispatches a non-blocking read-only Token Intelligence pipeline (Moralis/RugCheck/social/Anthropic/Solana forensics → Prisma, optionally exposed read-only via `npm run api`) — and, separately, also launches an allowlisted, non-custodial Telegram/Discord trading bot (every `/buy`/`/sell` is a Solana Pay link the user approves in their own wallet — this project never generates, imports, or stores a private key), plus an HTTP server (`src/api/index.ts`) that is off by default and bearer-authenticated on every `/api/*` route when enabled. The intelligence/forensics/presentation path is genuinely execution-proof and test-enforced; the trading surface no longer custodies funds and is no longer open to arbitrary users or unauthenticated requests — what's left open is documented, not hidden: real PumpSwap AMM execution was never built, the live Solana Pay flow is only unit-tested here (no real deployment to test against), and any key imported before this fix is still compromised until rotated (§8, §13, §14).**
