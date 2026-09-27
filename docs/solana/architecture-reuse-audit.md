# Solana architecture reuse audit (Checkpoint 2)

Inspected 2026-09-26, before writing any Solana code, per Parts B/X/Y of `phase7e.4.1.txt`.
Every status below comes from reading the file and its callers, or from calling the endpoint.

## The finding that blocks everything else

**`quote-api.jup.ag` no longer exists.** Not blocked, not transient — the domain does not
resolve, while Jupiter's current hosts resolve fine from the same machine seconds apart:

```
quote-api.jup.ag  -> DNS ENOTFOUND          <- jupiterService.ts depends on this
lite-api.jup.ag   -> 52.85.151.45           200, 1 SOL -> 12.036937 USDC, 1 route
api.jup.ag        -> 65.8.180.59            200, 1 SOL -> 12.037453 USDC, 1 route
```

`src/services/jupiterService.ts` calls `https://quote-api.jup.ag/v6/quote` and
`/v6/swap`. Both are dead. The service cannot have worked since that host was retired, and
any Solana execution built on it today would fail on its first call.

Current shape, verified by calling it: `GET {base}/swap/v1/quote?inputMint&outputMint&amount&slippageBps`
returning `outAmount` and a `routePlan`. `lite-api` is the keyless tier; `api.jup.ag` is the
keyed one. The brief's instruction applies exactly as written — *upgrade the existing service
cleanly*, do not write a second one.

## File-by-file

| File | Lines | Responsibility | Callers | Verdict |
|---|---|---|---|---|
| `services/jupiterService.ts` | 470 | Quote + unsigned swap transaction for an owner pubkey | **Heavy**: `api/index.ts`, `buying/providers/jupiterProvider.ts`, 12 Telegram files, 4 Discord files, `solanaPayService` | **ACTIVE, BROKEN** — refactor in place onto `/swap/v1`. Do not duplicate. |
| `services/solanaPayService.ts` | 174 | Buy/sell intents, `buildTransactionForAccount` | Telegram buy/sell, Discord buy/sell, `api/index.ts` | **ACTIVE** — keep. Part E says browser trading and Solana Pay may share one backend builder. |
| `services/pumpswapService.ts` | 278 | Program IDs, bonding-curve completion, migration verification | `index.ts`, `telegram/commands/pumpSettings.ts`, `pumpSwapDetection` | **ACTIVE (detection only)** — keep detection. Part H: do not resurrect its direct swap builders. |
| `services/pumpSwapDetection.ts` | 157 | Re-exports the same detection surface | `tokenIntelligenceDispatch`, `intelligence/workers/metadataResearcher` | **DUPLICATE** — its ten exports are the same names `pumpswapService` exports. Consolidate to one. |
| `services/tradingService.ts` | 273 | Legacy server-side `Keypair` signing | **Tests only** — nine `executionBoundary` / boundary suites and no production caller | **LEGACY UNUSED** — safe to deprecate. The boundary tests exist to keep it unused; keep them. |
| `pump/eventWalker.ts`, `instructionAccounts.ts`, `normalizeTrade.ts`, `eventDecoder.ts`, `discriminators.ts`, `borshReader.ts` | — | Pump.fun / PumpSwap event decoding, instruction account resolution, canonical trade normalisation | `pump` tests | **ACTIVE, REUSE** — Part I is explicit: do not build another Pump parser. |

`tradingService` being reachable only from boundary tests is the good outcome: Part D's
"no server-side user signing" rule is already enforced by tests, not just by intent.

## Data state

- `DiscoveredToken`: 144,225 rows, **100% `robinhood`/`pons_v2`**. No Solana rows.
- `PumpFunToken`: 0 rows. `PumpTrade`: 1 row, from 2026-09-04.
- So the decoders exist and are tested, but nothing is ingesting.

## RPC

`SOLANA_RPC_ENDPOINT` (Alchemy mainnet) and `SOLANA_DEVNET_RPC_ENDPOINT` both answer
`getSlot` in ~200ms. Helius is not configured anywhere — `HELIUS_API_KEY` and
`HELIUS_RPC_URL` are both unset, so there is nothing to remove.

## Frontend

`useMarketTokens` has `fetchesRobinhood = filters.chain !== "solana"` and disables the query
for Solana, so selecting Solana fetches nothing by design (Part R asks for this to go). The
Solana wallet adapter packages are already dependencies (`@solana/wallet-adapter-react`,
`-wallets`, `-react-ui`), and `contexts/WalletProvider.tsx` exists — so the browser signing
side has a foundation, unlike the backend quoting side.

## What has to happen, in order

1. **Repair `jupiterService`** onto `/swap/v1` — nothing Solana can be quoted until this works.
   Its 20-odd Telegram/Discord/API callers make this a refactor, not a rewrite.
2. **Consolidate** `pumpSwapDetection` into `pumpswapService`; migrate its two callers.
3. **Deprecate** `tradingService`, keeping the boundary tests that pin it unused.
4. **Solana discovery** — feed the existing `pump/*` decoders into `DiscoveredToken` with
   `chain = 'solana'`, rather than a parallel model.
5. **Solana execution venue** implementing the same `SpotExecutionVenue` contract, Jupiter-first
   per Part G, behind `SOLANA_REAL_TRADING_ENABLED` (default false).
6. **Frontend** — remove the Solana fetch block, then wire chain into cards and terminal.

Nothing here has been implemented yet. Step 1 is the prerequisite for every other step.
