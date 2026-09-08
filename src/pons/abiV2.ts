/**
 * Phase 7D §1 — verified Pons V2 / Uniswap V4 ABI fragments.
 *
 * Same rule as abi.ts: do not invent event/function layouts from prose.
 * Every fragment below was verified two ways:
 *
 * 1. Source: `PonsV2LaunchFactory` is Blockscout-verified at
 *    https://robinhoodchain.blockscout.com/address/0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e
 *    (fetched via its `/api/v2/smart-contracts/:address` endpoint, full
 *    verified ABI, 139 entries — only the fragments this module actually
 *    decodes or calls are reproduced here).
 * 2. On-chain: this factory is a *different protocol generation* from the
 *    one PONS_FACTORY (abi.ts) points at — verified by decoding a real,
 *    live transaction the user supplied,
 *    tx 0x3e9dcd19093da517aa3001975828065c846d785a4ac7858af76d52d4eec90914,
 *    block 52687031 (fetched from ROBINHOOD_RPC_HTTPS via
 *    eth_getTransactionReceipt — 58 logs). That single transaction both
 *    launched and graduated a token in one atomic call: log index 78 on
 *    this factory decoded cleanly as `TokenLaunched` (topic0
 *    0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607,
 *    computed via viem's `toEventSelector` from the ABI below and matched
 *    against the real log's topic0) for token
 *    0x07EBB29a38Fbcb41563817e5E19f2ceC619C90D2, and log index 111 on the
 *    same factory decoded cleanly as `PoolGraduated` (topic0
 *    0x0a44ef75df69c534f43cd6c1aa3ef8983065fe5fe79ef9e79f6494e6f258c259)
 *    for the same token, positionId 1534854. `getLaunchedToken()` and
 *    `totalSupply()` were both called live against that token post-launch
 *    and returned sane, internally consistent values (phase=2 i.e.
 *    graduated, graduationThreshold=4.2e18 matching PoolGraduated's
 *    pairTokenAmount exactly, totalSupply=1e27 matching PoolGraduated's
 *    tokenAmount's order of magnitude). `locker()`, `graduationExecutor()`,
 *    `memeHook()`, `buybackVault()`, `poolManager()`, and `positionManager()`
 *    were also called live and each returned an address that independently
 *    appears as a participant (staticcall target or log emitter) in that
 *    same transaction's internal-transaction trace and log set — cross-
 *    confirming these getters actually describe this deployment, not a
 *    same-named contract elsewhere.
 *
 * Unlike Pons V1 (Uniswap V3, no graduation event — abi.ts), Pons V2
 * launches onto a bonding curve first and graduates onto a Uniswap V4 pool
 * (via a hook contract, `memeHook()` — hooks are V4-only) with an explicit
 * on-chain event for that migration: `PoolGraduated`.
 */

import type { Abi } from "viem";

