# 🎯 Solana Sniper and Token Intelligence Platform

An event-driven Solana listener with Discord alerts, legacy trading utilities, and a new read-only token-intelligence pipeline. The intelligence layer researches newly discovered tokens, persists normalized reports, and optionally uses Anthropic Claude to synthesize evidence into a constrained `RESEARCH_ONLY` assessment.

The current intelligence implementation covers Phases 1–4:

- Event normalization and non-blocking listener dispatch
- Deterministic metadata, market, social, and safety research
- Prisma-backed report and evidence persistence
- Anthropic structured-output synthesis with strict safety boundaries
- Moralis API compatibility cleanup for the 2026 endpoint removals
- Removal of trench.bot from runtime paths
- Canonical Solana/Ethereum/BNB asset identity and durable research observations

Later features such as Chroma/RAG, trending tracking, macro/news ingestion, X ingestion, live EVM providers, portfolios, and internal bundle/wallet-cluster forensics are not implemented.

## 🏗️ Current architecture

```text
Solana listener
  -> TokenDiscoveryEvent
  -> bounded, non-blocking dispatcher
  -> deterministic researchers
       metadata
       market
       safety
       social
       bundle/sniper (currently UNAVAILABLE)
  -> Anthropic synthesis (optional)
  -> TokenIntelligenceReport
  -> Prisma persistence
```

The listener does not wait for intelligence processing. Dispatch is deduplicated, concurrency-bounded, timeout-isolated, and protected against synchronous errors and unhandled promise rejections.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the broader legacy application map and [src/intelligence/README.md](./src/intelligence/README.md) for intelligence-specific boundaries.

The Phase 4 asset foundation is documented in [src/assets/README.md](./src/assets/README.md). It is intentionally not connected to an active listener or tracker yet.

## 🧠 Token intelligence

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

- Node.js 18 or newer
- npm
- PostgreSQL for intelligence report persistence
- Solana RPC/WSS configuration for listeners
- Discord configuration for alerts
- Moralis API key for supported market/metadata enrichment
- Anthropic API key only when live AI synthesis is desired

## 🛠️ Installation

```bash
git clone https://github.com/Dante9988/Solana-sniper-moralis-api.git
cd Solana-sniper-moralis-api
npm install
cp .env.example .env
npx prisma generate
npx prisma migrate deploy
```

Never commit `.env`, API keys, wallet keys, or credentials.

## 🔐 Environment configuration

The committed `.env.example` contains names and non-secret defaults for Anthropic synthesis:

```dotenv
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-haiku-4-5-20251001
ANTHROPIC_TIMEOUT_MS=15000
ANTHROPIC_MAX_TOKENS=1024
```

Existing runtime components may also require these names, depending on which process is started:

- `DATABASE_URL`
- `MORALIS_API_KEY`
- `HELIUS_HTTPS_URI`, `HELIUS_WSS_URI`, `HELIUS_HTTPS_URI_TX`
- `DISCORD_BOT_TOKEN`, `DISCORD_CHANNEL_ID`
- PnL and summary Discord channel IDs
- Jupiter and DexScreener endpoint variables
- Legacy wallet variables for explicitly enabled execution paths

Do not place real values in `.env.example`.

## ⚙️ Commands

```bash
# Compile TypeScript
npm run build

# Run every mocked test
npx vitest run

# Run only token-intelligence tests
npm run test:intelligence

# Validate the Prisma schema
npx prisma@6.5.0 validate

# Start the primary listener
npm run dev

# Start the Pump.fun listener
npm run pumpfun

# Start token tracking
npm run tracker

# Start the 15k monitor
npm run pumpfun15k

# Start the development server
npm run server:dev
```

All intelligence and provider tests mock network access. Tests do not call Moralis, Anthropic, RugCheck, SolSniffer, Pump.fun, or other live services.

## ✅ Verification status

The latest Phase 4 verification covers:

- TypeScript production build passing
- Canonical resolution, ambiguous EVM chains, observation validation, idempotent mocked persistence, and execution-boundary tests
- Prisma 6.5 schema validation
- No active trench.bot URL or client
- No active removed Moralis endpoint calls
- No temporary Anthropic smoke-test files or background listener processes

Native bigint bindings may emit a warning during tests and fall back to their pure-JavaScript implementation.

## 🚧 Known limitations and next work

- The Phase 4 asset store is not wired into listeners or the intelligence orchestrator yet.
- Live Ethereum and BNB data providers are not implemented.
- Internal bundle, sniper, developer, insider, and wallet-cluster forensics are pending.
- Hard eligibility policy is pending; missing forensic evidence must prevent a future `ELIGIBLE` or safe conclusion.
- Chroma/RAG, trending history, macro/news research, and X ingestion are not implemented.
- Optional live provider smoke tests require explicit credentials and are not part of the mocked suite.
- Some legacy analytics paths still use zero-valued presentation fallbacks; intelligence reports preserve unavailable evidence separately.
- The broader repository includes legacy execution-capable code and should not be treated as safe for unattended trading without a separate audit.

## ⚠️ Security and disclaimer

This software is experimental and intended for research and educational use. Cryptocurrency and automated trading can result in total loss. A token-intelligence report is incomplete evidence, not financial advice or a guarantee of safety, legitimacy, or profitability. Verify all findings independently and keep execution disabled unless you have reviewed and accepted the risks.

## 📚 Resources

- [Anthropic API documentation](https://docs.anthropic.com/)
- [Moralis Data API documentation](https://docs.moralis.com/)
- [Helius documentation](https://docs.helius.dev/)
- [Solana documentation](https://solana.com/docs)
- [Prisma documentation](https://www.prisma.io/docs)
