# Phase 7D.3 §5/§6 — protocol source matrix and gap analysis

> `CLAUDE.md` (frontend repo, applied repo-wide): *"Never implement or modify blockchain
> protocol integrations from model memory alone… Do not begin implementation until the
> source matrix and repository gap analysis are complete."*
>
> This is that document. **No pool-evidence or quoting code has been written yet.**
> Everything below was either read from an official repository or verified against
> Robinhood Chain mainnet on the recorded date.

**Research date:** 2026-09-12
**Chain:** Robinhood Chain, `chainId 4663`, RPC from `ROBINHOOD_RPC_HTTPS`
**Observed at block:** 61335868 – 61336785

---

## 1. Source matrix

| # | Source | Type | Version / ref | Accessed | Behaviour relied upon |
|---|---|---|---|---|---|
| S1 | [Uniswap/v4-core `src/types/PoolKey.sol`](https://github.com/Uniswap/v4-core/blob/main/src/types/PoolKey.sol) | Official repo | `main` | 2026-09-12 | `PoolKey` field order and types |
| S2 | [Uniswap/v4-core `src/types/PoolId.sol`](https://github.com/Uniswap/v4-core/blob/main/src/types/PoolId.sol) | Official repo | `main` | 2026-09-12 | `toId()` = `keccak256(poolKey, 0xa0)` |
| S3 | [Uniswap/v4-core `src/libraries/StateLibrary.sol`](https://github.com/Uniswap/v4-core/blob/main/src/libraries/StateLibrary.sol) | Official repo | `main` | 2026-09-12 | `POOLS_SLOT`, `LIQUIDITY_OFFSET`, slot derivation, slot0 bit unpacking |
| S4 | [Uniswap/v4-periphery `src/lens/StateView.sol`](https://github.com/Uniswap/v4-periphery/blob/main/src/lens/StateView.sol) | Official repo | `main` | 2026-09-12 | Offchain read surface: `getSlot0`, `getLiquidity`, `getTickInfo` |
| S5 | [Uniswap/v4-periphery `src/lens/V4Quoter.sol`](https://github.com/Uniswap/v4-periphery/blob/main/src/lens/V4Quoter.sol) | Official repo | `main` | 2026-09-12 | Quote entrypoints; non-view, "should not be called on-chain" |
| S6 | [Uniswap/v4-periphery `src/interfaces/IV4Quoter.sol`](https://github.com/Uniswap/v4-periphery/blob/main/src/interfaces/IV4Quoter.sol) | Official repo | `main` | 2026-09-12 | `QuoteExactSingleParams` shape |
| S7 | [docs: StateView guide](https://docs.uniswap.org/contracts/v4/guides/state-view) | Official docs | current | 2026-09-12 | Why offchain clients use StateView/`extsload` rather than the onchain library |
| S8 | Robinhood Chain mainnet | Verified on-chain | block 61335868–61336785 | 2026-09-12 | Deployed addresses; live `extsload` reads (§4) |
| S9 | This repo — `src/pons/abiV2.ts` | Existing implementation | `feature/phase-7d3-…` | 2026-09-12 | V2 factory ABI, already Blockscout-verified against `0x7eD598Bc…` |

**Licences:** v4-core and v4-periphery are official Uniswap repositories. Nothing is being
copied verbatim — only ABI shapes, documented constants, and the storage layout needed to
read public state. No third-party parser or indexer code is reused.

---

## 2. Verbatim protocol facts

**PoolKey (S1)** — 5 slots, `0xa0` bytes:

```solidity
struct PoolKey {
    Currency currency0;   // lower address, sorted numerically
    Currency currency1;   // higher address, sorted numerically
    uint24   fee;
    int24    tickSpacing;
    IHooks   hooks;
}
```

**PoolId (S2):**

```solidity
function toId(PoolKey memory poolKey) internal pure returns (PoolId poolId) {
    assembly ("memory-safe") { poolId := keccak256(poolKey, 0xa0) }
}
```

**Storage layout (S3):**

```solidity
bytes32 public constant POOLS_SLOT      = bytes32(uint256(6));
uint256 public constant LIQUIDITY_OFFSET = 3;

bytes32 stateSlot = keccak256(abi.encodePacked(PoolId.unwrap(poolId), POOLS_SLOT));
// slot0 word unpacking:
sqrtPriceX96 := and(data, 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF)
tick         := signextend(2, shr(160, data))
protocolFee  := and(shr(184, data), 0xFFFFFF)
lpFee        := and(shr(208, data), 0xFFFFFF)
// liquidity: extsload(stateSlot + LIQUIDITY_OFFSET), low 128 bits
```

**Quoter params (S6):**

```solidity
struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }
```

`V4Quoter`'s functions are **non-view** and revert internally by design (S5), so they are
callable only via `eth_call` / `simulateContract` — which is precisely the read-only,
never-broadcast shape §6 requires.

---

## 3. Deployed addresses (S8, verified live)

Resolved from the V2 factory's own view functions — not hardcoded — and each confirmed to
contain bytecode:

| Role | Address | Code size |
|---|---|---|
| PonsV2LaunchFactory | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` | (env `PONS_V2_FACTORY`) |
| **PoolManager** | `0x8366a39CC670B4001A1121B8F6A443A643e40951` | 24 009 bytes |
| PositionManager | `0x58daec3116aae6D93017bAAea7749052E8a04fA7` | 23 877 bytes |
| **MemeHook** | `0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044` | 15 167 bytes |
| Locker | `0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952` | 1 969 bytes |
| GraduationExecutor | `0xC7819B64A1dAECD7eC19856d026cb14EfBd89046` | 4 402 bytes |
| BuybackVault | `0x42df2a798f82289E177311362e8f5ccC45c1219c` | 4 602 bytes |

> The V1 factory (`PONS_FACTORY = 0xA5aAb3F0…`) **reverts** on `poolManager()`/`memeHook()`.
> V1 and V2 are different protocol generations; V1 is Uniswap V3-based (see `abi.ts`).

---

## 4. Live verification of the read path

`StateView` was **not found deployed** on this chain and is not exposed by the factory.
That is not a blocker: `PoolManager` inherits `Extsload` (S7), so the same reads work
directly against the singleton using StateLibrary's documented slot math.

Verified at block 61336785 against three **real graduated** PONS V2 tokens whose `poolId`
is already persisted in `DiscoveredToken`:

| Token | tick | sqrtPriceX96 | liquidity | lpFee |
|---|---|---|---|---|
| `0x21884b3a…` | 206441 | 2407030232340610454972439148666636 | 29277002188455995940778 | 0 |
| `0x187b69cb…` | 202303 | 1957118313924283804406354740154025 | 29277002188455995869079 | 0 |
| `0x8407d207…` | 184615 | 808270180264336878212076392646016 | 29277002188455996030401 | 0 |

**Independent cross-check.** Price derived two ways — from the exact `sqrtPriceX96`
(`(sqrtPriceX96 / 2^96)^2`, computed in integer space) and from the coarse tick grid
(`1.0001^tick`) — agree to better than 1e-4 relative error:

| tick | from tick | from sqrtPriceX96 | rel. error |
|---|---|---|---|
| 206441 | 9.229336e+08 | 9.230047e+08 | 7.7e-05 |
| 202303 | 6.101946e+08 | 6.102039e+08 | 1.5e-05 |
| 184615 | 1.040703e+08 | 1.040768e+08 | 6.3e-05 |

Two independent derivations agreeing to tick resolution is strong evidence the slot
derivation and bit unpacking are correct. **This is inferred-then-confirmed behaviour, and
it is labelled as such**: it should be locked with raw regression fixtures (captured
`extsload` words + expected decode) before any normalization ships.

---

## 5. Repository gap analysis

### Already present (no work needed)

- V2 factory ABI, Blockscout-verified, including `getLaunchedToken` returning **`poolFee`
  (uint24)** and **`tickSpacing` (int24)** — two of the five `PoolKey` fields.
- `memeHook()` resolvable on-chain → the `hooks` field.
- `token` + `pairToken` → `currency0`/`currency1` after numeric sort.
- **`poolId` is already persisted** on `DiscoveredToken` for graduated V2 tokens.
- `ChainTrade` normalization, decimal-safe string amounts, checkpointing, reorg recovery.

### Missing

| # | Gap | Affects |
|---|---|---|
| G1 | No curve-state ABI. `abiV2.ts` covers the **factory**, not the bonding-curve contract. No way to read virtual/real reserves, so pre-graduation price and liquidity cannot come from state. | §5 (V2 pre-graduation) |
| G2 | No `extsload`/StateLibrary reader. The math is now verified (§4) but unimplemented. | §5 (V2 post-graduation) |
| G3 | No `PoolKey` builder or `PoolId` derivation in code. Needed for non-graduated pools and for quoting; the persisted `poolId` covers only graduated rows. | §5, §6 |
| G4 | **No V4Quoter deployment found** on Robinhood Chain, and none exposed by the factory. | §6 — **blocking** |
| G5 | No fee semantics. Live pools report `lpFee = 0`; MemeHook is 15 kB, so fees are plausibly dynamic. Reporting "0% fee" from this would be wrong. | §5, §6 |
| G6 | Price today is derived from executed trade amounts (`ponsV2Adapter.ts:303`, `quoteAmount/tokenAmount`), i.e. last-trade price, not pool state. Honest, but not "pool evidence". | §5 |
| G7 | No V1 curve/V3 pool reader. V1 is a different generation (Uniswap V3). | §5 (V1) |

### Open questions — must be answered before implementing, not guessed

1. **Does MemeHook require non-empty `hookData`** for swaps/quotes? A wrong assumption
   produces quotes that cannot execute.
2. **Is the pool a dynamic-fee pool?** V4 flags these in `PoolKey.fee`. If so, the `fee`
   used for `PoolId` derivation differs from the effective swap fee, and `lpFee = 0` in
   slot0 is expected rather than anomalous.
3. **Does MemeHook implement custom swap accounting** (`beforeSwap` returning a delta)? If
   it does, pool-state math alone does not predict execution and only a quoter/simulation
   is truthful.
4. **Pre-graduation curve interface** — needs the verified curve ABI from Blockscout, the
   same way `abiV2.ts` was sourced.
5. **Is `graduationThreshold` denominated in the quote asset?** Bonding progress is
   currently computed as `pairedPrincipal / threshold`; that should be confirmed rather
   than assumed.

---

## 6. Recommended sequencing

1. **Fixtures first.** Capture raw `extsload` words + `getLaunchedToken` returns for a set
   of real tokens (graduated and not) as regression fixtures, per `CLAUDE.md` item 5.
2. **§5 post-graduation** — implement the verified read path (G2/G3). Report
   `sqrtPriceX96`, tick, liquidity, native price, block and calculation version. USD stays
   unavailable. Lowest risk: the math is verified end-to-end above.
3. **Answer Q1–Q3** by fetching the verified MemeHook ABI and decoding a real graduated
   swap. Until then, §6 cannot be honest.
4. **§6** — resolve G4. Either deploy a `V4Quoter` on Robinhood Chain, or, if a hook
   delta makes offchain math unsound, expose inputs + price impact rather than a single
   executable number, which §5's own wording already permits.
5. **§5 pre-graduation (G1)** and **V1 (G7)** — separate, each needing its own verified ABI.

Nothing above is implementable from memory, which is the point of this document.
