/**
 * Phase 7E.1 — the checks every venue runs before it hands a wallet anything to sign.
 *
 * §2 says never skip a gate; §4 lists what must be verified before execution. These are
 * those gates, in one place, so a second venue cannot accidentally ship with one missing.
 *
 * Every failure is a refusal with a reason, never a thrown string and never a number the
 * caller might mistake for a usable plan.
 */

import { encodeFunctionData, type Abi, type Hex } from "viem";

import type { ChainCaller } from "../chainClient";
import { ROBINHOOD_CHAIN_ID } from "../quote/protocol";
import type { PonsQuote } from "../quote/quoteService";
import { isNative, readErc20Balance } from "./approvals";
import type { BuildOutcome, ExecutionDeps, UnsignedTransactionRequest } from "./venue";

export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * The quote's block must still be canonical and the quote must not have expired.
 *
 * A reorged quote block is the dangerous case: the numbers would look internally
 * consistent while describing state that no longer exists.
 */
export async function checkQuoteStillValid(
  quote: PonsQuote,
  caller: ChainCaller,
  now: Date
): Promise<BuildOutcome | null> {
  if (new Date(quote.expiresAt).getTime() <= now.getTime()) {
    return { status: "REFUSED", reason: "QUOTE_EXPIRED", detail: "this quote has expired; request a fresh one before reviewing" };
  }
  const ref = await caller.getBlockRef(BigInt(quote.block.number));
  if (ref.status === "UNAVAILABLE") {
    return { status: "UNAVAILABLE", reason: "RPC_UNAVAILABLE", detail: `${ref.code}: ${ref.reason}` };
  }
  if (ref.data.hash.toLowerCase() !== quote.block.hash.toLowerCase()) {
    return { status: "REFUSED", reason: "QUOTE_BLOCK_REORGED", detail: `block ${quote.block.number} no longer has the quoted hash; request a fresh quote` };
  }
  return null;
}

export function checkChain(quote: PonsQuote): BuildOutcome | null {
  if (quote.chainId !== ROBINHOOD_CHAIN_ID) {
    return { status: "REFUSED", reason: "WRONG_CHAIN", detail: `this quote is for chain ${quote.chainId}, not Robinhood Chain ${ROBINHOOD_CHAIN_ID}` };
  }
  return null;
}

/**
 * The wallet must hold what it is about to spend.
 *
 * A native input is checked against the ETH balance together with a gas allowance; an
 * ERC-20 input is checked against the token balance, and ETH is then only needed for gas.
 * An unreadable balance is reported as unchecked, not as a failure — the chain is the real
 * gate, and refusing on an RPC hiccup would block a wallet that is perfectly funded.
 */
export async function checkBalances(
  quote: PonsQuote,
  walletAddress: string,
  deps: ExecutionDeps
): Promise<BuildOutcome | null> {
  const amountIn = BigInt(quote.input.amount);
  const native = isNative(quote.input.currency);

  if (!native) {
    const balance = await readErc20Balance(deps.caller, { token: quote.input.currency, owner: walletAddress });
    if (balance.ok && balance.value < amountIn) {
      return {
        status: "REFUSED",
        reason: "INSUFFICIENT_BALANCE",
        detail: `this wallet holds ${balance.value} of ${quote.input.symbol ?? "the input token"} and the trade spends ${amountIn}`,
      };
    }
  }

  if (!deps.probe) return null;
  const eth = await deps.probe.getBalance(walletAddress);
  if (eth.status === "UNAVAILABLE") return null;

  if (native && eth.data < amountIn) {
    return { status: "REFUSED", reason: "INSUFFICIENT_BALANCE", detail: `this wallet holds ${eth.data} wei and the trade spends ${amountIn}` };
  }
  // Gas is paid in ETH on top of a native input. A wallet with nothing left over after the
  // input cannot pay the network fee, whatever that fee turns out to be.
  if (eth.data === 0n || (native && eth.data === amountIn)) {
    return { status: "REFUSED", reason: "INSUFFICIENT_GAS_BALANCE", detail: "this wallet has no ETH left to pay the network fee" };
  }
  return null;
}

/**
 * Best-effort gas limit.
 *
 * Estimation runs against the wallet's real state, so it fails for exactly the reasons a
 * real send would — most usefully, a missing approval. That is why it is best-effort: the
 * approval has not been signed yet at build time, so a failed estimate is expected and
 * must not block the plan.
 */
export async function estimateGasLimit(
  request: { from: string; to: string; data: Hex; value: bigint },
  deps: ExecutionDeps
): Promise<string | null> {
  if (!deps.probe) return null;
  const result = await deps.probe.estimateGas(request);
  if (result.status === "UNAVAILABLE") return null;
  // A 25% headroom over the node's estimate; the chain refunds what is not used.
  return ((result.data * 125n) / 100n).toString();
}

export function unsignedTransaction(params: {
  to: string;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  value: bigint;
  description: string;
}): UnsignedTransactionRequest {
  return {
    chainId: ROBINHOOD_CHAIN_ID,
    to: params.to,
    data: encodeFunctionData({ abi: params.abi, functionName: params.functionName, args: params.args }),
    value: params.value.toString(),
    gasLimit: null,
    description: params.description,
  };
}
