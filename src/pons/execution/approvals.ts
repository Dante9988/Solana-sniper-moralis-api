/**
 * Phase 7E.1 §11 — allowance state and the approval transactions that fix it.
 *
 * Two things here are deliberate and easy to get wrong:
 *
 * 1. Approvals are NOT sell-only. 39,930 of the 139,008 discovered Pons tokens on this
 *    chain are quoted in an ERC-20, so buying one also spends an ERC-20 and also needs an
 *    approval. Only a native-ETH input escapes.
 *
 * 2. Allowances are read at `latest`, not at the quote's pinned block. An approval that
 *    landed after the quote is good news, and pinning would hide it and ask the user to
 *    approve a second time.
 *
 * The amounts requested are exact (§11). `PonsRouteSimulator` approves uint256/uint160 max
 * because it is a throwaway synthetic account inside an eth_call; production must not, so
 * the production path is stricter than the simulated one and is covered by its own tests.
 */

import { encodeFunctionData, type Hex } from "viem";

import type { ChainCaller } from "../chainClient";
import { NATIVE_CURRENCY, UNISWAP_V4_ROBINHOOD } from "../quote/protocol";
import {
  ERC20_EXECUTION_ABI,
  PERMIT2_ABI,
  PERMIT2_APPROVAL_SECONDS,
  PERMIT2_MAX_AMOUNT,
} from "./executionProtocol";
import type { ApprovalRequirement, UnsignedTransactionRequest } from "./venue";

export function isNative(currency: string): boolean {
  return currency.toLowerCase() === NATIVE_CURRENCY;
}

export type AllowanceOutcome<T> = { ok: true; value: T } | { ok: false; detail: string };

/** Plain ERC-20 allowance, at `latest`. */
export async function readErc20Allowance(
  caller: ChainCaller,
  params: { token: string; owner: string; spender: string }
): Promise<AllowanceOutcome<bigint>> {
  const result = await caller.readContract<bigint>({
    address: params.token,
    abi: ERC20_EXECUTION_ABI as never,
    functionName: "allowance",
    args: [params.owner, params.spender],
  });
  if (result.status === "UNAVAILABLE") return { ok: false, detail: `${result.code}: ${result.reason}` };
  return { ok: true, value: result.data };
}

export async function readErc20Balance(caller: ChainCaller, params: { token: string; owner: string }): Promise<AllowanceOutcome<bigint>> {
  const result = await caller.readContract<bigint>({
    address: params.token,
    abi: ERC20_EXECUTION_ABI as never,
    functionName: "balanceOf",
    args: [params.owner],
  });
  if (result.status === "UNAVAILABLE") return { ok: false, detail: `${result.code}: ${result.reason}` };
  return { ok: true, value: result.data };
}

export interface Permit2Allowance {
  amount: bigint;
  expiration: bigint;
  nonce: bigint;
}

/**
 * Permit2's packed allowance. Verified on chain 4663 to return three words.
 *
 * `expiration` is a unix second, and Permit2 treats a value at or below `block.timestamp`
 * as expired — so an allowance with a large amount and a past expiration is worth nothing.
 */
export async function readPermit2Allowance(
  caller: ChainCaller,
  params: { token: string; owner: string; spender: string }
): Promise<AllowanceOutcome<Permit2Allowance>> {
  const result = await caller.readContract<readonly [bigint, number | bigint, number | bigint]>({
    address: UNISWAP_V4_ROBINHOOD.permit2,
    abi: PERMIT2_ABI as never,
    functionName: "allowance",
    args: [params.owner, params.token, params.spender],
  });
  if (result.status === "UNAVAILABLE") return { ok: false, detail: `${result.code}: ${result.reason}` };
  const [amount, expiration, nonce] = result.data;
  return { ok: true, value: { amount, expiration: BigInt(expiration), nonce: BigInt(nonce) } };
}

function tx(params: { chainId: number; to: string; data: Hex; description: string }): UnsignedTransactionRequest {
  return { chainId: params.chainId, to: params.to, data: params.data, value: "0", gasLimit: null, description: params.description };
}

function amountLabel(symbol: string | null): string {
  return symbol ?? "this token";
}

export function buildErc20Approval(params: {
  chainId: number;
  token: string;
  tokenSymbol: string | null;
  spender: string;
  amount: bigint;
  current: bigint;
  kind: "ERC20_TO_CURVE" | "ERC20_TO_PERMIT2";
}): ApprovalRequirement {
  const spenderLabel = params.kind === "ERC20_TO_CURVE" ? "the trade" : "Uniswap's Permit2";
  return {
    kind: params.kind,
    token: params.token,
    tokenSymbol: params.tokenSymbol,
    spender: params.spender,
    required: params.amount.toString(),
    current: params.current.toString(),
    currentExpiresAt: null,
    satisfied: params.current >= params.amount,
    transaction: tx({
      chainId: params.chainId,
      to: params.token,
      data: encodeFunctionData({ abi: ERC20_EXECUTION_ABI, functionName: "approve", args: [params.spender as Hex, params.amount] }),
      description: `Allow ${spenderLabel} to use exactly this amount of ${amountLabel(params.tokenSymbol)}.`,
    }),
  };
}

/**
 * The second leg of an ERC-20 swap through the UniversalRouter.
 *
 * The expiration is set from the caller's clock plus PERMIT2_APPROVAL_SECONDS, which is
 * longer than the swap deadline on purpose: an approval that expires first makes the swap
 * revert with AllowanceExpired even though the user approved.
 */
export function buildPermit2Approval(params: {
  chainId: number;
  token: string;
  tokenSymbol: string | null;
  spender: string;
  amount: bigint;
  current: Permit2Allowance;
  nowSeconds: bigint;
}): ApprovalRequirement {
  if (params.amount > PERMIT2_MAX_AMOUNT) {
    throw new RangeError("amount exceeds Permit2's uint160 allowance field");
  }
  const expiration = params.nowSeconds + PERMIT2_APPROVAL_SECONDS;
  const live = params.current.expiration > params.nowSeconds;
  return {
    kind: "PERMIT2_TO_ROUTER",
    token: params.token,
    tokenSymbol: params.tokenSymbol,
    spender: params.spender,
    required: params.amount.toString(),
    current: (live ? params.current.amount : 0n).toString(),
    currentExpiresAt: params.current.expiration === 0n ? null : new Date(Number(params.current.expiration) * 1000).toISOString(),
    satisfied: live && params.current.amount >= params.amount,
    transaction: tx({
      chainId: params.chainId,
      to: UNISWAP_V4_ROBINHOOD.permit2,
      data: encodeFunctionData({
        abi: PERMIT2_ABI,
        functionName: "approve",
        args: [params.token as Hex, params.spender as Hex, params.amount, Number(expiration)],
      }),
      description: `Allow the trade router to use exactly this amount of ${amountLabel(params.tokenSymbol)} for the next ${Number(PERMIT2_APPROVAL_SECONDS) / 60} minutes.`,
    }),
  };
}
