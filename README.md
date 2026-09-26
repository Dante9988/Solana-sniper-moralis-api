# 🎯 OnlyPump backend (Solana-sniper-moralis-api)

The backend for [OnlyPump](https://github.com/Dante9988/only-pump-me). It has two halves:

- **Robinhood Chain / Pons discovery and paper trading.** This half serves the web app today.
  - Ingestion workers index Pons V1 and V2 launches, trades and graduations into PostgreSQL, and a candle worker aggregates OHLCV.
  - The `/api/v1` gateway serves discovery, token detail, candles and block-pinned market evidence.
  - It also serves **quotes verified against the real contracts on a fork**, route simulations, immutable evidence snapshots and per-user **paper positions**.
  - Nothing in this path signs or broadcasts a transaction.
- **Solana token intelligence.** Event-driven Pump.fun/PumpSwap listeners with Discord alerts, deterministic research, forensics, and optional Anthropic synthesis into `RESEARCH_ONLY` reports. A legacy non-custodial Telegram/Discord trading surface also lives here (see `ARCHITECTURE.md` §8).

| Document | Read it for |
|---|---|
| [AGENTS.md](./AGENTS.md) | Permanent PR evidence requirements, artifact review, and completion gate |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | How everything works today, phase by phase (Robinhood/Pons: §19–§21, §23–§26) |
| [RUNBOOK.md](./RUNBOOK.md) | Running the API, workers and frontend locally |
| [docs/phase-7d3-2-quote-verification.md](./docs/phase-7d3-2-quote-verification.md) | Why quotes can be trusted: sources, contract identities, fork evidence |
| [evm-verification/README.md](./evm-verification/README.md) | The Foundry harness |
| [PHASE_7D_ROBINHOOD_V2_AND_LAUNCHPAD.md](./PHASE_7D_ROBINHOOD_V2_AND_LAUNCHPAD.md) | Pons V2 / Uniswap V4 ingestion |
| [src/intelligence/README.md](./src/intelligence/README.md), [src/forensics/README.md](./src/forensics/README.md), [src/assets/README.md](./src/assets/README.md) | Solana intelligence, forensics, canonical assets |

## 🏗️ Current architecture

```text
Robinhood Chain RPC (HTTPS/WSS, multi-key failover)
  ├─ npm run pons:worker     Pons V1/V2 launches, trades, graduation → PostgreSQL (checkpoints, reorg recovery)
  ├─ npm run candles:worker  ChainTrade → MarketCandle
  └─ npm run api             /api/v1 on :8787
        discovery, token detail, candles, source health           (DB reads)
        quotes, simulations, market evidence                      (block-pinned chain reads)
        evidence snapshots, /me/paper-positions                   (Postgres, Supabase auth)
        token logos                                               (in-process cache worker)

Solana listener (npm run dev)
  -> TokenDiscoveryEvent -> bounded dispatcher -> deterministic researchers
  -> Anthropic synthesis (optional) -> TokenIntelligenceReport (Prisma)
  -> forensics:worker (opt-in) -> /api/v1/tokens/:mint/{report,forensics,scans}
```

## 🚀 Quick start (Robinhood Chain stack)

```bash
npm install
cp .env.example .env          # set DATABASE_URL, ROBINHOOD_*, PONS_*, SUPABASE_URL
npx prisma generate
npx prisma migrate deploy
scripts/dev-stack.sh start    # api + pons + candles, supervised
curl -s localhost:8787/api/v1/tokens/robinhood/status
```

Then start the frontend with `VITE_API_BASE_URL=http://localhost:8787/api/v1 npm run dev` in `only-pump-me`, and open `http://localhost:8080`. See [RUNBOOK.md](./RUNBOOK.md).

## 🧠 Solana token intelligence (Phases 1–4)

### 📡 Event model

`TokenDiscoveryEvent` records:

- Event ID, signature, and mint
- Evidence-based source classification: `PUMPFUN`, `PUMPSWAP`, `MIGRATION`, or `UNKNOWN`
- Discovery and receipt timestamps
- Original listener payload

Sources are never guessed. If the observed program cannot prove the event source, it is classified as `UNKNOWN`.

### 🔬 Deterministic researchers

The orchestrator isolates each researcher so one provider failure cannot crash the listener or discard other evidence.

| Researcher | Current sources and behavior |
|---|---|
| Metadata | Moralis metadata, Pump.fun frontend metadata, and on-chain migration corroboration where applicable |
| Market | Moralis price/metadata/swaps with Birdeye volume and liquidity fallback |
| Safety | Read-only RugCheck with SolSniffer fallback; no imports from transaction or wallet code |
| Social | Normalized public links already obtained through metadata research |
| Bundle/sniper | Explicitly `UNAVAILABLE` with source `INTERNAL_FORENSICS_PENDING` and confidence `0` |

Missing analysis is represented as unknown, never as zero-valued evidence of safety.

### 🚦 Report status

Every report has one processing status:

- ✅ `COMPLETE`: all required research and configured synthesis completed without errors
- ⚠️ `PARTIAL`: useful deterministic evidence exists, but a source or synthesis step was unavailable
- ❌ `FAILED`: no usable deterministic research was produced

An AI failure can downgrade `COMPLETE` to `PARTIAL`, but AI success can never upgrade a deterministically failed report.

### 🤖 Anthropic synthesis

Anthropic is the only runtime synthesis provider. The implementation uses the official TypeScript SDK and native Messages API with zero tools.

The model receives normalized research fields only and returns:

```ts
{
  narrative: string;
  category: string | null;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | "UNKNOWN";
  confidence: number;
  positiveSignals: string[];
  riskFactors: string[];
  reasons: string[];
  missingInformation: string[];
  dataQualityWarnings: string[];
  recommendation: "RESEARCH_ONLY";
}
```

Controls include:

- Anthropic Structured Outputs plus local Zod validation
- Prompt-injection boundaries for token metadata, websites, socials, and other researched content
- Local rejection of prohibited trading language
- No buy/sell advice, targets, position sizing, holding periods, or profit predictions
- No claims that a token is guaranteed safe, legitimate, or profitable
- Bounded exponential retry for retryable rate limits and transient server errors only
- Typed handling for authentication failures, timeouts, refusals, malformed output, schema errors, and prohibited content
- Persistence of provider/model/schema versions, latency, token usage, completion time, validation status, and failure reason

If Anthropic is unconfigured or fails, the deterministic report remains usable and the assessment safely falls back to `UNKNOWN` and `RESEARCH_ONLY`.

## 🔌 Moralis compatibility

The project uses the supported Solana gateway host:

```text
https://solana-gateway.moralis.io
```

Retained, validated endpoint families:

- `GET /token/{network}/{address}/metadata`
- `GET /token/{network}/{address}/price`
- `GET /token/{network}/{address}/swaps`
- `GET /token/{network}/{address}/pairs`
- `GET /token/{network}/pairs/{pairAddress}/stats`

The shared client enforces timeouts, maximum response size, Zod response validation, nullable-field handling, retrieval timestamps, and typed failure classification. Only `429` and retryable `5xx` responses are retried.

Removed Moralis REST features are not called or silently replaced:

- Holders, top holders, and historical holders
- Pair sniper analysis
- Legacy discovery and volume endpoints
- Exchange new/bonding/graduated endpoints
- Bonding-status endpoint
- Solana Token Score endpoints and metadata `score`

Unsupported evidence returns a typed `ENDPOINT_REMOVED` or `UNAVAILABLE` result. Moralis Data Feeds are intentionally not adopted in this phase.

## 🔍 Bundle and sniper analysis

trench.bot and the retired Moralis sniper endpoint have been removed from runtime paths. The general report contract remains available:

- Status and source
- Findings
- Evidence
- Confidence
- Errors
- Optional bundle/sniper percentages when future evidence supports them

Until internal forensics is built, the worker returns `INTERNAL_FORENSICS_PENDING`, empty findings/evidence, confidence `0`, and no synthetic percentages. This makes the overall report `PARTIAL`.

Internal forensics now exists (Phases 5A–5E, `src/forensics/`). The researcher still returns `INTERNAL_FORENSICS_PENDING` at dispatch time. When `FORENSICS_ENQUEUE_ENABLED` and `FORENSICS_RECONCILIATION_ENABLED` are on, the separate `forensics:worker` runs later and its results are reconciled onto the report (`ARCHITECTURE.md` §3).

## 🪪 Canonical assets and observations

Canonical asset identity is the chain ID plus normalized address. Solana public keys remain case-sensitive. EVM addresses normalize to lowercase and require an explicit Ethereum or BNB Smart Chain selection; a bare EVM address returns an ambiguous-chain result. Ticker and name never determine identity.

PostgreSQL stores canonical research assets and idempotent observations. SQLite remains the legacy actual-position tracker. `POSITION` observations are reserved and cannot be persisted by the research store, so discoveries never become fake holdings.

Phase 4 provides types, resolution, a pure `TokenDiscoveryEvent` adapter, provider-neutral market observations, and a controlled Prisma store. It adds no listener integration, polling scheduler, live Ethereum/BNB provider, or execution capability.

## 🛡️ Safety boundary

The intelligence layer is read-only. It must not import or access:

- Wallets, private keys, or keypairs
- Signing or transaction construction
- Buying, selling, swaps, or execution services
- Sniperoo
- Holdings or PnL writers
- Discord clients that connect at import time
- Shell, filesystem, Prisma/database, RPC, or Discord tools through Anthropic

The repository still contains legacy listener, Discord, wallet, tracker, and trading modules. Their presence does not grant the intelligence pipeline access to them. Automated execution should be treated as a separate danger zone and reviewed independently before use.

## 🗄️ Persistence

Prisma models store:

- Normalized token, social, market, safety, and bundle/sniper fields
- AI assessment and Anthropic request metadata
- Processing status and timestamps
- Evidence records grouped by category
- Worker errors and fatality flags

Reports are upserted by `eventId` so repeated persistence does not create duplicate reports.

## 📋 Requirements

- Node.js 20 (CI) and npm. Use `npm`, not Yarn.
- PostgreSQL 16.
- A Robinhood Chain RPC. Quotes and simulations need `eth_call` with state overrides; fork verification needs an archive RPC.
- A Supabase project (`SUPABASE_URL`) for signed-in routes such as paper positions.
- Foundry **1.8.1**, only for `evm-verification/`.
- Solana side, only for its processes: Helius RPC/WSS, Discord, Moralis, and optionally Anthropic.

## 🛠️ Installation

```bash
git clone https://github.com/Dante9988/Solana-sniper-moralis-api.git
cd Solana-sniper-moralis-api
npm install
cp .env.example .env
npx prisma generate
npx prisma migrate deploy
```

Never commit `.env`, API keys, wallet keys or credentials. Never put backend secrets (`API_KEYS`, `SUPABASE_SECRET_KEY`, Redis URLs) in the frontend.

## 🔐 Environment configuration

`.env.example` documents every name with no real values. The main groups:

| Group | Names |
|---|---|
| Database | `DATABASE_URL` |
| Robinhood Chain | `ROBINHOOD_CHAIN_ID`, `ROBINHOOD_RPC_HTTPS` / `_WSS`, failover `ROBINHOOD_RPC_HTTPS2`/`3`, `DEAFULT_RPC_HTTPS` (and WSS equivalents), `ROBINHOOD_EXPLORER` |
| Pons | `PONS_FACTORY`, `PONS_LOCKER`, `PONS_FACTORY_LEGACY`, `PONS_LOCKER_LEGACY`, `PONS_V2_FACTORY`, `WETH_QUOTE`, `PONS_*` polling/health tuning |
| API | `API_PORT` (8787), `API_PUBLIC_READS`, `API_KEYS`, `CORS_ALLOWED_ORIGINS`, `CORS_DEV_ORIGINS`, `RATE_LIMIT_BACKEND`, `REDIS_URL` |
| Auth | `SUPABASE_URL`, `SUPABASE_JWT_AUDIENCE` |
| Media | `TOKEN_IMAGE_IPFS_GATEWAYS` |
| Solana intelligence | `HELIUS_*`, `MORALIS_API_KEY`, `DISCORD_*`, `ANTHROPIC_*`, `FORENSICS_*`, `X_*` |

The full table is in `ARCHITECTURE.md` §12.

## ⚙️ Commands

```bash
npm run build                  # tsc
npx vitest run                 # default suite (1,111 passed / 82 skipped on 2026-09-14)
npm run openapi:check          # Zod contracts vs committed openapi.json
npm run api                    # /api/v1 gateway on :8787
npm run pons:worker            # Robinhood Chain ingestion
npm run candles:worker         # candle aggregation
scripts/dev-stack.sh start|stop|status|logs <svc>

# Opt-in DB suites — DISPOSABLE database only (name must contain test/ci/tmp as a word)
PAPER_RUN_DB_TESTS=true PONS_RUN_DB_TESTS=true npx vitest run --no-file-parallelism

# Foundry verification
cd evm-verification && scripts/install-deps.sh && forge test -vv
ROBINHOOD_FORK_RPC_URL=<archive RPC> scripts/fork-verify.sh

# Solana side
npm run dev                    # listener + Discord + Telegram bot (see ARCHITECTURE.md §0 first)
npm run pumpfun
npm run forensics:worker
npm run test:intelligence
```

All intelligence and provider tests mock network access. DB suites refuse to run against a non-disposable database (`ARCHITECTURE.md` §26.3).

## ✅ Verification status

As of 2026-09-14:

- **CI:** `build-and-test` (typecheck, OpenAPI drift, default and DB suites on a throwaway Postgres, anvil reorg proof, build) and `foundry-verification` (Foundry 1.8.1; 17/17 fork tests at block 62211539) are green on `main` (`b1de963`).
- **Quotes:** 68 of 68 fork quote rows equal the executed swap.
- **Browser acceptance:** paper positions passed 11/11 with two confirmed Supabase users (`ARCHITECTURE.md` §26.1).

## 🚧 Known limitations and next work

- **V2 trade ingestion stalls:** Pons V2 discovery polls 10 blocks at a time and is far behind the tip, so V2 trades and candles are not ingested (`ARCHITECTURE.md` §26.4). The earlier `ORPHANED` data damage was repaired on 2026-09-15.
- **Unsupported quote paths:** Swept, Rescued and Pons V1 tokens, and trades inside the 3-second snipe window.
- **No USD pricing on Robinhood Chain.**
- **Enrichment via `alchemy_getTokenMetadata` is pending.**
- **No real execution:** paper positions only.
- **Solana side:**
  - The Phase 4 asset store is not wired into listeners.
  - No live Ethereum/BNB providers.
  - No Chroma/RAG.
  - Legacy execution-capable code still exists and needs its own audit before any unattended use.

## ⚠️ Security and disclaimer

This software is experimental and intended for research and educational use. Cryptocurrency and automated trading can result in total loss. A token-intelligence report is incomplete evidence, not financial advice or a guarantee of safety, legitimacy, or profitability. Verify all findings independently and keep execution disabled unless you have reviewed and accepted the risks.

## 📚 Resources

- [Anthropic API documentation](https://docs.anthropic.com/)
- [Moralis Data API documentation](https://docs.moralis.com/)
- [Helius documentation](https://docs.helius.dev/)
- [Solana documentation](https://solana.com/docs)
- [Prisma documentation](https://www.prisma.io/docs)
