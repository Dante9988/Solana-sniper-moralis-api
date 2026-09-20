# Phase 7D.5.1 — repository gap assessment

Taken before implementation, 2026-09-20. Branch tips inspected, not assumed:
backend `9d3588e`, frontend `e1d2c7b`, both clean, both local-only.

## Phase numbering

`phase7g1.txt` already defines **7G.1** as *Robinhood Chain deterministic investigation and
AI thesis foundation*. The buying work here is **not** that, so it is numbered **7D.5.1**
and 7G.1 keeps its scope and its place in the order. Step 7 of this brief ("keep the
intelligence layer aware of instrument type, venue, liquidity…") is an *input* to 7G.1, not
a replacement for it.

## What already exists and is reusable

| Capability | Where | Verdict |
|---|---|---|
| Block-pinned quotes, route simulation, evidence snapshots | `src/pons/quote/` (7D.3.2) | **Reuse.** Already does executable quotes + preflight simulation against the official V4Quoter. |
| Paper/Practice ledger, idempotency, user isolation | `src/services/practiceService.ts` | **Reuse** for Practice-vs-real separation. |
| Market data, decimals, quote-asset registry, Chainlink USD | `src/pons/market/`, `src/pons/usd/` | **Reuse** for asset identity and disclosure. |
| Solana wallet connection | `only-pump-me` `@solana/wallet-adapter-*` | **Reuse.** Real and wired. |
| Candle/chart + Advanced Charts datafeed | 7D.5 | **Reuse, do not rebuild** (Step 7 says so). |

## What does not exist

| Needed | Status |
|---|---|
| MoonPay | **Nothing.** No code, no config, no account. |
| Hyperliquid | **Nothing.** |
| Uniswap **V3** | **Nothing.** Only V4 (PoolManager/StateView/V4Quoter) exists, from 7D.3.2. |
| WBTC / Ethereum mainnet route | **Nothing.** No Ethereum execution path. |
| Shared buying contract | **Nothing.** No provider abstraction of any kind. |

## Two findings that change the plan

### 1. The existing Jupiter service is built on a dead endpoint

`src/services/jupiterService.ts` calls `https://quote-api.jup.ag/v6/quote` and `/swap`.
Probed live on 2026-09-20:

| Host | Result |
|---|---|
| `quote-api.jup.ag/v6/quote` | **HTTP 000 — unreachable** |
| `lite-api.jup.ag/swap/v1/quote` | HTTP 200 (free tier, no key) |
| `api.jup.ag/swap/v1/quote` | HTTP 200 (keyed tier) |

The brief says "do not extend obsolete endpoints blindly". It is obsolete, so the new work
targets `swap/v1` and the old service is left alone.

### 2. The existing Jupiter service is custodial, and its callers are the legacy bot

Its callers are `src/telegram/**` and `src/discord/**` — the `main2` bot surface, which signs
with a stored key. Phase 7A deliberately removed custodial paths from the product. The brief
requires "signing in the user's wallet. Never collect private keys or introduce backend
custody", so this cannot be extended into the product path; a non-custodial adapter is a new
thing that builds an unsigned transaction for the user's wallet.

### 3. There is no EVM wallet in the frontend at all

`only-pump-me` has `@solana/wallet-adapter-*` and `@solana/web3.js`, and **no** wagmi, viem,
WalletConnect or `window.ethereum` usage. So:

- Uniswap V3/V4 on Robinhood Chain and WBTC on Ethereum have **no wallet to sign with** today.
- Backend quoting for those routes exists and is reusable; *execution* does not.

This is recorded as a blocker rather than improvised, per the brief's rule that a Solana
balance cannot fund an EVM swap and that must not be hidden.

## Order of work

1. Canonical asset identity + the shared buying contract (Step 2) — everything hangs off it.
2. Jupiter adapter against the verified `swap/v1` API, non-custodial (Step 4).
3. MoonPay adapter + webhook verification, sandbox-shaped, credentials documented (Step 3).
4. Uniswap/WBTC: verify deployments and record what is routable; execution blocked on the
   EVM wallet gap (Step 5).
5. One buy panel (Step 6), same-chain only.