/** Only the fragments this phase actually decodes or calls — not the full 139-entry ABI. */
export const PONS_V2_FACTORY_ABI = [
  {
    type: "event",
    name: "TokenLaunched",
    inputs: [
      { indexed: true, name: "token", type: "address" },
      { indexed: true, name: "curve", type: "address" },
      { indexed: true, name: "deployer", type: "address" },
      { indexed: false, name: "pairToken", type: "address" },
      { indexed: false, name: "launchConfigId", type: "uint256" },
      { indexed: false, name: "graduationThreshold", type: "uint256" },
    ],
  },
  /**
   * The migration to Uniswap V4 this phase exists to detect. Unlike V1,
   * this is a real event, not a polled read — verified above.
   */
  {
    type: "event",
    name: "PoolGraduated",
    inputs: [
      { indexed: true, name: "token", type: "address" },
      { indexed: false, name: "positionId", type: "uint256" },
      { indexed: false, name: "tokenAmount", type: "uint256" },
      { indexed: false, name: "pairTokenAmount", type: "uint256" },
    ],
  },
  {
    type: "event",
    name: "GraduationTokensPermanentlyLocked",
    inputs: [
      { indexed: true, name: "token", type: "address" },
      { indexed: false, name: "amount", type: "uint256" },
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
          { name: "curve", type: "address" },
          { name: "deployer", type: "address" },
          { name: "creatorFeeRecipient", type: "address" },
          { name: "pairToken", type: "address" },
          { name: "graduationThreshold", type: "uint256" },
          { name: "poolFee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "creatorTaxBps", type: "uint16" },
          { name: "buybackEnabled", type: "bool" },
          { name: "phase", type: "uint8" },
          { name: "sweptQuote", type: "uint256" },
          { name: "sweptTokens", type: "uint256" },
          { name: "sweptAt", type: "uint256" },
          { name: "exists", type: "bool" },
        ],
      },
    ],
  },
  // Self-describing related contracts — resolved at listener startup
  // instead of hardcoded per-address config (verified live against all six,
  // see header comment).
  { type: "function", name: "locker", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "graduationExecutor", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "memeHook", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "buybackVault", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "poolManager", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "positionManager", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  /**
   * Phase 7D §1 (metadata) — the real launch entrypoints. Verified against
   * the same Blockscout-fetched ABI as the rest of this file (139-entry
   * verified ABI for 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e), and
   * cross-checked live: decoding the real internal call inside tx
   * 0x3e9dcd19093da517aa3001975828065c846d785a4ac7858af76d52d4eec90914
   * (selector 0xa72101af, confirmed via viem's toFunctionSelector against
   * this exact fragment) returned name="Bundle Cat", symbol="BUN", a real
   * ipfs logo URL, a real description, and real socials — an exact match,
   * not an inference. `launchToken`'s 3-arg sibling (no
   * snipeTaxExemptions, selector 0xf35abbcf) and `launchTokenFor` (adds
   * originalDeployer, selector 0xd6a0eef5) share the same `params` tuple
   * shape and are included so any of the three real entrypoints decodes.
   */
  {
    type: "function",
    name: "launchToken",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "name", type: "string" },
          { name: "symbol", type: "string" },
          { name: "logo", type: "string" },
          { name: "description", type: "string" },
          {
            name: "socials",
            type: "tuple",
            components: [
              { name: "twitter", type: "string" },
              { name: "telegram", type: "string" },
              { name: "discord", type: "string" },
              { name: "website", type: "string" },
              { name: "farcaster", type: "string" },
            ],
          },
          { name: "creatorFeeRecipient", type: "address" },
          { name: "creatorTaxBps", type: "uint16" },
          { name: "buybackEnabled", type: "bool" },
          { name: "expectedEconomics", type: "bytes32" },
          { name: "salt", type: "bytes32" },
        ],
      },
      { name: "launchConfigId", type: "uint256" },
      { name: "pairToken", type: "address" },
      { name: "snipeTaxExemptions", type: "address[]" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "launchToken",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "name", type: "string" },
          { name: "symbol", type: "string" },
          { name: "logo", type: "string" },
          { name: "description", type: "string" },
          {
            name: "socials",
            type: "tuple",
            components: [
              { name: "twitter", type: "string" },
              { name: "telegram", type: "string" },
              { name: "discord", type: "string" },
              { name: "website", type: "string" },
              { name: "farcaster", type: "string" },
            ],
          },
          { name: "creatorFeeRecipient", type: "address" },
          { name: "creatorTaxBps", type: "uint16" },
          { name: "buybackEnabled", type: "bool" },
          { name: "expectedEconomics", type: "bytes32" },
          { name: "salt", type: "bytes32" },
        ],
      },
      { name: "launchConfigId", type: "uint256" },
      { name: "pairToken", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "launchTokenFor",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "name", type: "string" },
          { name: "symbol", type: "string" },
          { name: "logo", type: "string" },
          { name: "description", type: "string" },
          {
            name: "socials",
            type: "tuple",
            components: [
              { name: "twitter", type: "string" },
              { name: "telegram", type: "string" },
              { name: "discord", type: "string" },
              { name: "website", type: "string" },
              { name: "farcaster", type: "string" },
            ],
          },
          { name: "creatorFeeRecipient", type: "address" },
          { name: "creatorTaxBps", type: "uint16" },
          { name: "buybackEnabled", type: "bool" },
          { name: "expectedEconomics", type: "bytes32" },
          { name: "salt", type: "bytes32" },
        ],
      },
      { name: "launchConfigId", type: "uint256" },
      { name: "pairToken", type: "address" },
      { name: "originalDeployer", type: "address" },
      { name: "snipeTaxExemptions", type: "address[]" },
    ],
    outputs: [],
  },
] as const satisfies Abi;

/**
 * Phase 7D §2 (transaction history) — the real, deployed Uniswap V4
 * singleton PoolManager on this chain (0x8366a39CC670B4001A1121B8F6A443A643e40951),
 * itself Blockscout-verified — fetched and confirmed live, not assumed
 * from public Uniswap v4-core docs alone. `Swap`/`Initialize` match the
 * public v4-core `IPoolManager` interface exactly.
 *
 * A graduated token's PoolId isn't in PoolGraduated — but graduation
 * always creates the pool in the same transaction, so the matching
 * `Initialize` log (by currency0/currency1) is the safe way to learn `id`,
 * never a hand-computed keccak256(PoolKey).
 */
export const UNISWAP_V4_POOL_MANAGER_ABI = [
  {
    type: "event",
    name: "Initialize",
    inputs: [
      { indexed: true, name: "id", type: "bytes32" },
      { indexed: true, name: "currency0", type: "address" },
      { indexed: true, name: "currency1", type: "address" },
      { indexed: false, name: "fee", type: "uint24" },
      { indexed: false, name: "tickSpacing", type: "int24" },
      { indexed: false, name: "hooks", type: "address" },
      { indexed: false, name: "sqrtPriceX96", type: "uint160" },
      { indexed: false, name: "tick", type: "int24" },
    ],
  },
  {
    type: "event",
    name: "Swap",
    inputs: [
      { indexed: true, name: "id", type: "bytes32" },
      { indexed: true, name: "sender", type: "address" },
      { indexed: false, name: "amount0", type: "int128" },
      { indexed: false, name: "amount1", type: "int128" },
      { indexed: false, name: "sqrtPriceX96", type: "uint160" },
      { indexed: false, name: "liquidity", type: "uint128" },
      { indexed: false, name: "tick", type: "int24" },
      { indexed: false, name: "fee", type: "uint24" },
    ],
  },
] as const satisfies Abi;
