# Phase 7D — Pons V2 / Uniswap V4 ingestion, and a new dual-AMM launchpad

This is a single-file summary of everything built across three repos in this phase:
this backend (`Solana-sniper-moralis-api`), the frontend (`only-pump-me`, "OnlyPump"), and
a brand-new smart-contract project (`Pump-Fun-Smart-Contracts-on-EVM/v4`). Each section
below names the real files changed and the real on-chain facts verified — every address,
event signature, and topic0 here was confirmed against real transactions/contracts, not
assumed (per this repo's own external-protocol rule).

## 1. Backend — Pons V2 discovery, metadata, and Uniswap V4 transaction history

**Why:** the existing `src/pons/*` pipeline only ever tracked Pons **V1** (Uniswap V3, no
graduation event — polled). A real transaction supplied mid-session turned out to belong to
a different, newer protocol generation, **Pons V2**, which launches onto a bonding curve
and graduates onto **Uniswap V4** — verified live via `PonsV2LaunchFactory`
(`0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`, Blockscout-verified) and the real V4
`PoolManager` singleton (`0x8366a39CC670B4001A1121B8F6A443A643e40951`, also verified).

### New files
- `src/pons/abiV2.ts` — verified `PONS_V2_FACTORY_ABI` (`TokenLaunched`, `PoolGraduated`,
  `GraduationTokensPermanentlyLocked`, `launchToken`/`launchTokenFor`/`launchTokenFor`
  entrypoints) and `UNISWAP_V4_POOL_MANAGER_ABI` (`Initialize`, `Swap`).
- `src/pons/ponsV2Adapter.ts` — pure decoders: token discovery, graduation,
  `decodeLaunchMetadata` (recovers name/symbol/logo/description/socials from a real
  `launchToken()` call), `decodePoolInitialized` (recovers the V4 PoolId from the real
  `Initialize` log that always accompanies a graduation), `decodeTrade` (V4 `Swap`).
- `src/pons/discoveryV2Listener.ts` — real-time discovery **and** graduation in one
  listener (V2's factory emits both as real events — no polling needed, unlike V1).
- `src/pons/tradeV2Listener.ts` — post-graduation transaction history: queries the V4
  `PoolManager` singleton filtered by PoolId (not by pool address — V4 has none).
- `src/pons/blockscoutTrace.ts` — best-effort fallback (3 retries + `BLOCKSCOUT_API_KEY`)
  for the rare launch that's routed through an unverified bundler instead of calling
  `launchToken()` directly.

### Schema (`prisma/schema.prisma`, 3 new migrations)
`DiscoveredToken` gained: `curveAddress`, `name`, `symbol`, `logoUrl`, `description`,
`socialWebsite/Twitter/Telegram/Discord/Farcaster`, `richMetadataStatus/Source`,
`graduationPositionId/TokenAmount/PairTokenAmount/SourceHeight/Hash/TxHash`, `poolId`.
`ChainTrade` gained `poolId`. `reorgRecovery.ts` updated to reset the new V2 graduation
fields (and a second, previously-missing orphaning query keyed on graduation height, not
just launch height) when a reorg invalidates them.

### Real bug fixes made along the way
- **The "always behind" bug**: all four polling loops (`discoveryListener.ts`,
  `tradeListener.ts`, and the two new V2 listeners) used to wait the full poll interval
  between ticks even while there was known backlog. Fixed: only wait once genuinely
  caught up. Root cause was compounded by the configured Alchemy key being free-tier
  (10-block `eth_getLogs` cap — `PONS_MAX_BLOCK_RANGE_PER_POLL=10` in `.env`).
- `src/pons/chainClient.ts` gained `getTransaction()` and an optional `args` filter on
  `getLogs()` (for PoolId-array filtering).

### New env vars (`.env.example`)
`PONS_V2_FACTORY` (the only required one — everything else self-describes via the
factory's own view functions), `PONS_MAX_BLOCK_RANGE_PER_POLL`, `BLOCKSCOUT_API_KEY`
(optional — a real, spot-checked, modest reliability improvement on Blockscout's flaky
routes, not a full fix; retries matter more).

### Real Robinhood Chain facts confirmed this phase
| Fact | Value |
|---|---|
| Mainnet chain ID | 4663 |
| Testnet chain ID | 46630 |
| Testnet RPC | `https://rpc.testnet.chain.robinhood.com` |
| Testnet explorer | `explorer.testnet.chain.robinhood.com` |
| Canonical WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| USDG stablecoin | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |
| Real Uniswap V3 Factory (mainnet) | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` (derived live from a real pool — not in the docs) |
| Real Uniswap V4 PoolManager (mainnet) | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| Gas | Plain ETH, standard L2-execution + L1-data-fee split, `eth_estimateGas` handles both |
| WS `eth_subscribe` | **Works** on the current Alchemy endpoint (the old in-code comment claiming it doesn't was verified against a *different*, non-Alchemy RPC — now stale; not yet acted on, flagged as a follow-up architecture change) |
| Stock tokens | ERC-8056 (`uiMultiplier()` for splits/dividends), explicitly permissionless to pair in AMM pools — a platform capability not yet used by anything in this repo |

## 2. Frontend (`only-pump-me`) — real data instead of fixtures for Robinhood Chain

- `src/pages/RobinhoodLive.tsx` — the "Live Discovery" table now shows real name/symbol/logo
  (falls back to the shortened address when metadata is unavailable, never fabricated).
- `src/features/token-terminal/adapters/robinhoodTokenDataAdapter.ts` **(new)** — a real
  `TokenHeaderData` adapter calling the backend directly (mirrors
  `robinhoodCandleGateway.ts`'s existing real-backend pattern). Insider/CTO/AI panels stay
  on the generic "no data yet" fixture — out of scope, honestly labeled unavailable.
- `src/features/token-terminal/hooks/useTokenData.ts` — routes any `robinhood`-chain
  address (except the CASHCAT fixture demo route) to the real adapter instead of the
  generic fixture fallback.
- `src/lib/utils.ts` — new `resolveIpfsUrl()` (real bug fix: launch metadata logos come
  back as `ipfs://...`, which no browser renders as `<img src>` directly).
- `src/features/token-terminal/adapters/robinhoodCandleGateway.ts` — `KNOWN_VENUES` now
  recognizes `"pons_v2"` alongside `"pons"`.
- `openapi/backend.json` + `src/lib/api/generated/schema.d.ts` regenerated from the
  backend's extended OpenAPI doc (new token/trade fields — see §1).

## 3. New project — dual Uniswap V3/V4 launchpad (`Pump-Fun-Smart-Contracts-on-EVM/v4`)

**Why:** the user's existing `Pump-Fun-Smart-Contracts-on-EVM` project (Solidity 0.7.6,
Hardhat) is a working pump.fun-style launchpad that only ever migrates to Uniswap V3, and
splits post-migration fees 30% to early buyers (an unbounded-array push model — a real
gas-scalability bug at holder-count scale). The ask: support **either** V3 or V4 per
launch, and a **configurable creator/holder fee split** (platform fixed at 10%; the
creator's 90% is theirs to keep or share with holders) that actually works for both
targets, with V3's lack of a hook mechanism solved by a permissionless, keeper-or-creator
-triggerable collection function rather than letting fees sit uncollected.

This is a **new, separate Foundry project** (Solidity 0.8.26) — V4's real interfaces need
`^0.8.24`+, incompatible with the old project's 0.7.6. The old project is untouched.

### Contracts (`v4/src/`)
| Contract | Role |
|---|---|
| `BondingCurveAmm.sol` | Pre-graduation trading — virtual-reserve x*y=k, ETH-quoted, one shared contract tracking every token's curve |
| `RewardToken.sol` | The launched ERC-20 — notifies `FeeDistributor` on every transfer so post-graduation rewards stay correctly attributed |
| `LaunchFactory.sol` | Launches tokens, picks `UNISWAP_V3` or `UNISWAP_V4` per launch, auto-graduates the instant a real-ETH threshold is crossed |
| `FeeDistributor.sol` | The shared fee split for **both** targets — pull-based "magnified dividend" accounting (fixes the old project's unbounded-array bug outright); platform 10% + creator's configured holder share + creator's own keep, all settled immediately, holders claim their share whenever |
| `V3Migrator.sol` | Mints a real V3 position (ported from the old `LiquidityManager`'s flow); `collectAndDistribute()` is **permissionless** — a daily keeper or the creator can trigger it manually, matching what was asked for V3's lack of hooks |
| `V4Migrator.sol` + `hooks/FeeSplitHook.sol` | Initializes a real V4 pool with a mined hook address; the hook skims and splits the fee **in real time on every swap** — no keeper needed at all for V4 |

### Verification — 20/20 tests passing, including real local Uniswap V4
- `test/FeeDistributor.t.sol` (8), `test/BondingCurveAmm.t.sol` (8) — pure logic.
- `test/FeeSplitHook.t.sol` (2) and `test/LaunchFactoryV4.t.sol` (2) — **real** local
  Uniswap V4 `PoolManager` (via v4-core's own `Deployers` test harness), a real mined hook
  address, real pools, real swaps in both directions, confirming the hook actually fires
  and `FeeDistributor` actually splits real ETH between treasury/creator/holder.
- V3Migrator's own equivalent (real local V3 core) and V4Migrator's own PositionManager
  call are **not yet locally tested** — both need infrastructure (a separate 0.7.6
  sub-build for real V3 core; Permit2 + descriptor + WETH for a real local
  `PositionManager`) that's a larger, separate effort — deferred to real testnet
  verification instead, documented inline in the test files.

### Real bugs caught while building this
- `LaunchFactory` had no `receive()` — couldn't accept the curve's ETH handoff at
  graduation.
- A classic `vm.prank` chaining mistake in the test suite itself (`factory.curve().buy(...)`
  is two external calls; `vm.prank` only covers the first) — caught and fixed, not shipped.

### Not done yet (explicitly, not silently)
- Real V3 `NonfungiblePositionManager` address on Robinhood (Blockscout was too flaky this
  session to confirm — only the V3 Factory address was recovered, live, from a real pool).
- Testnet deployment and the full real-money verification pass described in the original
  plan (launch a real test token on `rpc.testnet.chain.robinhood.com`, cross the threshold
  for both a V3- and a V4-targeted launch, confirm real fee splits with real tx hashes).
- The daily V3 fee-collection keeper script (small, backend-side, intentionally deferred
  until the contracts' real gas costs/event shapes are known from testnet).
- A chain-wide "new ERC-20 + liquidity added + LP locked/burned → snipe" detector, and the
  WS-subscription architecture change for discovery — both flagged mid-session, not yet
  started.
