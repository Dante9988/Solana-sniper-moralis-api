# Architecture & Handoff Guide

> Source of truth for how this repository works **today** (Phases **1–3.1**).  
> Companion docs: [README.md](./README.md) (operator overview), [src/intelligence/README.md](./src/intelligence/README.md) (intelligence danger zone).

**Snapshot date:** 2026-08-25  
**Latest intelligence commit family:** `feat: add token intelligence phase 3.1` (`54d5772`)

**Stack:** TypeScript / Node 18+, Solana Web3.js, Discord.js v14, Prisma + PostgreSQL, SQLite holdings tracker, Express metrics, Helius RPC/WSS, Geyser WSS, Moralis (supported REST only), DexScreener/Birdeye fallbacks, RugCheck/SolSniffer, Jupiter (legacy trading only), Anthropic Claude (AI synthesis), canonical cross-chain research assets, Vitest.

---

## 1. What This Project Is

Two layers share one codebase:

| Layer | Purpose | Trading |
|-------|---------|---------|
| **Legacy listeners + Discord** | Detect Pump.fun mints / pool CreatePool events; alert Discord; optional PnL tracking | Simulation-gated; keep disabled for production research |
| **Token intelligence (Phases 1–3.1)** | Non-blocking research pipeline on pool/migration discoveries → deterministic report → optional Anthropic synthesis → PostgreSQL | **Impossible** from this path (fail-closed, no execution imports) |

**Implemented:** event types, orchestrator, researchers, Prisma report store, non-blocking listener dispatch, Anthropic synthesis, Moralis compatibility cleanup, trench.bot removed from runtime.

**Not implemented yet (Phase 4+ / later):** Chroma/RAG, trending history, macro/news, X ingestion, internal bundle/wallet-cluster forensics, hard eligibility policy, intelligence → Discord notifications, dashboard API.

---

## 2. End-to-End Runtime Map

```text
┌─ PROCESS A: npm run pumpfun ─────────────────────────────────────────┐
│  src/pumpfun-sniper.ts                                               │
│  Geyser WSS → Pump.fun program → InitializeMint2                     │
│  → Discord PUMPFUN_DISCORD_CHANNEL_ID                                │
│  ✗ Does NOT enter TokenIntelligenceOrchestrator (by design, Phase 2) │
└──────────────────────────────────────────────────────────────────────┘

┌─ PROCESS B: npm run dev ─────────────────────────────────────────────┐
│  src/index.ts                                                        │
│  Helius WSS → enabled config.liquidity_pool programs                 │
│  Filter: CreatePool (currently “pumpswap”-labeled pool)              │
│                                                                      │
│  On mint extracted:                                                  │
│    1) dispatchTokenIntelligence(...)   ← fire-and-forget (Phase 2)   │
│    2) existing Discord / rug / simulation trade flow (unchanged)     │
│    3) PnL periodic checks via Discord client                         │
│  Metrics: METRICS_PORT /metrics                                      │
└───────────────────────────────┬──────────────────────────────────────┘
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
└──────────────────────────────────────────────────────────────────────┘
```

**Rule:** listeners are event sources. Analysis lives under `src/intelligence/**`. Discord alerts and intelligence are parallel—not substitutes.

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
| **5+** | Chroma/RAG, notifications, presentation API | Not started |

Phase briefs live in `phase2.txt`, `phase3.txt`, `phase3-1.txt` (historical prompts).

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
- `src/intelligence/workers/bundleSniperResearcher.ts` — now backed by Phase 5 via the injected lookup service; researcher receives safe statuses (PENDING, RUNNING, PARTIAL, COMPLETE, FAILED) rather than making heavy RPC calls

Database migrations (additive):

- `prisma/migrations/20260826051447_add_solana_forensics` — creates SolanaForensicsJob, SolanaForensicsRun, SolanaForensicsEvidence, SolanaWalletCluster, SolanaWalletClusterMember, SolanaTokenEligibilityAssessment, and SolanaForensicsError tables plus indexes and foreign keys (Phase 5D)
- `prisma/migrations/20260826070752_add_forensics_intelligence_linkage` — adds linkage and summary columns to `TokenIntelligenceReport` and reconciliation columns on runs to support Phase 5E integration

Behavior and boundaries

- Mandatory deterministic policy enforced: tokens meeting the configured bundled/holding thresholds are marked EXCLUDED and must never become recommendation candidates. The repository encodes the non-negotiable rule (e.g., initialBundledAcquisitionPct >= 40 OR currentBundleWalletHoldingsPct >= 40 => EXCLUDED).
- Phase 5 is read-only research: no swaps, buys/sells, signing, or execution logic were added. The heavy analyzer (SolanaForensicsClient implementation) runs inside the dedicated `forensics:worker` process; researchers and orchestrator never call it directly.
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

### 4.2 Pool / “pumpswap”-labeled CreatePool — `npm run dev`

