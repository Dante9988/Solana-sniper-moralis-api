# Robinhood Chain / Pons fixture provenance

All fixtures are raw `eth_getLogs` responses fetched live from
`https://rpc.mainnet.chain.robinhood.com` during the Phase 7B.4 ABI
verification step (2026-09-06), plus one live `getLaunchedToken` read
against the Pons factory (`0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB`).
No live RPC calls happen in the unit tests that consume these files —
same no-live-RPC-in-tests discipline as `src/pump/__tests__/fixtures/mainnet/SOURCE.md`.

Public on-chain data only. No private keys, no PII.

| File | Tx hash | Block | Log index | Purpose |
|---|---|---|---|---|
| `token_launched_9019252.json` | `0x92476c6f12444023711b221057dcffab166f673027479008f959ca37f5f21eb7` | 9019252 | 15 | Real `TokenLaunched` log from the active Pons factory — topic0 matched the ABI pulled from `github.com/ponsdotdev/ponsfamily` before this fixture was captured. |
| `swap_9019252.json` | `0x92476c6f12444023711b221057dcffab166f673027479008f959ca37f5f21eb7` | 9019252 | 19 | Real Uniswap V3 `Swap` log from the pool created by the same launch tx (`0x8f4F723f10fc7bAD28742d25c91158C728557C4c`) — topic0 matched the canonical Uniswap V3 `Swap` signature. |

`getLaunchedToken(0x055650555Be80649397084Cd3f8a09b4350e8612)` returned
`supply=1000000000000000000000000000`, `isToken0=true`, `poolFee=10000` at
time of capture — used as the enrichment input paired with the
`TokenLaunched` fixture above.

Also confirmed live and not fixture-worthy on their own: `graduationStatus`
for the same token returned `pairedPrincipal=1827844566659732282`,
`threshold=4200000000000000000` (exactly the documented 4.2 ETH default),
`graduated=false` — sane, internally consistent values, proving the
function signature is correct.
