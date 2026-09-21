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

**Custody note — a correction.** An earlier entry here called `jupiterService.ts` custodial.
That was wrong: the file contains no key material at all, `buildBuySwapTransaction` returns
an unsigned `transactionBase64`, and `connectWallet` stores only a public address. The new
adapter is separate because the old one targets a dead endpoint and predates the shared
contract, not because of custody. Both return unsigned transactions.

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

## MoonPay

| Item | Value |
|---|---|
| Source | Official documentation |
| Accessed | 2026-09-20 |
| Environment in use | **sandbox** (all three configured keys are `_test_`) |

Verified and relied upon:

| Fact | Detail |
|---|---|
| Widget URL signing | HMAC-SHA256, key = **secret** key, message = query string **including the leading `?`** (`new URL(u).search`), **base64**, appended URL-encoded as `&signature=`. Mandatory whenever `walletAddress` is set. |
| Webhook signature | Header `Moonpay-Signature-V2: t=<unix>,s=<hex>`; signed payload `` `${t}.${rawBody}` ``; HMAC-SHA256, **hex**; key = the **webhook** key. Raw body required. |
| Webhook key format | `wk_test_…` / `wk_live_…` — same environment prefix convention as the API keys. **Checked separately rather than assumed**, per the brief. Per-webhook signing secrets are **deprecated**; the account-level Webhook Key is correct. |
| Sandbox widget host | `https://buy-sandbox.moonpay.com` |
| Sandbox networks | ETH → **Sepolia**; SOL → **Devnet, native SOL only** (no SPL) |
| Sandbox ERC-20 | Delivers **MoonPayToken** `0x699cfe8997d647d03325ef4bfd039d5bb0984a17`, not the real token |
| Replay tolerance | **Not documented by MoonPay.** We enforce ±300s; without a window a captured webhook replays forever. Recorded as our decision, not theirs. |

### A conflict in MoonPay's own documentation

The brief stated sandbox delivery is 1/100 of the quoted amount. MoonPay's pages disagree
with each other:

- Sandbox testing guide: *"1/100th of the quoted amount… applies across all assets"* (a 0.1 ETH purchase delivers 0.001 ETH).
- On-ramp FAQ: *"All Ethereum purchases in sandbox will result in the transfer of 0.001 Sepolia ETH **regardless of the purchased amount**."*

These are only the same when the quote happens to be 0.1 ETH. **Unresolved**, and not
generalised to other assets. A real sandbox run will settle it by recording the quoted and
delivered amounts for the asset actually tested.

### Missed-webhook reconciliation — **UNVERIFIED, not implemented**

`GET https://api.moonpay.com/v3/buy_transactions/ext/{externalTransactionId}` is documented
(returning an array, because external ids are not guaranteed unique). Probed 2026-09-20 with
a nonexistent id and the sandbox secret key, unauthenticated / `?apiKey=` / `Authorization:
Api-Key`: **all three returned an HTML 404**, not a JSON error, so neither the path nor the
auth method could be confirmed from here without a real sandbox transaction to look up.

No polling reconciliation is shipped. Guessing this contract risks mis-reconciling real
orders, which is worse than an order that waits for a webhook. To be confirmed during the
first real sandbox run, when a genuine `externalTransactionId` exists.

## Not started

MoonPay, Hyperliquid, Uniswap V3, and Ethereum execution have no verified sources yet and no
code that claims support.
