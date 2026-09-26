/**
 * Phase 7E.1 — the write side of the Robinhood Chain venues.
 *
 * `src/pons/quote/protocol.ts` holds everything needed to READ a price. This file adds
 * only what is needed to BUILD a transaction a user's wallet will sign, and nothing here
 * is recalled: every selector below was checked against the deployed bytecode on chain
 * 4663 on 2026-09-25, and the checks are reproducible from `EXECUTION_SOURCE_REFERENCES`.
 *
 * Verification performed (see the reference entries for the exact calls):
 *   - Permit2 0x0000…78ba3 is deployed (9,152 bytes) and `allowance(address,address,address)`
 *     returns three words, matching AllowanceTransfer's PackedAllowance
 *     (uint160 amount, uint48 expiration, uint48 nonce).
 *   - UniversalRouter 0x8876…0904 is deployed (24,546 bytes).
 *   - A live PonsV2BondingCurve (0x0749…2df8, the curve for DRIFT) contains the
 *     `buy(uint256,uint256,address)` and `sell(uint256,uint256,address)` selectors.
 *
 * Nothing in this module ever sees, accepts or returns a private key, seed phrase or
 * signature. It produces calldata; the wallet does the rest.
 */

import { parseAbi } from "viem";

import { type SourceReference } from "../quote/protocol";

/** Bump when a change here alters the bytes a wallet would be asked to sign. */
export const EXECUTION_CALLDATA_VERSION = "pons-v2-execution-1";

export const EXECUTION_SOURCE_REFERENCES: readonly SourceReference[] = [
  {
    id: "permit2-allowance-transfer",
    kind: "official-repo",
    ref: "https://github.com/Uniswap/permit2/blob/main/src/interfaces/IAllowanceTransfer.sol",
    version: "AllowanceTransfer PackedAllowance { uint160 amount; uint48 expiration; uint48 nonce; }",
    accessed: "2026-09-25",
    reliedOn: "approve(token,spender,amount,expiration) and the allowance(user,token,spender) getter's three-word return",
  },
  {
    id: "permit2-deployment-4663",
    kind: "verified-contract",
    ref: "eth_call 0x927da105 to 0x000000000022d473030f116ddee9f6b43ac78ba3 on chain 4663",
    version: "9152 runtime bytes; returned 3 words for a zero triple",
    accessed: "2026-09-25",
    reliedOn: "Permit2 exists on Robinhood Chain and exposes the allowance getter this code reads",
  },
  {
    id: "pons-curve-execution-selectors",
    kind: "verified-contract",
    ref: "eth_getCode 0x074995b1c320d5e125b2105c08035f319aa82df8 (DRIFT's curve) on chain 4663",
    version: "10229 runtime bytes; selectors 0x59a87bc1 and 0xd04c6983 present",
    accessed: "2026-09-25",
    reliedOn: "buy(uint256,uint256,address) payable and sell(uint256,uint256,address) are the curve's execution entrypoints",
  },
  {
    id: "pons-route-simulator",
    kind: "fork-execution",
    ref: "evm-verification/src/PonsRouteSimulator.sol + test/fork/PonsRouteSimulatorFork.t.sol",
    version: "Phase 7D.3.2",
    accessed: "2026-09-25",
    reliedOn: "The approval shape each route needs, proven by driving the real contracts on a fork",
  },
];

/**
 * ERC-20 write surface.
 *
 * `approve` is declared as returning bool. Some tokens return nothing; that is a decode
 * concern for a caller reading the result, and irrelevant here because the wallet submits
 * this calldata and the chain decides. We never decode an approve return.
 */
export const ERC20_EXECUTION_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
]);

/**
 * Permit2's AllowanceTransfer surface.
 *
 * The router does not spend an ordinary ERC-20 allowance. It pulls through Permit2, so an
 * ERC-20 input needs TWO approvals: `ERC20.approve(PERMIT2, amount)` and then
 * `Permit2.approve(token, router, amount, expiration)`. Missing or expired, the swap
 * reverts with `AllowanceExpired(uint256)` — already mapped in simulationService's
 * KNOWN_REVERTS.
 */
export const PERMIT2_ABI = parseAbi([
  "function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);

/** PonsV2BondingCurve's execution entrypoints, as driven by the fork-verified simulator. */
export const PONS_CURVE_EXECUTION_ABI = parseAbi([
  "function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256)",
  "function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256)",
]);

export const UNIVERSAL_ROUTER_ABI = parseAbi([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
]);

/**
 * The Pons hook's own fee event — the only authoritative statement of what it took.
 *
 * PoolManager's `Swap` reports the swap's GROSS output. The hook then takes its cut from
 * the unspecified leg afterwards, so the wallet receives less than `Swap` says. For an
 * ERC-20 output that gap is visible as a second Transfer, but for a native-ETH output
 * there is no log at all — this event is what makes the net knowable in both cases.
 *
 * Verified 2026-09-25 against the hook's Sourcify-verified source
 * (contracts/src/v2/hooks/PonsV2MemeHook.sol:99, emitted at :483) and against its real
 * logs on a Robinhood Chain fork.
 */
export const PONS_HOOK_FEE_ABI = parseAbi([
  "event HookFeeCollected(bytes32 indexed poolId, address currency, uint256 feeAmount, uint256 taxAmount)",
]);

/** ERC-20 Transfer, used to read a token output's net receipt straight off the wire. */
export const ERC20_TRANSFER_ABI = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

/** uint160 max — Permit2's amount field is uint160, not uint256. */
export const PERMIT2_MAX_AMOUNT = (1n << 160n) - 1n;
/** uint48 max — Permit2 treats this expiration as "block.timestamp", i.e. immediate. */
export const PERMIT2_MAX_EXPIRATION = (1n << 48n) - 1n;

/**
 * How long a swap has to land once signed, and how long a Permit2 approval stays valid.
 *
 * The approval must outlive the swap deadline or the swap reverts even though the user
 * approved: they are deliberately not the same number, and the approval is the longer one.
 */
export const EXECUTION_DEADLINE_SECONDS = 600n;
export const PERMIT2_APPROVAL_SECONDS = 1_800n;
