/**
 * Phase 7B.4 §3/§8 — verified Pons + Uniswap V3 ABI fragments.
 *
 * Per this repo's external-protocol rule: do not invent event/function
 * layouts from prose. Every fragment below was verified two ways, not
 * assumed from documentation:
 *
 * 1. Source: github.com/ponsdotdev/ponsfamily, root `abi.json` +
 *    `contract-meta.json` (accessed 2026-09-06). `contract-meta.json`
 *    names factory address 0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB
 *    explicitly — the exact address in PONS_FACTORY — so this ABI is
 *    confirmed to be for the deployed contract we're integrating with, not
 *    a same-named contract elsewhere. Repo is MIT-licensed
 *    (LICENSE file present at repo root).
 * 2. On-chain: computed each event's topic0 with viem's toEventSelector
 *    and matched it against real logs pulled with eth_getLogs from
 *    https://rpc.mainnet.chain.robinhood.com. Real matches found at:
 *      - TokenDeployed + TokenLaunched: block 9019252,
 *        tx 0x92476c6f12444023711b221057dcffab166f673027479008f959ca37f5f21eb7
 *      - Swap (pool 0x8f4F723f10fc7bAD28742d25c91158C728557C4c, created by
 *        that same TokenLaunched): block 9019252,
 *        tx 0x92476c6f12444023711b221057dcffab166f673027479008f959ca37f5f21eb7
 *    graduationStatus and getLaunchedToken were both called live against
 *    that pool's token (0x055650555Be80649397084Cd3f8a09b4350e8612) and
 *    returned sane, internally-consistent values (threshold exactly
 *    4.2e18 wei, matching the documented default; pairedPrincipal <
 *    threshold with graduated=false).
 *
 * WETH_QUOTE (0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73) matched the
 * pairToken/pairedToken field on that same real TokenLaunched log —
 * confirmed as the quote token, but its bytecode is a proxy, not canonical
 * WETH9. Per phase7b4.txt §3, this slice never calls WETH functions on it;
 * it is used only to identify the quote side of a pair and to read
 * decimals(). Do not assume deposit()/withdraw() semantics.
 */

import type { Abi } from "viem";

/** Only the fragments this phase actually decodes or calls — not the full 60-entry ABI. */
export const PONS_FACTORY_ABI = [
  {
    type: "event",
    name: "TokenLaunched",
    inputs: [
      { indexed: true, name: "token", type: "address" },
      { indexed: true, name: "deployer", type: "address" },
      { indexed: true, name: "dexFactory", type: "address" },
      { indexed: false, name: "pairToken", type: "address" },
      { indexed: false, name: "pool", type: "address" },
      { indexed: false, name: "dexId", type: "uint256" },
      { indexed: false, name: "launchConfigId", type: "uint256" },
      { indexed: false, name: "positionId", type: "uint256" },
      { indexed: false, name: "restrictionsEndBlock", type: "uint256" },
      { indexed: false, name: "initialBuyAmount", type: "uint256" },
    ],
  },
  {
    type: "event",
    name: "TokenDeployed",
    inputs: [
      { indexed: true, name: "token", type: "address" },
      { indexed: true, name: "deployer", type: "address" },
      { indexed: true, name: "dexFactory", type: "address" },
      { indexed: false, name: "pairToken", type: "address" },
      { indexed: false, name: "dexId", type: "uint256" },
      { indexed: false, name: "launchConfigId", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "graduationStatus",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      { name: "pairedPrincipal", type: "uint256" },
      { name: "threshold", type: "uint256" },
      { name: "graduated", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "getLaunchedToken",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      {
        type: "tuple",
        name: "",
        components: [
          { name: "token", type: "address" },
          { name: "deployer", type: "address" },
          { name: "pairedToken", type: "address" },
          { name: "positionManager", type: "address" },
          { name: "positionId", type: "uint256" },
          { name: "dexId", type: "uint256" },
          { name: "launchConfigId", type: "uint256" },
          { name: "restrictionsEndBlock", type: "uint256" },
          { name: "supply", type: "uint256" },
          { name: "isToken0", type: "bool" },
          { name: "poolFee", type: "uint24" },
          { name: "exists", type: "bool" },
          { name: "initialBuyAmount", type: "uint256" },
        ],
      },
    ],
  },
] as const satisfies Abi;

/**
 * Phase 7B.5B §2 — the standard ERC-20 `decimals()` view function (EIP-20,
 * https://eips.ethereum.org/EIPS/eip-20, selector `0x313ce567`). Used to
 * verify each Pons-launched token's and WETH_QUOTE's real decimal count
 * rather than assuming 18 (phase7b5b.txt §2: "Never simply assume 18
 * decimals because this is an EVM chain"). This is the universal ERC-20
 * interface, not a Pons-specific contract — no separate on-chain
 * verification step is needed the way abi.ts's Pons-specific fragments
 * above required one; every ERC-20 token on Robinhood Chain (an EVM chain)
 * is expected to implement it, and a token that reverts/fails this call is
 * treated as decimals-unresolved (fail closed — see
 * src/candles/decimalsResolver.ts), never defaulted to 18.
 */
export const ERC20_ABI = [
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const satisfies Abi;

/**
 * Standard Uniswap V3 pool Swap event. Public, stable, identical on every
 * chain V3 has been deployed to — but still verified on-chain above rather
 * than trusted from memory, per this repo's protocol rule.
 */
export const UNISWAP_V3_POOL_ABI = [
  {
    type: "event",
    name: "Swap",
    inputs: [
      { indexed: true, name: "sender", type: "address" },
      { indexed: true, name: "recipient", type: "address" },
      { indexed: false, name: "amount0", type: "int256" },
      { indexed: false, name: "amount1", type: "int256" },
      { indexed: false, name: "sqrtPriceX96", type: "uint160" },
      { indexed: false, name: "liquidity", type: "uint128" },
      { indexed: false, name: "tick", type: "int24" },
    ],
  },
] as const satisfies Abi;
