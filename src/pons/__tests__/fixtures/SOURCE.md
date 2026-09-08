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

## Pons V2 (Phase 7D, 2026-09-08)

Fetched via `eth_getTransactionReceipt` against `ROBINHOOD_RPC_HTTPS`
(Alchemy) — a real transaction the user supplied as an example of "PONS
token creation or migration to Uniswap V4." No live RPC calls happen in the
unit tests that consume these files.

| File | Tx hash | Block | Log index | Purpose |
|---|---|---|---|---|
| `token_launched_v2_52687031.json` | `0x3e9dcd19093da517aa3001975828065c846d785a4ac7858af76d52d4eec90914` | 52687031 | 78 | Real `TokenLaunched` log from `PonsV2LaunchFactory` (`0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`, Blockscout-verified) — topic0 matched `toEventSelector("TokenLaunched(address,address,address,address,uint256,uint256)")` computed from the verified ABI. |
| `pool_graduated_v2_52687031.json` | (same tx) | 52687031 | 111 | Real `PoolGraduated` log from the same factory for the same token — the migration-to-Uniswap-V4 event. This was a "bundle" launch: creation and graduation happened in one atomic transaction. |

`getLaunchedToken(0x07EBB29a38Fbcb41563817e5E19f2ceC619C90D2)` returned
`phase=2` (graduated) and `graduationThreshold=4200000000000000000`,
exactly matching `PoolGraduated`'s `pairTokenAmount`. `totalSupply()` on
that token returned `1000000000000000000000000000`, matching
`token_launched_v2_52687031.json`'s `enrichment.supply` and the same order
of magnitude as `PoolGraduated`'s `tokenAmount`. `locker()`,
`graduationExecutor()`, `memeHook()`, `buybackVault()`, `poolManager()`,
and `positionManager()` were each called live on the factory and every
returned address independently appears as a participant (staticcall
target or log emitter) elsewhere in this same transaction — cross-
confirming these getters describe this deployment.

Public on-chain data only. No private keys, no PII.

## Pons V2 metadata + transaction history (Phase 7D §1/§2, 2026-09-08)

| File | Source | Purpose |
|---|---|---|
| `launch_token_calldata_v2_52687031.txt` | The internal call from `0x232f26fF...` to `PonsV2LaunchFactory.launchToken(...)` inside tx `0x3e9dcd19...eec90914`, pulled via Blockscout's `/api/v2/transactions/:hash/raw-trace` (selector `0xa72101af`, matched via `toFunctionSelector` against the real ABI) | Proves `ponsV2Adapter.decodeLaunchMetadata` recovers real name/symbol/logo/description/socials from an actual launch call, not a guess. |
| `pool_initialized_v2_52687031.json` | Real `Initialize` log from the verified `PoolManager` (`0x8366a39CC670B4001A1121B8F6A443A643e40951`), same tx/block as `pool_graduated_v2_52687031.json` — `currency0` = native ETH (`0x0`), `currency1` = the token, `hooks` = the known `PonsV2MemeHook` address (cross-confirms this is the right Initialize log). | Proves `decodePoolInitialized` recovers the real PoolId without ever hand-computing `keccak256(PoolKey)`. |

No real post-graduation `Swap` log was available yet this session (this token graduated in the same tx it launched — no separate V4 trade has happened against it, and Blockscout's log-listing endpoint was too unstable this session to pull a different pool's real Swap). `decodeTrade`'s tests instead build a log the same way `testSupport.ts`'s pre-existing `makeSwapLog`/`makeTokenLaunchedLog` helpers already do for V1: the real, verified `UNISWAP_V4_POOL_MANAGER_ABI` fragment (Blockscout-verified — see abiV2.ts) encoding synthetic amounts via viem's own encoder, never hand-typed hex.
