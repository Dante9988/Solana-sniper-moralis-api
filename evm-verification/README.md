# EVM verification harness

Solidity tests that answer protocol questions this repo's TypeScript cannot, by executing
the real contracts rather than reasoning about them.

Deliberately **not** wired into `npm test`: it needs Foundry and pinned Uniswap sources.
CI runs it in its own `foundry-verification` job, pinned to **Foundry v1.8.1**. Use the same
version locally: on this Arbitrum-based chain, Foundry 1.8 returns the parent-chain block from
`NUMBER`, so the fork suite pins by `block.timestamp` (see the write-up, §10).

## Two kinds of result — never mix them up

| Suite | Contracts | Needs | Result kind |
|---|---|---|---|
| `test/*.t.sol` | v4-core test hooks in a fresh local PoolManager | nothing | **test-hook** |
| `test/fork/*.t.sol` | the real Robinhood Chain PoolManager, PonsV2MemeHook, curves, UniversalRouter, Permit2, official V4Quoter at block 62211539 | archive RPC | **actual-Pons** |

Full write-up: [`docs/phase-7d3-2-quote-verification.md`](../docs/phase-7d3-2-quote-verification.md).

## Setup

```bash
cd evm-verification
scripts/install-deps.sh        # v4-periphery 6601a199, v4-core 59d3ecf5 — checked after checkout
forge test -vv                 # test-hook suite
ROBINHOOD_FORK_RPC_URL=… scripts/fork-verify.sh   # actual-Pons suite; exit 78 = BLOCKED
```

`fork-verify.sh --from-dotenv` uses the backend's own RPC failover list locally. URLs are
never printed. Curated results land in `evidence/`.

`test/QuoterHookDelta.t.sol` (below) runs entirely inside Foundry's own EVM: **no RPC, no fork, no private key, no gas.** That
matters here — it stayed usable while the Alchemy monthly quota was exhausted and every
mainnet read was failing.

## `test/QuoterHookDelta.t.sol`

**Question:** does `V4Quoter`'s `amountOut` already account for a hook that takes its cut
in `afterSwap` via a returned delta?

This gated the decision to deploy a `V4Quoter` on Robinhood Chain. If the quoter reported
raw pool output, a deployed quoter would have been confidently ~2% high on every Pons
sell — worse than offering no quote.

**Why `FeeTakingHook`:** the Pons MemeHook
(`0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044`) decodes to permissions `0x2044` —
`AFTER_SWAP | AFTER_SWAP_RETURNS_DELTA` (plus `BEFORE_INITIALIZE`). v4-core's own
`FeeTakingHook` has exactly that mechanism: it takes a percentage of swap output with
`manager.take` and returns the amount as an `int128` delta. The hook is mounted with
**only** the two swap flags, matching Pons — granting liquidity flags would invoke fee
paths Pons does not have.

`FeeTakingHook` charges 123 bips. (This section originally said Pons charges 200. The fork suite later showed the real take is `hookFeeBps` (100) plus a per-launch creator tax of 0–500.) The rate is irrelevant; the mechanism is what
is under test.

**Result — answered, and the quote is net of the tax:**

```
untaxed quote (control) : 996006981039903
taxed quote             : 983756095173113
shortfall               :  12250885866790   = 1.23%, exactly the hook's fee

quoted                  : 983756095173113
actually received       : 983756095173113   <- identical
```

Four tests:

- `test_quoteMatchesExecution_withoutHook` — control; no hook, quote == execution.
- `test_quoteMatchesExecution_withAfterSwapTaxHook` — **the question**; quote == execution
  with the tax hook mounted.
- `test_hookActuallyReducesOutput` — proves the hook genuinely takes a cut, so the test
  above is not vacuously true.
- `test_quoteMatchesExecutionAcrossSizes` — holds at 1e12, 1e14, 1e15 and 5e15, not just
  one convenient amount.

**Conclusion:** a `V4Quoter` on Robinhood Chain yields an honest, net-of-tax sell quote. No
deployment turned out to be needed: Uniswap's official quoter is already deployed there and
byte-identical to the pinned source (`docs/phase-7d3-2-quote-verification.md` §1). The fork
suite confirms quote == execution against the real MemeHook. See `docs/phase-7d3-pool-evidence-research.md` §8 for the source
reading this confirms.
