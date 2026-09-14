# Phase 7D.3.2 — PONS quote verification

**Date:** 2026-09-13 · **Chain:** Robinhood Chain (4663) · **Pinned block:** 62211539,
hash `0x6554d2c6d1a1b2f99b9782f9d4157c125b6d051129d859df0fdb4395751d4d25`
(confirmed by two independent providers on every run). Toolchain: **Foundry 1.8.1**, pinned in CI.

This supersedes the "no V4Quoter deployed" conclusion (G4) in
`phase-7d3-pool-evidence-research.md`, and the "2% creator tax" fee assumption in §7.3 of that
document. Both were wrong; see §1 and §3.

---

## 1. Headline findings

1. **An official V4Quoter already exists.** Uniswap's v4 deployments page lists Robinhood
   Chain with a Quoter at `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` (deployed block 9074)
   bound to the same PoolManager Pons uses. Its runtime bytecode (6118 bytes) is **identical**
   to v4-periphery `6601a199…` compiled with Uniswap's release settings. No OnlyPump deployment
   is needed, so no deployment script, gas estimate or mainnet broadcast is part of this
   phase. Mainnet quoting is live, not blocked.
2. **The hook fee is not just `creatorTaxBps`.** `PonsV2MemeHook._afterSwap` takes
   `hookFeeBps + creatorTaxBps` of the **unspecified** leg, both snapshotted per pool in
   `launches(poolId)`. At the pinned block every graduated pool had `hookFeeBps = 100`; creator
   tax ranged 0–500. Total take is 1–6%.
3. **Native ETH is not always `currency0`.** 75 of 164 graduated pools pair with an ERC-20
   (USDG 6 dp, cbBTC 8 dp, tokenized stocks 18 dp); in 35 the memecoin is `currency0`.
4. **Quotes equal execution.** 68/68 fork rows exact (§4).
5. **A successful quote is not sellability**, and **the quoter does not guard size** — both
   recorded as execution, not assumed (§5).

## 2. Source matrix

