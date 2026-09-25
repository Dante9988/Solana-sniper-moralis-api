# Phase 7E.1 — architecture map and first checkpoint

Inspection of both repositories at the commits below, before any 7E implementation.
Every claim here was read out of the working tree, the Prisma schema or the dev database
on 2026-09-25; nothing is recalled.

| | |
|---|---|
| Backend | `Dante9988/Solana-sniper-moralis-api` @ `e827bff` (main, PR #25, Phase 7D.6) |
| Frontend | `Dante9988/only-pump-me` @ `ce7f98a` (main, PR #15, Phase 7D.6) |
| Backend baseline | 1365 passed / 154 skipped across 146 files (`npx vitest run`) |
| Frontend baseline | 347 passed across 46 files (`npx vitest run`) |
| Chain | Robinhood Chain mainnet, `chainId` 4663, native gas ETH |

## 1. Existing quote/simulation functionality that can be reused

Phase 7D.3.2 already built, and fork-verified, most of the read side of the pipeline the
7E brief describes. The execution venue abstraction should wrap these, not replace them.

| Concern | Where it lives today | Reuse verdict |
|---|---|---|
| Venue addresses, ABIs, source provenance | `src/pons/quote/protocol.ts` | **Reuse as-is.** PoolManager, V4Quoter, StateView, UniversalRouter, Permit2, Multicall3 and the Pons curve/hook ABIs, each with a dated `SourceReference`. |
| Amount-specific quotes for both venues | `src/pons/quote/quoteService.ts` (`quotePonsV2`) | **Reuse as the venue `quote()`.** Already returns input/output/expected/minimum/spent/refund, fee lines, price impact, pinned block, `quotedAt`/`expiresAt`, `calculationVersion` and `policyVersion` — the exact field list §6 asks for, minus a gas estimate. |
| Bonding-curve pricing | `src/pons/quote/curveQuote.ts` | Reuse. Models fee, creator tax, allocation clamp-and-refund and the anti-snipe window. |
| V4 pricing | official V4Quoter via `quoteExactInputSingle`, `src/pons/quote/v4Quote.ts` | Reuse. Direction comes from the hook's own `memecoinIsCurrency0` (35 of 164 graduated pools have the memecoin as currency0, so "native is currency0" is wrong). |
| **UniversalRouter calldata** | `encodeRouterExactInSingle()` in `v4Quote.ts` | **This is already `buildTransaction` for the V4 leg.** It emits `commands`/`inputs` for `execute(commands, inputs, deadline)` exactly as a wallet would submit them, including the deployed router's extra `minHopPriceX36` field. |
| Execution simulation | `src/pons/quote/simulationService.ts` | **Reuse as the venue `simulate()`.** Runs the real route at the quote's pinned block from a synthetic account via `eth_call` state override, returns measured balance change, gas used and `matchesQuote`. |
| Revert decoding | `KNOWN_REVERTS` in `simulationService.ts` | Reuse and extend. Already maps `V4TooLittleReceived`, `AllowanceExpired`, `SlippageExceeded`, `CurveGraduated`, `UnexpectedRevertBytes`. |
| Block-pinned consistent reads | `src/pons/quote/pinnedReads.ts` (`snapshotAt`, `multicallAt`) | Reuse. Detects a block changing mid-read and reports `INCONSISTENT_SNAPSHOT`. |
| Endpoint health / failover | `src/pons/failoverChainClient.ts`, `src/researchApi/quoteEngineProvider.ts` | Reuse. One shared engine so cooldowns are learned once. |
| Immutable evidence rows | `EvidenceSnapshot` (append-only; a DB trigger rejects UPDATE/DELETE) | **Reuse for `ExecutionQuoteSnapshot`.** Already carries block, hashes, versions, `payloadSha256`, source references and a `parentId` lineage from simulation to quote. |
| Idempotent user writes | `PaperPosition` — `@@unique([userId, idempotencyKey])` plus a `requestFingerprint` that refuses a reused key for a different request | **Reuse the pattern verbatim** for §14. |

What does **not** exist and must be built: transaction construction for the curve leg, gas
estimation, allowance reading, a wallet-facing build endpoint, any persistence of a real
submission, reconciliation against chain receipts, and a feature flag.

## 2. Pons execution contracts discovered

Read from `protocol.ts` and from `evm-verification/src/PonsRouteSimulator.sol`, which is
the fork-verified statement of how each route is actually driven.

```
PoolManager       0x8366a39cc670b4001a1121b8f6a443a643e40951
V4Quoter          0x8dc178efb8111bb0973dd9d722ebeff267c98f94   (official, bytecode-matched)
StateView         0xf3334192d15450cdd385c8b70e03f9a6bd9e673b
UniversalRouter   0x8876789976decbfcbbbe364623c63652db8c0904
Permit2           0x000000000022d473030f116ddee9f6b43ac78ba3
Multicall3        0xca11bde05977b3631167028862be2a173976ca11
PonsV2MemeHook    0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044   (verified source)
```

Per-token, the factory's `getLaunchedToken()` yields `curve`, `pairToken`,
`graduationThreshold`, `poolFee`, `tickSpacing` and `phase`. Only two of the four
`GraduationPhase` values are tradable:

| Phase | Meaning | Route |
|---|---|---|
| 0 `NOT_GRADUATED` | Bonding curve live | `PonsV2BondingCurve` direct |
| 1 `SWEPT` | Curve stopped, pool not created | **none** — fail closed |
| 2 `POOL_CREATED` | Graduated | Uniswap V4 via UniversalRouter |
| 3 `RESCUED` | Owner-rescued launch | **none** — fail closed |

Curve entrypoints, taken from the verified source that the fork tests drive:

```solidity
function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable returns (uint256);
function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) external returns (uint256);
```

## 3. Graduated Uniswap V4 execution path

`UniversalRouter.execute(commands, inputs, deadline)` with one `V4_SWAP` command (`0x10`)
whose action sequence is `SWAP_EXACT_IN_SINGLE` (`0x06`) → `SETTLE_ALL` (`0x0c`) →
`TAKE_ALL` (`0x0f`). The deployed router embeds a newer V4Router than the quoter's pinned
periphery, so its single-hop params carry a `minHopPriceX36` field that older ABIs lack;
`encodeRouterExactInSingle()` already sets it to `0` to disable the per-hop price check.

The pool key is never taken from the user. It is rebuilt from the factory record
(`buildPoolKey`/`poolIdFor`), then cross-checked against the hook's own `launches(poolId)`
registration — `registered`, `memecoinIsCurrency0` and the memecoin address must all
agree, or the quote is refused with `POOL_REGISTRATION_INCONSISTENT`. Liquidity and
initialisation come from StateView `getSlot0`/`getLiquidity`.

### Approvals — the part the brief's §11 understates

The simulator shows the real approval shape, and it is **not** sell-only:

- **Native-ETH input** (buy of a native-quoted token): no approval; value is attached.
- **ERC-20 input on the curve** (sell, or buy of an ERC-20-quoted token):
  single `ERC20.approve(curve, amountIn)`.
- **ERC-20 input on V4**: **two** approvals — `ERC20.approve(PERMIT2, amount)` then
  `Permit2.approve(token, universalRouter, amount, expiration)`.

Dev-database counts explain how often each applies, across 139,008 discovered Pons V2
tokens on this chain:

| Pair asset | Tokens | Graduated | Buy needs approval? |
|---|---|---|---|
| Native ETH (`0x0000…0000`) | 99,078 | 855 | No |
| ERC-20 pair assets (all others) | 39,930 | 630 | Yes |

1,485 graduated tokens carry a `poolId`, so the V4 leg has a real population to test
against. Note the simulator approves `type(uint256).max` / `type(uint160).max`; §11
requires production to request **exact** amounts instead, so the production path is
deliberately stricter than the simulated one and needs its own fork coverage. Permit2's
`expiration` must also cover the router `deadline`, or the swap reverts with
`AllowanceExpired` — already in `KNOWN_REVERTS`.

## 4. Proposed API contract

New routes, following the existing shape (`200` with a `status`/`reason` for "unsupported"
and "unavailable"; raw provider text never reaches a response):

```
POST /api/v1/tokens/robinhood/{tokenAddress}/executions/quotes     public read
     -> reuses quotePonsV2, adds gas estimate + allowance requirement for the given wallet

POST /api/v1/me/executions/intents          Supabase user, Idempotency-Key
     -> { quoteId, walletAddress, slippageBps } -> validated, simulated, calldata returned
     -> { to, data, value, gasLimit, chainId: 4663, approvals: [...] }

POST /api/v1/me/executions/{id}/submissions Supabase user, Idempotency-Key
     -> records the hash the wallet returned; never broadcasts

GET  /api/v1/me/executions                  Supabase user  (restores pending on reload)
GET  /api/v1/me/executions/{id}             Supabase user
```

Every response is versioned like `PAPER_TRADING_API_VERSION`, registered in
`src/researchApi/contracts/openapi.ts`, and the frontend regenerates types through
`npm run api:codegen` with `api:codegen:check` guarding drift.

`REAL_TRADING_ENABLED` (default `false`) gates intent and submission creation in
`ApiConfig`; quotes stay public and unflagged because they already are.

## 5. Proposed persistence model

Mirrors the `EvidenceSnapshot` + `PaperPosition` split that already works.

```
ExecutionIntent      userId, idempotencyKey, requestFingerprint, chain, chainId,
                     walletAddress, tokenAddress, side, venue, route,
                     inputCurrency/decimals/amount, outputCurrency/decimals,
                     expectedOutput, minimumOutput, slippageBps, deadline,
                     quoteSnapshotId -> EvidenceSnapshot (kind QUOTE)
                     simulationSnapshotId -> EvidenceSnapshot (kind SIMULATION)
                     state (the §12 machine), failureReason
                     @@unique([userId, idempotencyKey])

SubmittedExecution   intentId, transactionHash, submittedAt, nonce, wallet
                     @@unique([chain, transactionHash])   <- §14's "one canonical execution"

ExecutionReceipt     submissionId, status CONFIRMED|REVERTED|DROPPED|REPLACED,
                     blockNumber, blockHash, gasUsed, effectiveGasPrice,
                     actualInput, actualOutput, decoded logs, reconciledAt
```

`EvidenceSnapshotKind` gains no new variant: a real quote and a real simulation are the
same immutable artifacts the paper path already stores, so the append-only trigger and
`payloadSha256` protection carry over unchanged. No column anywhere holds a key, seed or
signature — only the hash the wallet hands back.

Approvals are recorded as `ExecutionIntent` rows with `route = "APPROVAL"` so §11's
"persist/reconcile approval transaction state too" needs no second table.

## 6. Wallet integration approach

`src/lib/hooks/useEvmWallet.ts` is an EIP-1193 + EIP-6963 connector that today is
explicitly read-only ("Never signs or broadcasts"). It already:

- discovers injected and EIP-6963 providers,
- tracks `eth_accounts` and `eth_chainId` with generation counters that invalidate
  in-flight reads,
- offers `switchChain`, whose type is already `"0xaa36a7" | "0x1237"` — and `0x1237` is
  4663, so the Robinhood switch request exists.

7E.1 adds one signing seam to it (`eth_sendTransaction` only, never `eth_sign*` of raw
payloads) plus the §16 error states. Every component keeps talking to a gateway
interface, not to the provider, matching the existing `TradingGateway` contract in
`src/features/token-terminal/contracts/trading.ts`.

On the terminal, `RobinhoodTerminal.tsx` currently renders only `PaperTradePanel`. The
`[Trade] [Practice]` toggle goes there; Practice keeps `PaperTradePanel` verbatim. The
legacy `TradingPanel.tsx` is fixture-backed (`fixtureTradingGateway`) and is **not** the
basis for real trade mode — but `state/tradeMachine.ts` is: its reducer already encodes
the §12 lifecycle and two load-bearing invariants (a `CONFIRM` only advances from a fresh
`quote_ready`, and a repeated confirm after `awaiting_signature` is a no-op).

## 7. Security risks identified

1. **Approval breadth.** The simulator's `max` approvals must not leak into production
   (§11). Exact-amount approvals with a bounded Permit2 expiration, plus a fork test that
   asserts the requested allowance equals the input amount.
2. **Quote/execution drift.** A quote is pinned to a block; the transaction lands later.
   Mitigated by re-validating on review, enforcing `minimumOutput` on-chain, and refusing
   to widen slippage after confirmation.
3. **Wrong-chain signing.** `chainId` must be re-read immediately before the request and
   included in the transaction; a mismatch aborts rather than prompts.
4. **Duplicate submission on reload.** Handled by `@@unique([userId, idempotencyKey])` and
   `@@unique([chain, transactionHash])`, both enforced in Postgres, not in React.
5. **`VerifiedWallet` is Solana-only.** Its `network` defaults to `solana:mainnet` and
   verification is a detached Ed25519 signature. There is no EVM ownership proof today, so
   7E.1 records `walletAddress` on the execution as *claimed* and never as *verified*, and
   no private data is released on the strength of it. An EIP-4361 path is a later subphase.
6. **Trace/video leakage.** Wallet flows put addresses and balances on screen; every
   artifact is reviewed under the AGENTS.md policy before it is committed.
7. **Feature-flag bypass.** Frontend visibility is not protection (§20); the backend
   refuses to build calldata when `REAL_TRADING_ENABLED` is false, and that refusal gets
   its own test.

## 8. Tests implemented

At this checkpoint: none beyond the inherited baselines above. The 7D.3.2 fork harness
that 7E.1 extends already exists at `evm-verification/test/fork/` —
`PonsRouteSimulatorFork.t.sol`, `PonsCurveFork.t.sol`, `PonsV4QuoteFork.t.sol` — with
68/68 quote-vs-execution rows exact at block 62211539.

## 9. What remains before any mainnet wallet transaction is allowed

- Execution venue abstraction, calldata construction for both legs, gas estimation.
- Allowance reading and the exact-approval flow, with fork coverage.
- Persistence, idempotency and reconciliation against chain receipts.
- `REAL_TRADING_ENABLED` defaulting to false, enforced backend-side.
- Deterministic local/fork BUY and SELL, revert, slippage-failure and approval tests.
- Frontend Trade/Practice toggle, review sheet, wallet states, reload restoration.
- Playwright evidence per §24 and the AGENTS.md policy.
- **A human** performing the §25 tiny-value smoke in their own wallet. No automated test
  spends mainnet assets; read-only mainnet verification only.

## Deferred in this phase, by instruction

Solana execution (§18, Helius capacity), Hyperliquid (§19), Robinhood stock-token
execution (§17), MoonPay/Coinbase fiat onboarding. The venue interface stays chain-neutral
so those attach later, but no Trade button may imply execution that does not exist.
