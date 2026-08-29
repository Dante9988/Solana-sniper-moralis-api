# Architecture & Handoff Guide

> Source of truth for how this repository works **today** (Phases **1–6**, **X**, plus the trading/Telegram surface merged from the `main2` branch).
> Companion docs: [README.md](./README.md) (operator overview), [src/intelligence/README.md](./src/intelligence/README.md) (intelligence danger zone), [src/forensics/README.md](./src/forensics/README.md) (forensics danger zone).

**Snapshot date:** 2026-08-28
**Canonical branch:** `main` (fast-forwarded to `master`'s tip in Phase 7B.1 — see §16.1; `master` still exists, unused going forward)
**Latest commits:** `e88b3e6` (Phase 7B.1: canonical `/api/v1` gateway, Supabase auth — §16), `7ba40f4` (Phase 7A.1: restored the historical init migration, real Postgres CI — §5.6, §11), `4ee49ca` (Phase 7A: non-custodial trading, authenticated API, allowlisted commands — §8), `10668e0` (Merge PR #7 `main2` → `master`, the commit that introduced the custodial trading paths §8 then removed), `ed1ccd3` (rename `src/api` → `src/researchApi` to resolve a directory collision with `main2`), `516fed2` (Phase 6), `8ad67a4` (Phase X)

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
| **Token intelligence (Phases 1–6, X, 7B.1)** | Non-blocking research pipeline on pool/migration discoveries → deterministic report → optional Anthropic synthesis → deterministic forensics → PostgreSQL → read-only HTTP presentation API, now the canonical Supabase-authenticated `/api/v1` gateway (§16) | **Impossible** from this path — fail-closed, no execution imports, enforced by an automated test (`src/presentation/__tests__/executionBoundary.test.ts`, `src/assets/__tests__/executionBoundary.test.ts`) |
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
| **7A** | Non-custodial trading, authenticated `/api/*`, Telegram/Discord allowlists (removes the custodial paths `main2` introduced) | Done — see §8 |
| **7A.1** | Restore the historical `20250324020906_init` migration; real PostgreSQL migration validation in CI | Done — see §5.6, §11 |
| **7B.1** | Canonical `/api/v1` gateway: Supabase JWT auth, versioned routes, OpenAPI, CORS/rate-limit/logging hygiene | Done — see §16 |
| **7B.2** | Authenticated WebSockets, X/Ansem monitoring, wallet-following intelligence, token creation, PumpSwap execution | Not started — see §16.11 |

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

**Resolved in Phase 7A.1 (was previously documented here as a gap):** `prisma/migrations/20250324020906_init/migration.sql` and `prisma/migrations/migration_lock.toml` — the original migration that creates the legacy `Wallet`/`UserConfig`/`PumpFunToken`/`TokenAlert`/`WalletTransaction`/`WalletBalance` tables — existed on `origin/main` but had been missing from `master`'s migration chain since before the `main2` merge (most likely the same class of case-insensitive-filesystem checkout bug documented in §8.5). Restored byte-for-byte from `origin/main` (`git show origin/main:<path>`, verified against the source blob via both `git diff --no-index` and matching `git hash-object`/SHA-256 — see `src/__tests__/migrationChain.test.ts`, which pins those hashes so the historical file can never be silently edited going forward). `prisma migrate deploy` now applies all 7 migrations, in order, against a genuinely fresh PostgreSQL 16 database — both the clean-install path (fresh DB, all 7 migrations) and the upgrade path (a disposable DB seeded through migration 6, with a live `Wallet` row present, then migration 7 applied on top) were verified against real, disposable, throwaway Postgres containers during Phase 7A.1, never against any shared or persistent database. CI now runs the same clean-install validation on every push/PR against its own disposable `postgres:16` service container (§11).

**New gap found while restoring the above (not fixed in Phase 7A.1 — out of that phase's scope):** `schema.prisma`'s `UserPreference` model has no corresponding migration anywhere in the chain (checked both `master`'s and `main`'s history). `prisma migrate deploy` still succeeds — it only applies the migration files that exist, it does not diff against `schema.prisma` — but the resulting database has no `UserPreference` table, so any code path that reads or writes it (`prisma.userPreference.*`) will fail against a freshly migrated database. Needs its own additive migration (`prisma migrate dev --create-only` against a real Postgres instance, reviewed before applying) in a future phase.

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
5. Add the still-missing `UserPreference` migration (found while restoring the above — §3's Phase 5 note) — a fresh `prisma migrate deploy` currently succeeds but leaves that table absent.

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
├── researchApi/                      # Canonical /api/v1 gateway (Phase 6, evolved 7B.1/7B.2 — see §3, §8.4, §16, §17)
│   ├── server.ts                     # createApiServer(db, config) — requestId, CORS, routes, error handler
│   ├── config.ts                     # Fail-closed env config: API_KEYS, Supabase, CORS, rate-limit/realtime backend
│   ├── middleware/{authenticate,supabaseAuth,requestId,cors,rateLimit,validateMint}.ts
│   ├── routes/{health,docs,me,tokens,jobs,wallets,realtimeTickets}.ts
│   ├── contracts/{zodOpenApi,common,errors,openapi,wallets}.ts   # One Zod source for validation + OpenAPI (§16.5)
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
npx prisma migrate deploy    # full 8-migration chain, init through add_user_preference (§3, §5.6, §16.2)
                              # — validated clean-install and upgrade against real disposable Postgres

npm run build                 # tsc
npx vitest run                # full mocked suite (701 tests as of this snapshot; 2 more opt-in DB-integration
                               # files are skipped by default — see below)
WALLET_RUN_DB_TESTS=true npx vitest run src/services/__tests__/walletVerificationService.dbIntegration.test.ts
                               # real-Postgres atomicity/cross-account-claim proof (§17.1) — disposable DB only
npm run test:intelligence     # intelligence subset
npm run test:api-v1           # /api/v1 gateway subset only (src/researchApi) — §16
npm run openapi:generate      # writes openapi.json (gitignored snapshot; the live route always regenerates)
npx prisma@6.5.0 validate

npm run dev                   # see §0/§8 — also starts the Telegram bot (non-custodial, allowlisted); API_ENABLED=true additionally starts src/api/index.ts (bearer-authenticated)
npm run pumpfun                # Pump.fun mint Discord only, no trading surfaces
npm run api                    # Canonical /api/v1 gateway (Phase 6, evolved 7B.1 — §16), standalone process
npm run api:server             # main2's read-only standalone status API
npm run forensics:worker       # disabled by default (FORENSICS_WORKER_ENABLED=false)
npm run forensics:fixture      # synthetic, zero live network calls — safe to run any time
npm run x:smoke                # only place X_BEARER_TOKEN is read
```

CI (`.github/workflows/ci.yml`) runs, on Node 20, for every push/PR to `main`/`master`: `npm ci` → `prisma generate` → `prisma validate` → wait for a disposable `postgres:16` **service container** to report ready (`pg_isready`) → `prisma migrate deploy` against that container (a real clean-install migration run every time — not a placeholder, and not a shared or persistent database; it starts empty on every job and is discarded when the job ends) → `tsc --noEmit` → `vitest run` → `npm run build`. This is a Phase 7A.1 change: CI previously used a `DATABASE_URL` string Prisma Client never actually connected with (`prisma generate` only needs it to be *set*, not reachable), which is exactly how the missing `20250324020906_init` migration (§3, §5.6) went unnoticed — `prisma migrate deploy` was never actually exercised in CI before. The full test suite still mocks Prisma completely and makes no live network/database calls of its own — `src/api/__tests__/index.test.ts` mocks `../discord/discord` and `../telegram/telegramBot` before importing `src/api/index.ts` for exactly this reason (importing the real modules would call `client.login(DISCORD_BOT_TOKEN)` at module scope). The `src/presentation/`/`src/researchApi/`/`src/assets/`/`src/x/`/`src/forensics/` execution-boundary tests still only scan those directories (unchanged); `src/telegram/`, `src/discord/`, and `src/api/` now have their own separate regression coverage instead (§3 Phase 6 note, §8.2's intent-hardening tests, §8.3's auth tests) — so CI verifies both that the trading surface compiles *and* that its auth/allowlist/non-custodial invariants hold, but the live Solana Pay flow (a real wallet app fetching `/pay/*` and signing) is still not exercised by CI or by any test in this repo; see §14.

**What Phase 7A.1's migration validation does and does not cover:** CI's `postgres:16` service container proves the *clean-install* path — the full 7-migration chain applies to a genuinely fresh database — on every run, going forward. The *upgrade* path (a database that already has migrations 1-6 applied, then gets migration 7 on top, with pre-existing rows) was validated once, manually, during Phase 7A.1 against a disposable local Postgres 16 container seeded with a representative `Wallet` row — it is **not** re-validated by CI on every run, because CI's database starts empty every time. If a future migration needs the same kind of upgrade-safety proof (e.g. another `ALTER` against a populated table), repeat that manual procedure: apply migrations up to N-1, insert representative rows, apply migration N, confirm the rows and constraints look right. A true point-in-time snapshot of a real production database was not available in this environment, so "upgrade validated" here means "validated against a disposable database seeded to look like the prior schema," not "replayed against an actual historical database dump" — that stronger check remains open if a sanitized snapshot ever becomes available.

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
| Supabase JWT auth (Phase 7B.1, §16.4) | `SUPABASE_URL` (only required setting — enables JWKS-based ES256/RS256 verification automatically), `SUPABASE_JWT_SECRET` (legacy HS256 only), `SUPABASE_JWT_AUDIENCE` | Yes |
| `/api/v1` CORS (Phase 7B.1, §16.6) | `CORS_ALLOWED_ORIGINS` (never a wildcard — config load throws if `*` is present), `CORS_DEV_ORIGINS` (non-production only) | Yes |
| `/api/v1` rate-limit backend (Phase 7B.1, §16.7) | `RATE_LIMIT_BACKEND` (`memory`\|`redis` — required explicitly when `NODE_ENV=production`), `REDIS_URL` (required when backend is `redis`) | Yes |
| Wallet-challenge binding (Phase 7B.2, §17.1) | `ONLYPUMP_DOMAIN` (default `onlypump.me`), `ONLYPUMP_URI` (default `https://onlypump.me`) — baked into every challenge message server-side, never from request input | Yes |
| Realtime event bus + WS ticket store (Phase 7B.2, §17.5) | `REALTIME_BACKEND` (`memory`\|`redis` — required explicitly when `NODE_ENV=production`, reuses `REDIS_URL`), `WS_TICKET_TTL_MS`, `WS_MAX_MESSAGE_BYTES`, `WS_MAX_SUBSCRIPTIONS_PER_CONNECTION`, `WS_MAX_CONNECTIONS_PER_USER`, `WS_IDLE_TIMEOUT_MS` | Yes |
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
4. `UserPreference` (in `schema.prisma`) has no migration anywhere in the chain — found during Phase 7A.1's migration-chain restoration, not fixed there (see §3's Phase 5 note).

**Resolved (kept here for history — see §8.2-8.3, §8.6 for detail):**

- ~~Telegram/Discord/API trading executed real transactions with no RugCheck gate, no simulation flag, no confirmation step.~~ Fixed — trading is now non-custodial; every trade requires the user's own wallet approval.
- ~~Private keys imported via Telegram or created via Sniperoo were stored in plaintext in Postgres.~~ Fixed — this bot never generates, imports, or stores a private key anywhere anymore. `sniperooService.ts` is deleted.
- ~~Three independent trading backends coexisted with no shared safety layer.~~ Reduced to one working, non-custodial backend (Jupiter); the other two custodial backends are removed.
- ~~`src/api/index.ts` had no authentication on any route and started unconditionally.~~ Fixed — off by default (`API_ENABLED`), bearer-authenticated on every `/api/*` route when enabled.
- ~~`/buy`/`/sell` weren't restricted to an admin/allowlisted user.~~ Fixed — `TELEGRAM_ADMIN_IDS`/`DISCORD_ADMIN_IDS` allowlists, fail closed.
- ~~`.env.example` didn't document the Telegram/`main2`-API/Solana-Pay env vars.~~ Fixed — see §12.
- ~~The original `20250324020906_init` Prisma migration file was missing from the repo, so `prisma migrate deploy` failed against a fresh database.~~ Fixed in Phase 7A.1 — restored byte-for-byte from `origin/main`; clean-install and upgrade paths validated against real disposable PostgreSQL, and CI now runs the same clean-install validation on every push/PR (§3, §5.6, §11).

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
3. Add the missing `UserPreference` migration (§3 Phase 5 note, found in Phase 7A.1) — generate it against a real Postgres instance (`prisma migrate dev --create-only`) and review the SQL before applying anywhere real.
4. Set real `TELEGRAM_ADMIN_IDS`/`DISCORD_ADMIN_IDS`/`API_AUTH_TOKEN` values before relying on any of §8.3/§8.6's gates — they fail closed, but only once actually configured; an empty `.env` still means "nobody" for the allowlists (correct) and "server refuses everything" for the API (also correct, but means the API literally won't work until you set a token).

**Everything else (unchanged priority):**

5. Subscribe to real PumpSwap AMM (`pAMMBay…`) **in addition to** current CreatePool watch; keep Pump.fun mint process separate.
6. Implement real PumpSwap AMM swap instructions, or remove the vestigial `SwapService.PUMPFUN` preference option that no longer changes anything at execution time.
7. Chroma semantic projection (Postgres remains source of truth).
8. A *safe*, read-only chat surface for the intelligence/forensics layer, following the exact pattern already proven and then reverted for Phase 6's Telegram prototype (execution-boundary-tested, no wallet input, no buy buttons) — do not reuse or extend the `main2` bot for this.
9. Fix `pumpfun15k` script path when touching scripts.

---

## 15. One-line truth

**`npm run dev` alerts Discord on CreatePool, dispatches a non-blocking read-only Token Intelligence pipeline (Moralis/RugCheck/social/Anthropic/Solana forensics → Prisma, optionally exposed read-only via `npm run api`) — and, separately, also launches an allowlisted, non-custodial Telegram/Discord trading bot (every `/buy`/`/sell` is a Solana Pay link the user approves in their own wallet — this project never generates, imports, or stores a private key), plus an HTTP server (`src/api/index.ts`) that is off by default and bearer-authenticated on every `/api/*` route when enabled. The intelligence/forensics/presentation path is genuinely execution-proof and test-enforced; the trading surface no longer custodies funds and is no longer open to arbitrary users or unauthenticated requests — what's left open is documented, not hidden: real PumpSwap AMM execution was never built, the live Solana Pay flow is only unit-tested here (no real deployment to test against), and any key imported before this fix is still compromised until rotated (§8, §13, §14). As of Phase 7B.1 (§16), that same read-only intelligence pipeline is also reachable through a versioned, Supabase-authenticated `/api/v1` gateway (`npm run api`) meant for the OnlyPump web/mobile apps — it is read-only today; it does not, and cannot yet, place a trade.**

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
| GET | `/api/v1/tokens/:mint/report` | Supabase or API key* | Deterministic risk view (unchanged from Phase 6, reused via `riskViewLoader`/`toApiJson`) |
| GET | `/api/v1/tokens/:mint/forensics` | Supabase or API key* | Latest `SolanaForensicsRun` for the mint, if any |
| POST | `/api/v1/tokens/:mint/scans` | Supabase or API key | Idempotent forensics-scan enqueue (renamed from Phase 6's `/scan`) — `202` on a freshly queued job, `200` with the same `jobKey` on a repeat call for the same mint |
| GET | `/api/v1/jobs/:jobKey` | Supabase or API key* | Poll a forensics job's status |

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

`code` is one of a small fixed set (`BAD_REQUEST`, `INVALID_MINT`, `UNAUTHORIZED`, `AUTH_NOT_CONFIGURED`, `FORBIDDEN`, `NOT_FOUND`, `RATE_LIMITED`, `INTERNAL_ERROR`) each mapped to one HTTP status. No response — success or error — ever includes a stack trace, a raw SQL/Postgres error, a provider secret, an internal connection string, a private key, or a raw JWT; the global error handler logs the real error server-side (redacted, see below) and returns only `INTERNAL_ERROR` to the caller.

### 16.6 CORS

`src/researchApi/middleware/cors.ts` — an explicit allowlist (`CORS_ALLOWED_ORIGINS`), never a wildcard (`loadApiConfig` throws at startup if `*` appears in it). A request with no `Origin` header (native mobile, server-to-server, curl) is never touched by this middleware — CORS is a browser-only concept. Outside `NODE_ENV=production`, an additional `CORS_DEV_ORIGINS` list (defaulting to the usual local Vite (`:5173`) and Expo (`:19006`/`:8081`) ports) is also honored; in production, only `CORS_ALLOWED_ORIGINS` counts. A denied origin gets no `Access-Control-*` headers at all on a normal request (the browser enforces the block), and an outright `403` on a preflight `OPTIONS` so the browser never proceeds to the real request.

### 16.7 Rate limiting

`src/researchApi/middleware/rateLimit.ts` now sits behind a `RateLimiterStore` interface — `MemoryRateLimiterStore` (single-process fixed window, the only kind Phase 6 had) or `RedisRateLimiterStore` (shared counters via `INCR`/`PEXPIRE` against `REDIS_URL`, using `ioredis`). Which one is used is `RATE_LIMIT_BACKEND` (`memory` | `redis`), and `loadApiConfig` **fails closed on this specifically**: with `NODE_ENV=production`, `RATE_LIMIT_BACKEND` must be set explicitly (no silent default that would pretend a single process's in-memory counters are shared across a multi-instance deployment), and `RATE_LIMIT_BACKEND=redis` without `REDIS_URL` refuses to start at all. Outside production, an unset `RATE_LIMIT_BACKEND` still quietly defaults to `memory` — fine for local dev and tests. Read and scan-creation limits remain the separate Phase 6 policies (`PRESENTATION_RATE_LIMIT_PER_MIN`, `SCAN_ENQUEUE_LIMIT_PER_HOUR`); health/docs/openapi.json are never rate-limited (they're free, and a client needs them before it can even authenticate).

### 16.8 Logging

`src/researchApi/lib/logger.ts` wraps the already-installed (previously unused) `pino`, configured with a redaction path list covering `Authorization`/`Cookie` headers, any `apiKey`/`token`/`accessToken` field, and — as defense-in-depth, even though nothing in this gateway should ever hold one — `walletPk`/`privateKey`/`secretKey`/`mnemonic`/`seedPhrase`/`databaseUrl` wherever they appear in a logged object. Redaction happens inside pino's own serializer, not at each call site, so a future call that accidentally logs a whole request or config object still can't leak these paths.

### 16.9 Legacy `/api/*` (unversioned)

`src/api/index.ts` (the `main2` trading surface, §8) is unchanged and explicitly marked `⚠️ DEPRECATED / INTERNAL` in its own header comment — it still exists only for the Telegram/Discord non-custodial trading flow that already depends on `/api/wallet/connect`, `/api/transaction/{buy,sell}`, and the public `/pay/*` Solana Pay callbacks (§8.2-8.3). No new frontend work should target it; it is not part of `/api/v1` and never will be. Its Phase 7A security behavior (fail-closed bearer auth, off by default, no wallet-create/import routes) is unchanged and still covered by `src/api/__tests__/index.test.ts`.

### 16.10 New environment variables

All names-only in `.env.example`; see §12 for the full table. New in this phase: `SUPABASE_URL`, `SUPABASE_JWT_SECRET`, `SUPABASE_JWT_AUDIENCE`, `CORS_ALLOWED_ORIGINS`, `CORS_DEV_ORIGINS`, `RATE_LIMIT_BACKEND`, `REDIS_URL`.

### 16.11 What's still open (Phase 7B.2 candidates)

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

### 17.6 What's still open (Phase 7B.3 candidates)

1. `RedisEventBus`/`RedisTicketStore` are proven against mocked `ioredis` clients only — validate against a real (disposable/staging) Redis instance before relying on `REALTIME_BACKEND=redis` in production (same open item as §16.7's `RedisRateLimiterStore`).
2. `token.report.updated` is defined in the event-type union but not wired to any emitter yet (§17.3) — needs a decision on whether/how to connect it to the intelligence pipeline's own report-save path.
3. No live Supabase project, no live Solana wallet-adapter signature, and no live multi-process (API + worker) Redis relay were exercised end-to-end — everything here is proven with local test JWT keys, an ephemeral test keypair for signing, and disposable/mocked infrastructure. Do the real thing once there's a real deployment to test against.
4. `ONLYPUMP_DOMAIN`/`ONLYPUMP_URI` need real values before any challenge message is meaningful outside this dev environment.
5. The frontend integration (`only-pump-me`) is tracked separately — see that repository's own `ARCHITECTURE.md`/README for its side of this phase.
