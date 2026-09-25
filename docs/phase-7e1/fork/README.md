# Phase 7E.1 — fork execution evidence

Real BUY and SELL on both venues, against a real fork of Robinhood Chain (4663), driven by
the exact calldata the Phase 7E.1 execution service produces. Nothing is mocked: the fork
carries the deployed Pons factory, the real bonding curves, and Uniswap V4's PoolManager,
StateView, V4Quoter, UniversalRouter and Permit2 at their mainnet addresses with their
mainnet bytecode and state.

```
PONS_RUN_EXECUTION_FORK_TEST=true npx vitest run src/pons/execution/__tests__/execution.anvilFork.test.ts
```

Source: `src/pons/execution/__tests__/execution.anvilFork.test.ts`.
Machine-readable result: [`execution-fork-evidence.json`](./execution-fork-evidence.json).

## Chain of custody

Each leg runs the production path end to end, with no step substituting a fixture for the
one before it:

```
quotePonsV2  ->  venue.buildTransaction  ->  eth_sendTransaction of exactly that
                                             {to, data, value}
             ->  real receipt            ->  venue.reconcile
```

If the calldata the production builder emits is wrong, the transaction reverts here.

## What was used

| | |
|---|---|
| Chain | Robinhood Chain 4663, forked at block **72248960** |
| Fork node | anvil 1.5.1-stable (`--fork-url`, lazy state from a live archive RPC) |
| Wallet | `0xa6bEbe66A0F486CC2ad4Ab7D50319c32366B4F2E` (see the warning below) |
| Bonding-curve token | **SOCIAL** `0x923bfb0eb05e918f8b42db5503ded94a44dca4ff`, curve `0x81560d4875602daaf7de7b20fa54ce1b3ada0949` |
| Graduated token | **RBD** `0xb41c7ac9d46a980f8bdf1894b392a2a07ec9992a`, pool `0x5672a588…5b1b6e0d` |
| Router | UniversalRouter `0x8876789976decbfcbbbe364623c63652db8c0904` |
| Permit2 | `0x000000000022d473030f116ddee9f6b43ac78ba3` |
| PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` |
| Slippage | 300 bps; buy size 0.01 ETH; sells at half the acquired balance |

Both tokens are native-ETH quoted, so a buy needs no approval and a sell exercises the
full approval path.

## Results

| Leg | Selector | Gas | Token delta | ETH delta (ex-gas) | Approvals |
|---|---|---|---|---|---|
| Pons curve BUY | `0x59a87bc1` `buy(uint256,uint256,address)` | 103,153 | +1,351,767,018,079,350,583,032,607 | −10,000,000,000,000,000 | 0 |
| Pons curve SELL | `0xd04c6983` `sell(uint256,uint256,address)` | 84,315 | −675,883,509,039,675,291,516,303 | +4,907,415,504,126,201 | 1 |
| Uniswap V4 BUY | `0x3593564c` `execute(bytes,bytes[],uint256)` | 151,059 | +3,297,528,330,727,753,021,819 | −10,000,000,000,000,000 | 0 |
| Uniswap V4 SELL | `0x3593564c` `execute(bytes,bytes[],uint256)` | 142,615 | −1,648,764,165,363,876,510,909 | +4,900,987,845,454,555 | 2 |

Every leg confirmed, and `venue.reconcile()` read the fill back out of the venue's own
event. The curve legs also matched the recipient (`matchedWallet: true`); the V4 legs
cannot, because PoolManager's `Swap` carries no recipient.

## What each assertion proves

- **Exact balance arithmetic, not a range.** A native buy must move exactly
  `input + gas` out of the wallet; anything else would mean value leaked somewhere the
  plan did not declare.
- **Slippage is real, on chain.** Taking a live quote, doubling its `minimum`, and sending
  the resulting calldata reverts on both venues, and the token balance is unchanged. The
  test also decodes the minimum back out of the bytes, so it is proven to be in the
  transaction the wallet would sign — not merely in a response field.
- **Approvals are exact and consumed exactly.** The curve sell approves precisely the sell
  amount and the allowance is 0 afterwards. The V4 sell takes both legs
  (`ERC20 -> Permit2`, then `Permit2 -> router`), each for precisely the sell amount, and
  both are 0 afterwards — an exact approval leaves nothing behind for a later spender.
- **The approval step is load-bearing.** Sending the V4 sell *without* signing the
  approvals reverts and moves no tokens, so the plan's approval list is not decoration.
- **The V4 output figure is honest about the hook.** PoolManager's `Swap` is gross of the
  Pons hook's fee, so reconciliation reports slightly more than the wallet receives. The
  test asserts that direction rather than equality: equality would mean the hook fee had
  silently vanished.
- **Refusals fire against live state.** A tampered quote block hash is refused as
  `QUOTE_BLOCK_REORGED`; a wallet that does not hold the token is refused as
  `INSUFFICIENT_BALANCE`.

## Warning: the standard test wallets are compromised on this chain

Measured on Robinhood Chain **mainnet** on 2026-09-25: **all ten** of Foundry's and
Hardhat's well-known dev addresses — including `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`
— carry a deployed 23-byte contract that forwards every incoming wei to
`0xcc04506d439d338bde8ebbb074f17a54b7673b95`.

Anyone who uses a default test mnemonic against Robinhood Chain for real loses the funds.

On a fork this is silently destructive rather than loud. The first run of this suite paid a
sell to address #0: the transaction succeeded, `CurveSell` correctly named it as recipient,
and the seller's balance did not move. It reads exactly like a broken payout until you pull
the call trace:

```
CALL curve -> 0xf39f…2266                 value=4907415504126201   <- paid correctly
   CALL 0xf39f…2266 -> 0xcc0450…3b95      value=4907415504126201   <- swept
```

The suite therefore derives its own key and asserts the address carries no code before
using it. That assertion is a standing guard, not decoration.

## Scope

No transaction here is ever broadcast to mainnet (§21). anvil serves every write from its
own in-memory state; the only mainnet traffic is read-only state fetching for the fork.
A human still performs the §25 tiny-value mainnet smoke before real trading is enabled.
