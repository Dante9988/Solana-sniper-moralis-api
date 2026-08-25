# Token Intelligence Layer — Phase 3

Read-only research/reporting layer. Never enables or performs buying,
selling, swaps, signing, wallet funding, or private-key access.

## What's delivered so far

- `types.ts` — `TokenDiscoveryEvent`, `TokenIntelligenceReport`, worker contract,
  `AiSynthesisMeta`/`AiSynthesisValidationStatus` (Phase 3).
- `orchestrator.ts` — `TokenIntelligenceOrchestrator` / `processTokenDiscoveryEvent()`.
  Runs metadata/market/safety/bundleSniper workers in parallel, social after
  metadata, isolates failures per worker (`processing.status`:
  `COMPLETE` | `PARTIAL` | `FAILED`), then runs AI synthesis. A failed/timed-out/
  refused/malformed/rejected AI call degrades an otherwise-`COMPLETE` report to
  `PARTIAL` (Phase 3) but can never turn a `FAILED` report into anything else.
- `workers/` — `metadataResearcher`, `marketResearcher`, `safetyResearcher`,
  `bundleSniperResearcher` (real data, no scoring), `socialResearcher` (real,
  backed by existing/new read-only services); `aiSynthesisAgent` (Phase 3 —
  real Anthropic-backed synthesis via `providers/anthropicSynthesisProvider.ts`,
  degrades gracefully to a safe `UNKNOWN`/`RESEARCH_ONLY` result on any failure).
- `providers/anthropicSynthesisProvider.ts` (Phase 3) — the only code that
  talks to the Anthropic Messages API. Zero tools, strict Zod-validated
  structured output, bounded-retry only on 429/5xx, a local trading-language
  guard, and full failure-mode classification (auth/timeout/refusal/rate-limit/
  malformed/prohibited-content/not-configured). `ANTHROPIC_API_KEY` is only
  ever passed to the SDK client constructor — never logged, echoed, or persisted.
- `reportStore.ts` — best-effort Prisma persistence, upserts on `eventId`.

Wired into the `yarn dev` pool/migration listener non-blocking via
`src/services/tokenIntelligenceDispatch.ts` (Phase 2).

## Danger zone

Code under `src/intelligence/**` and its supporting service files
(`src/services/safetyCheckService.ts`, bundle/sniper worker,
`pumpFunSocialClient.ts`, `prismaClient.ts`, `tokenIntelligenceDispatch.ts`)
must never import, directly or transitively:

- `src/transactions.ts` (the whole file — not just `createSwapTransaction`/
  `createSellTransaction`; even the file's `getRugCheckConfirmed` writes to
  the trading tracker DB as a side effect, which is why
  `safetyCheckService.ts` re-implements the read-only HTTP calls instead)
- `src/services/sniperooService.ts`, `src/services/tradingService.ts`
- `src/pumputils/utils/buyToken.ts`, `src/utils/jito.ts`
- `src/tracker/db.ts` writers, `src/tracker/index.ts`
- `src/index.ts` `processTransaction()`/`handleWebsocketMessage()`,
  `src/server.ts` `processTransaction()` and its `/api/update-config` route
- `src/discord/discord.ts`, `discord-pumpfun.ts`, `discord-pumpfun-15k.ts`
  (each instantiates a live Discord client at import time)
- `src/test.ts`
- Any `PRIV_KEY_WALLET` / `RUGCHECK_PRIVATE_KEY` / wallet keypair loading

Also: the Anthropic client must receive zero `tools` and must never see
`RUGCHECK_PRIVATE_KEY` / wallet keypair material in its prompt — only the
normalized `TokenIntelligenceReport` partial (token/socials/market/safety/
bundlesAndSnipers) and the event's `mint`/`source`.

## Testing

`yarn test:intelligence` (vitest). All external services (including the
Anthropic SDK) are mocked — no network calls, no live DB, no real API key
required. See `__tests__/` in each subfolder.