| Item | Detail |
|------|--------|
| File | `src/index.ts` |
| Config | `config.liquidity_pool[0]`: name `"pumpswap"`, **program = Pump.fun bonding program**, instruction `CreatePool` |
| Real PumpSwap AMM | `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` in `pumpSwapService.ts` — **not subscribed yet** |
| Discord | `sendTokenAlert` → `DISCORD_CHANNEL_ID` (still filters `mint.endsWith("pump")`, MC ≥ $15k) |
| Intelligence | `dispatchTokenIntelligence(signature, mint, matchedPool.program, rawWsValue)` after mint extract |
| Trading | `rug_check.simulation_mode: true` → no Jupiter buy |

### 4.3 Other processes

| Script | Entry | Notes |
|--------|-------|-------|
| `npm run pumpfun15k` | Wrong path in `package.json` (`src/discord-pumpfun-15k.ts`); real file is `src/discord/discord-pumpfun-15k.ts` | Broken script |
| `npm run tracker` | SQLite holdings TP/SL | Legacy |
| `npm run server` | Older Express + WS | Overlaps `index.ts` |

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

Sources are never guessed from the config **name** `"pumpswap"`.

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
| Metadata | `workers/metadataResearcher.ts` | Moralis via `tokenDataService`; Pump.fun frontend via `pumpFunSocialClient`; optional on-chain migration check when source is PUMPSWAP/MIGRATION |
| Market | `workers/marketResearcher.ts` | Moralis price/metadata/swaps (+ Birdeye volume/liquidity fallbacks in token data path) |
| Safety | `workers/safetyResearcher.ts` | **Read-only** `safetyCheckService` (RugCheck + SolSniffer). Never imports `transactions.ts` |
| Social | `workers/socialResearcher.ts` | Links already present on metadata / pump.fun frontend payload |
| Bundle/sniper | `workers/bundleSniperResearcher.ts` | **UNAVAILABLE** / `INTERNAL_FORENSICS_PENDING`, confidence `0`, no zero-valued “safe” percentages (Phase 3.1) |
| AI synthesis | `workers/aiSynthesisAgent.ts` | Calls `anthropicSynthesisProvider`; maps failures to safe UNKNOWN assessment |

### 5.5 Anthropic provider (Phase 3)

File: `src/intelligence/providers/anthropicSynthesisProvider.ts`

- Official `@anthropic-ai/sdk`, Messages API, **zero tools**
- Env: `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (default `claude-haiku-4-5-20251001`), `ANTHROPIC_TIMEOUT_MS`, `ANTHROPIC_MAX_TOKENS`
- Strict structured output + local Zod validation
- Prompt-injection treated as untrusted data
- Local reject of prohibited trading language
- Retries only for 429 / retryable 5xx
- Telemetry persisted on report: provider, model, prompt/schema versions, latency, tokens, validation status, failure reason
- Unconfigured key → `NOT_CONFIGURED`; deterministic report still usable

### 5.6 Persistence (Prisma)

Migrations:

- `20250324020906_init` — Wallet / TokenAlert / PumpFunToken / …
- `20260825013814_add_token_intelligence` — intelligence tables
- `20260825022923_add_ai_synthesis_meta` — AI telemetry columns

Models:

- `TokenIntelligenceReport` — upsert by unique `eventId`
- `TokenIntelligenceEvidence` — category + JSON payload
- `TokenIntelligenceError` — per-worker messages + fatal flag

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

`removedMoralisEndpoint(feature)` returns typed `ENDPOINT_REMOVED`. Missing data ≠ zeros ≠ “safe”.

`tokenDataService.ts` is rebuilt on the shared client for intelligence/Discord market enrichment.

---

## 7. trench.bot removal (Phase 3.1)

| Item | Status |
|------|--------|
| `src/services/trenchClient.ts` | **Deleted** |
| Intelligence bundle worker | No HTTP; UNAVAILABLE stub |
| Discord / PnL paths | Must not call trench (cleaned in 3.1 commit) |
| Future forensics | Internal analyzer (not built); missing evidence blocks any future ELIGIBLE/safe policy |

---

## 8. Safety / execution boundary

### Intelligence danger zone (must never import)

Documented in `src/intelligence/README.md`:

- `src/transactions.ts` (even rug helpers have trading-tracker side effects)
- `sniperooService`, `tradingService`, `buyToken`, `jito`
- Tracker DB writers
- Discord modules that `client.login` at import time
- Wallet / private-key env material in Anthropic prompts

Safety HTTP lives in `src/services/safetyCheckService.ts` (read-only clone of rug/sniffer fetches).

### Legacy trading still exists (separate)

- Jupiter swap/sell in `transactions.ts`
- Sniperoo wallets/commands
- Dead `handleWebsocketMessage` auto-buy in `index.ts` (not hooked to live WS)
- `config.rug_check.simulation_mode: true` and `rugSafe.simulation_mode: true`

**Intelligence cannot submit a transaction.** Do not treat the whole monorepo as safe for unattended trading without a separate audit.

---

## 9. Source map (current)

```text
src/
├── index.ts                          # Pool CreatePool listener + Discord + intel dispatch
├── pumpfun-sniper.ts                 # New mint Discord only
├── config.ts                         # Pools, fees, simulation, sniperoo
├── transactions.ts                   # Legacy tx / swap / rug gate (danger for intel)
├── intelligence/
│   ├── types.ts
│   ├── orchestrator.ts
│   ├── reportStore.ts
│   ├── providers/anthropicSynthesisProvider.ts
│   ├── workers/{metadata,market,safety,social,bundleSniper,aiSynthesis}Researcher*.ts
│   └── __tests__/                    # Vitest (mocked network)
├── services/
│   ├── tokenIntelligenceDispatch.ts
│   ├── moralisClient.ts
│   ├── tokenDataService.ts
│   ├── safetyCheckService.ts
│   ├── pumpFunSocialClient.ts
│   ├── pumpSwapService.ts            # AMM IDs + helpers (listener not fully wired)
│   ├── sniperDataService.ts          # Retired endpoint → null
│   ├── tokenTrackingService.ts       # PnL / Discord summaries
│   ├── sniperooService.ts / tradingService.ts  # Legacy execution
│   └── prismaClient.ts
├── discord/                          # Alert bots (import-time login)
├── tracker/                          # SQLite holdings
└── pumputils/                        # Bonding-curve buy helpers (legacy)
prisma/schema.prisma
```

---

## 10. Discord surface (unchanged role)

| Module | Channel env | Trigger |
|--------|-------------|---------|
| `discord/discord.ts` | `DISCORD_CHANNEL_ID` | Pool CreatePool via `index.ts` |
| `discord/discord-pumpfun.ts` | `PUMPFUN_DISCORD_CHANNEL_ID` | New mint via `pumpfun-sniper` |
| `discord/discord-pumpfun-15k.ts` | `PUMPFUN_15K_DISCORD_CHANNEL_ID` | 15k MC poll |
| PnL / daily summary | `PNL_*` / `DISCORD_PNL_SUMMARY_*` | Periodic from `index.ts` |

Intelligence does **not** post Discord alerts yet.

---

## 11. Commands & verification

```bash
npm install
npx prisma generate
npx prisma migrate deploy

