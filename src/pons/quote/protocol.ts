/**
 * Phase 7D.3.2 — addresses, ABIs and source references for Pons V2 quoting.
 *
 * Every entry here was checked on Robinhood Chain (4663) on 2026-09-13, not recalled. The
 * full trail is docs/phase-7d3-2-quote-verification.md; the short version is recorded in
 * `QUOTE_SOURCE_REFERENCES` because each quote snapshot carries it.
 *
 * ABI fragments are copied from Blockscout-verified sources of the deployed contracts. In
 * one place that matters: the deployed UniversalRouter embeds a newer V4Router than the
 * quoter's pinned v4-periphery, and its single-hop params carry `minHopPriceX36`.
 */

import { parseAbi } from "viem";

export const ROBINHOOD_CHAIN_ID = 4663;

/** Uniswap v4 official deployments, "Robinhood Chain: 4663" (developers.uniswap.org, accessed 2026-09-13). */
export const UNISWAP_V4_ROBINHOOD = {
  poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  /** Runtime bytecode identical to v4-periphery 6601a199 compiled with release settings. */
  v4Quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
  stateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
  universalRouter: "0x8876789976decbfcbbbe364623c63652db8c0904",
  permit2: "0x000000000022d473030f116ddee9f6b43ac78ba3",
} as const;

/** Multicall3's canonical address; bytecode present on chain 4663 (3808 bytes). */
export const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";

export const NATIVE_CURRENCY = "0x0000000000000000000000000000000000000000";

/** GraduationPhase in ILaunchpadV2.sol. Only two of the four are tradable. */
export const PONS_V2_PHASE = {
  NOT_GRADUATED: 0,
  SWEPT: 1,
  POOL_CREATED: 2,
  RESCUED: 3,
} as const;

export interface SourceReference {
  id: string;
  kind: "official-docs" | "official-repo" | "verified-contract" | "fork-execution";
  ref: string;
  version: string;
  accessed: string;
  reliedOn: string;
}

export const QUOTE_SOURCE_REFERENCES: readonly SourceReference[] = [
  {
    id: "uniswap-v4-deployments",
    kind: "official-docs",
    ref: "https://developers.uniswap.org/docs/protocols/v4/deployments",
    version: "Robinhood Chain: 4663 table",
    accessed: "2026-09-13",
    reliedOn: "PoolManager, V4Quoter, StateView, UniversalRouter and Permit2 addresses",
  },
  {
    id: "v4-periphery-quoter",
    kind: "official-repo",
    ref: "https://github.com/Uniswap/v4-periphery/blob/6601a199799294378f4df9819e6641b2391ef3c5/src/lens/V4Quoter.sol",
    version: "6601a199799294378f4df9819e6641b2391ef3c5",
    accessed: "2026-09-13",
    reliedOn: "Quoter entrypoints; runtime bytecode reproduced byte-for-byte against the deployment",
  },
  {
    id: "pons-v2-meme-hook",
    kind: "verified-contract",
    ref: "https://robinhoodchain.blockscout.com/address/0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044?tab=contract",
    version: "PonsV2MemeHook, solc 0.8.35, verified 2026-08-03",
    accessed: "2026-09-13",
    reliedOn: "afterSwap takes hookFeeBps + creatorTaxBps of the unspecified leg; hookData is ignored",
  },
  {
    id: "pons-v2-bonding-curve",
    kind: "verified-contract",
    ref: "https://robinhoodchain.blockscout.com/address/0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e?tab=contract",
    version: "PonsV2LaunchFactory bundle (PonsV2BondingCurve, PonsV2BondingCurveMath), verified 2026-08-04",
    accessed: "2026-09-13",
    reliedOn: "Curve buy/sell pricing, fee legs, clamp-and-refund at the sellable allocation, snipe tax",
  },
  {
    id: "fork-verification",
    kind: "fork-execution",
    ref: "evm-verification/evidence (block 62211539, 0x6554d2c6…4d25)",
    version: "68/68 quote-vs-execution rows exact",
    accessed: "2026-09-13",
    reliedOn: "Quotes equal recipient balance changes for every pool class, direction and size tested",
  },
];

export const V4_QUOTER_ABI = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  "function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)",
]);

export const STATE_VIEW_ABI = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);

export const PONS_MEME_HOOK_ABI = parseAbi([
  "function launches(bytes32 poolId) view returns (bool registered, bool memecoinIsCurrency0, address memecoin, address quoteToken, address creator, address buybackCreatorRecipient, address protocolFeeRecipient, uint16 creatorTaxBps, uint16 protocolFeeShareBps, uint16 buybackBurnBps, uint16 hookFeeBps, uint16 maxInternalPriceImpactBps, bool buybackEnabled)",
]);

export const PONS_CURVE_ABI = parseAbi([
  "function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)",
  "function feeBps() view returns (uint256)",
  "function creatorTaxBps() view returns (uint256)",
  "function sellableTokens() view returns (uint256)",
  "function graduated() view returns (bool)",
  "function readyToGraduate() view returns (bool)",
  "function snipeTaxStartBps() view returns (uint256)",
  "function snipeTaxSeconds() view returns (uint256)",
  "function launchedAt() view returns (uint256)",
  "function trackedQuote() view returns (uint256)",
  "function graduationThreshold() view returns (uint256)",
]);

export const ERC20_METADATA_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

export const MULTICALL3_ABI = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
  "function getCurrentBlockTimestamp() view returns (uint256 timestamp)",
]);

/** From the deployed UniversalRouter's verified source. */
export const UNIVERSAL_ROUTER_COMMANDS = { V4_SWAP: 0x10 } as const;
export const V4_ROUTER_ACTIONS = { SWAP_EXACT_IN_SINGLE: 0x06, SETTLE_ALL: 0x0c, TAKE_ALL: 0x0f } as const;
