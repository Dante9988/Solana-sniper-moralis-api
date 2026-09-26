/**
 * Phase 7E.1 §8 — the spot execution abstraction.
 *
 * A venue knows how to turn a quote into bytes a wallet can sign, and how to read the
 * resulting receipt back into amounts. It deliberately does NOT re-implement pricing:
 * `quote()` and `simulate()` delegate to the Phase 7D.3.2 services that are already
 * fork-verified, so there is one pricing path, not two.
 *
 * Chain-neutral on purpose (§18/§19): nothing in these types names Robinhood, EVM
 * calldata semantics aside. A Solana or Hyperliquid venue would implement the same five
 * methods. Neither is implemented in this phase, and no UI may imply otherwise.
 */

import type { Hex } from "viem";

import type { ChainCaller, ChainClientResult } from "../chainClient";
import type { PonsQuote, QuoteOutcome, QuoteRequest } from "../quote/quoteService";
import type { TradeSide } from "../quote/v4Quote";
import type { SimulationOutcome } from "../quote/simulationService";

export type ExecutionVenueId = "ROBINHOOD_PONS_CURVE" | "ROBINHOOD_UNISWAP_V4";

/**
 * Wallet-specific chain reads, kept optional on purpose.
 *
 * A null gas limit means "let the wallet estimate", which every EVM wallet does anyway,
 * and an unknown ETH balance means the gas check is reported as unchecked rather than
 * failed. Making either mandatory would force every existing ChainCaller test double to
 * grow methods it has no opinion about, and neither is load-bearing for safety: the chain
 * rejects an underfunded transaction regardless of what we predicted.
 */
export interface WalletProbe {
  getBalance(address: string): Promise<ChainClientResult<bigint>>;
  estimateGas(params: { from: string; to: string; data: Hex; value: bigint }): Promise<ChainClientResult<bigint>>;
}

export interface ExecutionDeps {
  caller: ChainCaller;
  probe?: WalletProbe;
  now?: () => Date;
}

/**
 * One transaction for the connected wallet to sign.
 *
 * `value` and `gasLimit` are decimal strings in base units — never JS numbers, which
 * cannot hold 18-decimal amounts exactly. `description` is what the review screen shows;
 * it must read like a sentence to a non-technical user.
 */
export interface UnsignedTransactionRequest {
  chainId: number;
  to: string;
  data: Hex;
  value: string;
  gasLimit: string | null;
  description: string;
}

/**
 * Why a step is needed and whether it already is. Three kinds exist because the two routes
 * pull funds differently:
 *
 *   ERC20_TO_CURVE    the curve does a plain transferFrom
 *   ERC20_TO_PERMIT2  the router pulls through Permit2, so the token must approve Permit2
 *   PERMIT2_TO_ROUTER and Permit2 must then be told the router may spend
 *
 * Native ETH input produces none of them.
 */
export type ApprovalKind = "ERC20_TO_CURVE" | "ERC20_TO_PERMIT2" | "PERMIT2_TO_ROUTER";

export interface ApprovalRequirement {
  kind: ApprovalKind;
  token: string;
  tokenSymbol: string | null;
  spender: string;
  /** Exactly the input amount. §11: never silently request an unlimited allowance. */
  required: string;
  current: string;
  /** Permit2 allowances also expire; an unexpired-but-too-small one is still unsatisfied. */
  currentExpiresAt: string | null;
  satisfied: boolean;
  transaction: UnsignedTransactionRequest;
}

export interface ExecutionPlan {
  venue: ExecutionVenueId;
  route: { kind: "BONDING_CURVE" | "UNIVERSAL_ROUTER"; target: string };
  chainId: number;
  walletAddress: string;
  side: TradeSide;
  tokenAddress: string;
  /** In order. Every unsatisfied approval must land before `swap` is signed. */
  approvals: ApprovalRequirement[];
  swap: UnsignedTransactionRequest;
  /**
   * The V4 pool this plan trades, so reconciliation can ignore Swap logs from other pools
   * in the same transaction. Null on the curve, which has no pool.
   */
  poolId: string | null;
  /** Needed at reconcile time to find the wallet's receipt among the transfer logs. */
  outputCurrency: string;
  /**
   * The V4 hook whose fee separates gross from net. Null on the curve, which has none.
   * Pinned on the plan so reconciliation only trusts the hook the quote was built against,
   * never an arbitrary contract that emits a look-alike event.
   */
  hookAddress: string | null;
  /** Unix seconds. Null on the curve, which has no deadline parameter. */
  deadline: string | null;
  expectedOutput: string;
  minimumOutput: string;
  quoteBlock: PonsQuote["block"];
  calldataVersion: string;
}

