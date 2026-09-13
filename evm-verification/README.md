# EVM verification harness

Solidity tests that answer protocol questions this repo's TypeScript cannot, by executing
the real contracts rather than reasoning about them.

Deliberately **not** wired into `npm test`: it needs Foundry and pulls the Uniswap V4
sources as git submodules, which would make the Node test suite slow and network-dependent
for everyone. Run it when a protocol claim needs proving.

## Setup

```bash
cd evm-verification
forge init --no-git .          # once, if lib/ is absent
forge install Uniswap/v4-periphery --no-git
forge test -vv
```

Runs entirely inside Foundry's own EVM: **no RPC, no fork, no private key, no gas.** That
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

Pons charges 200 bips, `FeeTakingHook` 123. The rate is irrelevant; the mechanism is what
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

**Conclusion:** deploying a `V4Quoter` on Robinhood Chain yields an honest, net-of-tax sell
quote for Phase 7D.3 §6. See `docs/phase-7d3-pool-evidence-research.md` §8 for the source
reading this confirms.