| # | Source | Type | Version | Accessed | Relied upon |
|---|---|---|---|---|---|
| S1 | [Uniswap v4 deployments](https://developers.uniswap.org/docs/protocols/v4/deployments) | Official docs | "Robinhood Chain: 4663" | 2026-09-13 | PoolManager, Quoter, StateView, UniversalRouter, Permit2 addresses |
| S2 | [Uniswap/v4-periphery](https://github.com/Uniswap/v4-periphery/tree/6601a199799294378f4df9819e6641b2391ef3c5) | Official repo (MIT/GPL) | `6601a199` (v4-core `59d3ecf5`) | 2026-09-13 | V4Quoter source; bytecode reproduced |
| S3 | [PonsV2MemeHook](https://robinhoodchain.blockscout.com/address/0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044?tab=contract) | Verified contract | solc 0.8.35, verified 2026-08-03 | 2026-09-13 | Fee legs, `launches()`, hookData ignored |
| S4 | [PonsV2LaunchFactory bundle](https://robinhoodchain.blockscout.com/address/0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e?tab=contract) | Verified contract | solc 0.8.35, verified 2026-08-04 | 2026-09-13 | `PonsV2BondingCurve`, `PonsV2BondingCurveMath`, `GraduationPhase`, `PonsV2LauncherToken` |
| S5 | [UniversalRouter](https://robinhoodchain.blockscout.com/address/0x8876789976decbfcbbbe364623c63652db8c0904?tab=contract) | Verified contract | solc 0.8.26, verified 2026-05-26 | 2026-09-13 | `execute`, Actions, `ExactInputSingleParams` incl. `minHopPriceX36` |
| S6 | Robinhood Chain mainnet | On-chain | blocks 62206898–62228549 | 2026-09-13 | 220 Pons swaps (top sender: UniversalRouter), launch survey, live quotes |
| S7 | `evm-verification/` fork suite | Fork execution | block 62211539 | 2026-09-13 | §4, §5 |

No third-party parser or indexer code is reused. Conflicts between sources: S1 contradicts the
earlier repository research (G4); S3 contradicts its fee inference. Observed execution (S7)
agrees with S1–S5.

## 3. Contract identities

| Role | Address | Evidence |
|---|---|---|
| PoolManager | `0x8366a39c…0951` | S1; `factory.poolManager()`; quoter/StateView `poolManager()` |
| V4Quoter (official) | `0x8dc178ef…8f94` | S1; bytecode == S2 at `6601a199`, via-IR, 44 444 444 runs, `bytecode_hash=none` |
| StateView | `0xf3334192…673b` | S1 |
| UniversalRouter | `0x88767899…0904` | S1; top sender of Pons swaps in S6 |
| Permit2 | `0x00000000…8BA3` | S1 |
| PonsV2MemeHook | `0xE5e70264…e044` | `factory.memeHook()`; S3 |
| PonsV2LaunchFactory | `0x7eD598Bc…EC7e` | `PONS_V2_FACTORY`; S4 |

## 4. Quote vs execution (actual-Pons, fork)

`scripts/fork-verify.sh` → `evidence/*.jsonl`. Every row: quote from the official quoter (and an
identical quoter deployed from pinned source), swap executed through the deployed
UniversalRouter, recipient balance change measured, `HookFeeCollected` reconciled.

| Class | Rows | Exact |
|---|---|---|
| Native ETH pools, tax 0/200/500, buys + sells × 3 sizes | 18 | 18 |
| USDG (6 dp), memecoin currency0 and currency1 | 12 | 12 |
| 18 dp ERC-20 pair, memecoin currency0 | 6 | 6 |
| cbBTC (8 dp), memecoin currency0 | 6 | 6 |
| Exact-output buys (fee moves to the input leg) | 7 | 7 |
| Bonding curve buys/sells (native, USDG) | 18 | 18 |
| Bonding curve clamped buy (refund) | 1 | 1 |

Route simulator (`PonsRouteSimulatorFork.t.sol`): buy, sell with overridden token balance,
curve buy/sell, below-minimum revert, and detection of an override that did not apply.
Live mainnet `eth_call` of the same calldata returned the fork's exact output on both providers.

**Test-hook vs actual-Pons.** `test/QuoterHookDelta.t.sol` (FeeTakingHook, local PoolManager)
remains as mechanism evidence only. Everything in this section is actual-Pons.

## 5. Recorded failure modes

| Case | Result | File |
|---|---|---|
| Exact output larger than pool inventory | Quoter reverts `UnexpectedRevertBytes(SafeCastOverflow())` — not `NotEnoughLiquidity` | `v4-insufficient-liquidity.json` |
| 1 000 000 ETH exact input | Quote succeeds **and executes**, spending all input (99.99% loss) | `v4-oversized-input.json` |
| Min output = quote + 1 | `V4TooLittleReceived(quote+1, quote)` | test assertion |
| Another trade lands first | Same minimum reverts with the requoted amount | test assertion |
| Unapproved holder sells | Valid quote; sell reverts `AllowanceExpired(0)` (Permit2) | `v4-quote-ok-sell-reverts.json` |
| Pool key with wrong tickSpacing | Quoter reverts | test assertion |
| Sell after curve allocation exhausted | Curve reverts | test assertion |

Consequences in the API: any quoter revert is `QUOTER_REVERTED`; all-in price impact ≥ 50% is
refused (`PRICE_IMPACT_EXCEEDS_POLICY`); every quote states `QUOTE_IS_NOT_SELLABILITY`.

## 6. Supported and unsupported paths

| Launch state | Quotes | Simulation | Market evidence |
|---|---|---|---|
| Phase 0, curve | Curve formula at pinned block | Real curve via state override | Yes |
| Phase 0, inside snipe window (3 s) | **Refused** — snipe tax not modelled | — | Flagged |
| Phase 1 Swept | **Unsupported** — no venue trades | — | Unsupported |
| Phase 2 PoolCreated | Official V4Quoter | UniversalRouter via state override | Yes |
| Phase 3 Rescued | **Unsupported** | — | Unsupported |
| Pons V1 (Uniswap V3) | **Unsupported** (not researched in this phase) | — | — |
| ERC-20 input whose balance slot cannot be verified | Quote only | **Unsupported** | Yes |

Balance slots are accepted only after `balanceOf` returns the probed value. Observed: Pons tokens
and USDG use slot 0; cbBTC and BULL use the OpenZeppelin v5 ERC-7201 namespace.

## 7. Liquidity semantics

- Raw V4 active liquidity `L` appears only as `advanced.activeLiquidityRaw`. Every native pool
  at graduation reported `L ≈ 2.93e22` regardless of price — it is not an amount of anything.
- "Depth" means fixed reference sizes (0.1%, 1%, 5% of the pair-side reserve) and what they
  return, computed by the same verified methods as quotes.
- Curve `realQuoteHeld` is what the curve holds; the pricing reserve includes a virtual amount
  and is labelled so.
- USD: unavailable.

## 8. Precision

Spot prices use 1e36 scaling. With 1e18, LASSIE/USDG (tick −407072, ~1.9e-18 USDG base units
per token base unit) truncated to 1–2 and real 3% shortfalls read as 0 bps. Regression:
`src/pons/__tests__/v4Quote.test.ts` asserts every fork swap shows at least its fee.

The hook fee split is recovered from the net quote by search; flooring makes it ambiguous by at
most 1 base unit in 3 of 42 fork swaps, so it is reported as a range with `exact: false`.

## 9. Reproduce

```bash
cd evm-verification
scripts/install-deps.sh                      # pinned v4-periphery / v4-core
forge test                                   # test-hook suite, no RPC
ROBINHOOD_FORK_RPC_URL=<archive RPC> scripts/fork-verify.sh   # exit 0 PASS, 1 FAIL, 78 BLOCKED
FOUNDRY_PROFILE=fork forge build && node scripts/export-simulator.mjs   # after editing the simulator
```

## 10. Toolchain notes (found in CI)

- **`block.number` on this chain.** Robinhood Chain is Arbitrum-based: the `NUMBER` opcode
  returns the parent-chain block (`l1BlockNumber` in the RPC header). At the pinned block that
  is 25970664, and Foundry 1.8 emulates it on a fork; Foundry 1.5 reported 62211539. The suite
  therefore pins the fork in-EVM by `block.timestamp` (1789328376) and accepts either number,
  while `fork-verify.sh` verifies number and hash against two providers before forking.
- **Quoter gas estimates depend on the EVM implementation.** Re-running on 1.8.1 changed
  `quoterGasEstimate` in every V4 row (e.g. 72461 → 84961) and nothing else: every quoted
  amount and observed balance change is identical. 1.8.1's figures are closer to live mainnet
  (84044 for a comparable buy). Gas estimates are informational and never used for amounts.

## 11. Deployment script

Not produced. §1.1 makes it unnecessary: the official quoter is deployed and byte-verified.
Approved with the product owner on 2026-09-13.
