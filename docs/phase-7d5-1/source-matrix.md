# Phase 7D.5.1 — source matrix

Required by `CLAUDE.md`: every external protocol fact used, with where it came from, how it
was checked, and when. Entries marked **unverified** are not used to expose anything to a
user.

## Jupiter (Solana swaps)

| Item | Value |
|---|---|
| Source | Live API probe (primary: verified endpoint behaviour) |
| Accessed | 2026-09-20 |
| Official docs | `dev.jup.ag` / `developers.jup.ag` — both redirect-looped or 404'd from this host, so the API itself was used as the authority |

Probed directly:

| Host | Result |
|---|---|
| `https://quote-api.jup.ag/v6/quote` | **HTTP 000 — unreachable.** This is what `src/services/jupiterService.ts` still calls. |
| `https://lite-api.jup.ag/swap/v1/quote` | **HTTP 200**, no API key |
| `https://api.jup.ag/swap/v1/quote` | **HTTP 200**, keyed tier |

Quote response fields relied upon, from a captured live response:
`inAmount`, `outAmount`, **`otherAmountThreshold`** (minimum out under `ExactIn`),
`swapMode`, `slippageBps`, `priceImpactPct`, `contextSlot`, `platformFee`, `routePlan`.

Behaviour relied upon, and why it is load-bearing:

- `otherAmountThreshold` is the **minimum received** only when `swapMode === "ExactIn"`.
  Under `ExactOut` it bounds the input instead, so the adapter refuses `ExactOut` rather
  than presenting a maximum as a minimum.
- An empty `routePlan` means no route exists. Treated as a product state, not an error to
  swallow.
- Jupiter holds no order state; confirmation is the chain's. `status()` returns `UNCERTAIN`
  rather than inventing a result.

Live read-only verification through the adapter, 2026-09-20:

```
SOL->USDC: 0.1 SOL -> expected 10.975022 USDC, min 10.920147
SOL->BONK: 0.1 SOL -> expected 3666373.75326 BONK, min 3648041.8845
ETH->USDC: supported=false ("Jupiter routes Solana tokens only")
```

No funds moved; no transaction was signed or submitted.

**Licence/custody note.** The pre-existing `jupiterService.ts` signs with a stored key and is
called only from `src/telegram/**` and `src/discord/**` — the legacy bot surface Phase 7A
removed from the product. The new adapter shares no code with it and returns an unsigned
transaction only.

## TradingView Advanced Charts

| Item | Value |
|---|---|
| Source | Official documentation |
| URL | `https://www.tradingview.com/charting-library-docs/latest/connecting_data/datafeed-api/required-methods/` |
| Version | Advanced Charts **v31** |
| Accessed | 2026-09-20 |
| Relied upon | Required datafeed methods and their signatures; `Bar.time` in **milliseconds** |
| Licence | `charting_library` is distributed privately by TradingView and is **not** vendored here |

## WBTC on Ethereum — **UNVERIFIED**

| Item | Value |
|---|---|
| Address recorded | `0x2260fac5e5542a773aa44fbcfedf7c193bc2c599` |
| Source | Widely-published canonical address — **third-party, not checked here** |
| Verification attempted | 2026-09-20 |
| Result | **Failed.** `ALCHEMY_ETHEREUM_HTTPS_URI` returned HTTP 429; `eth.llamarpc.com` and `ethereum-rpc.publicnode.com` returned nothing from this host; `rpc.ankr.com/eth` requires a key |
| Not yet read | `eth_getCode`, `symbol()`, `decimals()`, liquidity |

Consequence, applied in code: **no WBTC buy route is exposed.** The identity exists so that
WBTC and native BTC are structurally distinct assets, and the constant carries a comment
saying it is unverified. Before any WBTC purchase ships, read the bytecode, `symbol()` and
`decimals()` against a working Ethereum endpoint and update this row.

## Robinhood Chain (carried forward from 7D.3.2 / 7D.4, re-confirmed 2026-09-20)

| Item | Value | Verified |
|---|---|---|
| Chain id | 4663 | `eth_chainId` |
| Pons V2 factory | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` | deployed, 24,177 bytes |
| Pons V1 factory | `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB` | deployed, 24,353 bytes |
| Uniswap V4Quoter | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` | 7D.3.2, official deployment |
| StateView | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` | 7D.3.2 |
| Tokenized equities | SPY `0x117cc213…`, NVDA `0xd0601ce1…` | deployed; real `totalSupply`; used as quote assets by 936 / 8,377 Pons tokens |

**Uniswap V3 on Robinhood Chain: not investigated.** No factory, router, quoter or Permit2
address has been verified, so nothing claims V3 support.

**Tokenized equities are not shares.** Being an ERC-20 with pools is evidence of a tradeable
token and nothing more — not ownership, not redemption rights, not a usable buy route.
Redemption terms and issuer identity remain unresearched.

## Not started

MoonPay, Hyperliquid, Uniswap V3, and Ethereum execution have no verified sources yet and no
code that claims support.