export type BuildFailureReason =
  | "REAL_TRADING_DISABLED"
  | "QUOTE_EXPIRED"
  | "QUOTE_BLOCK_REORGED"
  | "WRONG_CHAIN"
  | "INSUFFICIENT_BALANCE"
  | "INSUFFICIENT_GAS_BALANCE"
  | "VENUE_MISMATCH"
  | "UNSUPPORTED_ROUTE";

export type BuildOutcome =
  | { status: "BUILT"; plan: ExecutionPlan }
  | { status: "REFUSED"; reason: BuildFailureReason; detail: string }
  | { status: "UNAVAILABLE"; reason: "RPC_UNAVAILABLE" | "PROVIDER_CAPABILITY"; detail: string };

export interface BuildParams {
  quote: PonsQuote;
  walletAddress: string;
}

/**
 * What a confirmed transaction actually did, read back from its receipt and logs rather
 * than assumed from the quote. §2: a hash existing is not success.
 *
 * Output is deliberately TWO numbers, because on Uniswap V4 they differ. PoolManager's
 * `Swap` reports the swap's gross result, and the Pons hook then takes its fee from the
 * unspecified leg afterwards — so the wallet receives less than `Swap` says. Measured on a
 * fork: a 3,449,006,522,633,093,919,091 gross buy credited the wallet
 * 3,414,516,457,406,762,979,901, a 34,490,065,226,330,939,190 difference.
 *
 * Showing the gross figure as "you received" would overstate every V4 fill, so the two are
 * never collapsed into one field. `netWalletOutput` is null when it cannot be established
 * from evidence, and null must be surfaced as unknown rather than back-filled with gross.
 */
export interface ReconciledExecution {
  status: "CONFIRMED" | "REVERTED";
  blockNumber: string;
  blockHash: string;
  gasUsed: string;
  effectiveGasPrice: string | null;
  /** Null when the venue's event was not found in the receipt — reported, never guessed. */
  actualInput: string | null;
  /** What the venue's own event reported. Gross of any hook fee on Uniswap V4. */
  grossVenueOutput: string | null;
  /** What the wallet actually received. The only figure a UI may call "received". */
  netWalletOutput: string | null;
  /** The hook's take, when it is knowable. Null on the curve, which has no hook. */
  hookFeeAmount: string | null;
  /** True when the venue's own trade event named this wallet as the recipient. */
  matchedWallet: boolean;
  failureReason: string | null;
}

export interface ReceiptLog {
  address: string;
  topics: string[];
  data: string;
}

export interface ReceiptFacts {
  status: "success" | "reverted";
  blockNumber: bigint;
  blockHash: string;
  gasUsed: bigint;
  effectiveGasPrice: bigint | null;
  logs: readonly ReceiptLog[];
}

/** §8's interface, with pricing delegated rather than duplicated. */
export interface SpotExecutionVenue {
  readonly id: ExecutionVenueId;
  /** True when this venue is the one that produced the quote. */
  supports(quote: PonsQuote): boolean;
  quote(request: QuoteRequest, deps: ExecutionDeps & { factoryAddress: string }): Promise<QuoteOutcome>;
  simulate(quote: PonsQuote, deps: ExecutionDeps): Promise<SimulationOutcome>;
  buildTransaction(params: BuildParams, deps: ExecutionDeps): Promise<BuildOutcome>;
  reconcile(params: { plan: ExecutionPlan; receipt: ReceiptFacts }): ReconciledExecution;
}
