# Architecture & Handoff Guide

> Source of truth for how this repository works **today** (Phases **1–3.1**).  
> Companion docs: [README.md](./README.md) (operator overview), [src/intelligence/README.md](./src/intelligence/README.md) (intelligence danger zone).

**Snapshot date:** 2026-08-25  
**Latest intelligence commit family:** `feat: add token intelligence phase 3.1` (`54d5772`)

**Stack:** TypeScript / Node 18+, Solana Web3.js, Discord.js v14, Prisma + PostgreSQL, SQLite holdings tracker, Express metrics, Helius RPC/WSS, Geyser WSS, Moralis (supported REST only), DexScreener/Birdeye fallbacks, RugCheck/SolSniffer, Jupiter (legacy trading only), Anthropic Claude (AI synthesis), Vitest.

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
| **4+** | Chroma/RAG, forensics, notifications, presentation API | Not started |

Phase briefs live in `phase2.txt`, `phase3.txt`, `phase3-1.txt` (historical prompts).

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