npm run build                 # tsc
npx vitest run                # full mocked suite
npm run test:intelligence     # intelligence subset
npx prisma@6.5.0 validate

npm run dev                   # listener + Discord + intelligence dispatch
npm run pumpfun               # Pump.fun mint Discord only
```

Phase 3.1 verification expectation (from README): TypeScript build OK, ~52 tests / 6 files, Prisma validate OK, no trench URLs, no removed Moralis paths, no leftover `__smoke_test_*` files.

Prefer `npm` / `npx` for scripts in this environment if Yarn Berry resolves incorrectly.

---

## 12. Environment (names only)

See `.env.example` for Anthropic names. Also used depending on process:

| Area | Keys |
|------|------|
| DB | `DATABASE_URL` |
| RPC | `HELIUS_HTTPS_URI`, `HELIUS_WSS_URI`, `HELIUS_HTTPS_URI_TX`, `GEYSER_RPC`, `RPC_ENDPOINT*` |
| Moralis | `MORALIS_API_KEY`, optional `MORALIS_TIMEOUT_MS` |
| Discord | `DISCORD_BOT_TOKEN`, channel IDs |
| AI | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_TIMEOUT_MS`, `ANTHROPIC_MAX_TOKENS` |
| Legacy trade | Jupiter URLs, `PRIV_KEY_WALLET`, Sniperoo, etc. |

Never commit real values. Never log API keys.

---

## 13. Known gaps (still true)

1. Config pool named `"pumpswap"` still listens to **Pump.fun program**, not `pAMMBay…` → intelligence `source` is usually `UNKNOWN`.
2. `pumpSwapService` helpers exist but are not the active subscribe target.
3. `sendTokenAlert` still skips non-`pump` mints.
4. `pumpfun15k` npm script path is wrong.
5. Bundle/sniper forensics pending → reports typically `PARTIAL`.
6. No Chroma/RAG, no intelligence notifications, no X monitor.
7. `swap.amount: "1000000"` is **0.001 SOL**, not 0.1 SOL (comment wrong); simulation stays on.
8. Multiple Discord clients may login the same bot token from separate processes.

---

## 14. Suggested next work

1. Subscribe to real PumpSwap AMM (`pAMMBay…`) **in addition to** current CreatePool watch; keep Pump.fun mint process separate.  
2. Internal bundle/sniper/dev/insider forensics + hard eligibility (missing forensics ⇒ not ELIGIBLE).  
3. Chroma semantic projection (Postgres remains source of truth).  
4. Optional: intelligence Discord/API presentation; do not auto-trade.  
5. Fix `pumpfun15k` script path when touching scripts.

---

## 15. One-line truth

**`npm run dev` still alerts Discord on CreatePool while also dispatching a non-blocking, read-only Token Intelligence pipeline (Moralis/RugCheck/social + Anthropic synthesis → Prisma). Pump.fun mint alerts remain a separate process. Trading stays simulation-gated and unreachable from intelligence. Bundle forensics and Chroma are not built yet—absence is recorded as unavailable, not as safety.**
