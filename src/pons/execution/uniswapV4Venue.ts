/**
 * Phase 7E.1 §7 — real BUY and SELL on a graduated Pons pool through Uniswap V4.
 *
 * The pool key is never taken from a user (§7). It arrives on the quote, where it was
 * rebuilt from the Pons factory record and cross-checked against the hook's own
 * `launches(poolId)` registration; a disagreement already refuses the quote upstream with
 * POOL_REGISTRATION_INCONSISTENT, so an unverifiable pool never reaches this code.
 *
 * The calldata is `encodeRouterExactInSingle` — the same encoder the Phase 7D.3.2 route
 * simulator drives through the real UniversalRouter on a fork. Building execution from
 * the simulator's own encoder is the point: what is simulated is what is signed.
 *
 * The one deliberate difference from the simulator: it approves uint256/uint160 max from a
 * throwaway synthetic account, and this asks the user for exactly the input amount (§11).
 */

import { decodeEventLog, type Hex } from "viem";

import { UNISWAP_V4_POOL_MANAGER_ABI } from "../abiV2";
import { NATIVE_CURRENCY, ROBINHOOD_CHAIN_ID, UNISWAP_V4_ROBINHOOD } from "../quote/protocol";
import { quotePonsV2, type PonsQuote, type QuoteOutcome, type QuoteRequest } from "../quote/quoteService";
import { simulateQuote, type SimulationOutcome } from "../quote/simulationService";
import { encodeRouterExactInSingle, type PoolKeyHex } from "../quote/v4Quote";
import { buildErc20Approval, buildPermit2Approval, isNative, readErc20Allowance, readPermit2Allowance } from "./approvals";
import { ADDRESS_RE, checkBalances, checkChain, checkQuoteStillValid, estimateGasLimit, unsignedTransaction } from "./buildCommon";
import {
  ERC20_TRANSFER_ABI,
  EXECUTION_CALLDATA_VERSION,
  EXECUTION_DEADLINE_SECONDS,
  PERMIT2_MAX_AMOUNT,
  PONS_HOOK_FEE_ABI,
  UNIVERSAL_ROUTER_ABI,
} from "./executionProtocol";
import type {
  ApprovalRequirement,
  BuildOutcome,
  BuildParams,
  ExecutionDeps,
  ExecutionPlan,
  ReceiptFacts,
  ReconciledExecution,
  SpotExecutionVenue,
} from "./venue";

export class RobinhoodUniswapV4ExecutionVenue implements SpotExecutionVenue {
  readonly id = "ROBINHOOD_UNISWAP_V4" as const;

  supports(quote: PonsQuote): boolean {
    return quote.venue === "PONS_V2_UNISWAP_V4" && quote.venueState.kind === "pool";
  }

  quote(request: QuoteRequest, deps: ExecutionDeps & { factoryAddress: string }): Promise<QuoteOutcome> {
    return quotePonsV2(request, { caller: deps.caller, factoryAddress: deps.factoryAddress, now: deps.now });
  }

  simulate(quote: PonsQuote, deps: ExecutionDeps): Promise<SimulationOutcome> {
    return simulateQuote(quote, { caller: deps.caller, now: deps.now });
  }

  async buildTransaction(params: BuildParams, deps: ExecutionDeps): Promise<BuildOutcome> {
    const { quote, walletAddress } = params;
    const now = (deps.now ?? (() => new Date()))();

    if (!this.supports(quote)) {
      return { status: "REFUSED", reason: "VENUE_MISMATCH", detail: "this quote was not produced by the Uniswap V4 venue" };
    }
    if (!ADDRESS_RE.test(walletAddress)) {
      return { status: "REFUSED", reason: "UNSUPPORTED_ROUTE", detail: "walletAddress must be a 20-byte hex address" };
    }
    const chain = checkChain(quote);
    if (chain) return chain;

    if (quote.venueState.kind !== "pool") {
      return { status: "REFUSED", reason: "VENUE_MISMATCH", detail: "quote carries no pool state" };
    }
    const amountIn = BigInt(quote.input.amount);
    const minimumOut = BigInt(quote.output.minimum);
    const wallet = walletAddress.toLowerCase() as Hex;
    const router = UNISWAP_V4_ROBINHOOD.universalRouter;
    const poolKey = quote.venueState.poolKey as PoolKeyHex;

    // Permit2's allowance field is uint160. A larger input cannot be approved at all, so
    // this is refused before any chain read: it is a pure arithmetic fact, and emitting
    // calldata that silently truncated the allowance would be far worse than refusing.
    if (!isNative(quote.input.currency) && amountIn > PERMIT2_MAX_AMOUNT) {
      return { status: "REFUSED", reason: "UNSUPPORTED_ROUTE", detail: "this amount exceeds the maximum a Permit2 approval can carry" };
    }

    const validity = await checkQuoteStillValid(quote, deps.caller, now);
    if (validity) return validity;
    const balances = await checkBalances(quote, walletAddress, deps);
    if (balances) return balances;

    // Both the swap deadline and the Permit2 expiration are compared by the chain against
    // block.timestamp, so both are derived from the quote's own block timestamp. Deriving
    // the expiration from this process's wall clock instead would let a clock offset
    // produce an approval that lapses before the swap it authorises, reverting with
    // AllowanceExpired even though the user approved.
    const chainNowSeconds = BigInt(quote.block.timestamp);

    const approvals: ApprovalRequirement[] = [];
    if (!isNative(quote.input.currency)) {
      const [erc20, permit2] = await Promise.all([
        readErc20Allowance(deps.caller, { token: quote.input.currency, owner: wallet, spender: UNISWAP_V4_ROBINHOOD.permit2 }),
        readPermit2Allowance(deps.caller, { token: quote.input.currency, owner: wallet, spender: router }),
      ]);
      if (!erc20.ok) return { status: "UNAVAILABLE", reason: "RPC_UNAVAILABLE", detail: erc20.detail };
      if (!permit2.ok) return { status: "UNAVAILABLE", reason: "RPC_UNAVAILABLE", detail: permit2.detail };

      approvals.push(
        buildErc20Approval({
          chainId: ROBINHOOD_CHAIN_ID,
          token: quote.input.currency,
          tokenSymbol: quote.input.symbol,
          spender: UNISWAP_V4_ROBINHOOD.permit2,
          amount: amountIn,
          current: erc20.value,
          kind: "ERC20_TO_PERMIT2",
        }),
        buildPermit2Approval({
          chainId: ROBINHOOD_CHAIN_ID,
          token: quote.input.currency,
          tokenSymbol: quote.input.symbol,
          spender: router,
          amount: amountIn,
          current: permit2.value,
          nowSeconds: chainNowSeconds,
        })
      );
    }

    const deadline = chainNowSeconds + EXECUTION_DEADLINE_SECONDS;
    const zeroForOne = quote.input.currency.toLowerCase() === poolKey.currency0.toLowerCase();
    const { commands, inputs } = encodeRouterExactInSingle({ poolKey, zeroForOne, amountIn, minimumOut });

    const value = isNative(quote.input.currency) ? amountIn : 0n;
    const swap = unsignedTransaction({
      to: router,
      abi: UNIVERSAL_ROUTER_ABI,
      functionName: "execute",
      args: [commands, inputs, deadline],
      value,
      description:
        quote.side === "buy"
          ? `Buy ${quote.output.symbol ?? "this token"}, receiving at least ${quote.output.minimum} base units.`
          : `Sell ${quote.input.symbol ?? "this token"}, receiving at least ${quote.output.minimum} base units.`,
    });
    swap.gasLimit = await estimateGasLimit({ from: wallet, to: router, data: swap.data, value }, deps);

    const plan: ExecutionPlan = {
      venue: this.id,
      route: { kind: "UNIVERSAL_ROUTER", target: router },
      chainId: ROBINHOOD_CHAIN_ID,
      walletAddress: wallet,
      side: quote.side,
      tokenAddress: quote.tokenAddress,
      approvals,
      swap,
      poolId: quote.venueState.poolId,
      outputCurrency: quote.output.currency,
      hookAddress: poolKey.hooks,
      deadline: deadline.toString(),
      expectedOutput: quote.output.expected,
      minimumOutput: quote.output.minimum,
      quoteBlock: quote.block,
      calldataVersion: EXECUTION_CALLDATA_VERSION,
    };
    return { status: "BUILT", plan };
  }

  /**
   * Read the fill out of PoolManager's Swap event, then work out what the wallet kept.
   *
   * `amount0`/`amount1` are signed TRADER-side deltas, not pool-side: positive is what the
   * trader received, negative what they paid. That is the convention
   * ponsV2Adapter.decodeTrade already relies on to classify a swap as a buy or a sell, and
   * getting it backwards would report the input as the output. Only the plan's own pool
   * counts — one transaction can touch several — so the event's indexed `id` is matched.
   *
   * That figure is GROSS. The Pons hook takes its fee from the unspecified leg after the
   * swap, so the wallet receives less. Net is established from evidence, strongest first:
   *
   *   1. an ERC-20 Transfer of the output currency to this wallet — the most direct
   *      statement that exists of what the wallet received;
   *   2. the hook's own HookFeeCollected(poolId, currency, feeAmount, taxAmount), which is
   *      the only source for a NATIVE output, where no transfer log is emitted at all;
   *   3. otherwise null.
   *
   * Null means unknown and must be surfaced as unknown. Falling back to gross here would
   * overstate every V4 fill by the hook's cut.
   *
   * Swap carries no recipient, so `matchedWallet` is only ever true when a Transfer to this
   * wallet proved it.
   */
  reconcile(params: { plan: ExecutionPlan; receipt: ReceiptFacts }): ReconciledExecution {
    const { plan, receipt } = params;
    const base: ReconciledExecution = {
      status: receipt.status === "success" ? "CONFIRMED" : "REVERTED",
      blockNumber: receipt.blockNumber.toString(),
      blockHash: receipt.blockHash,
      gasUsed: receipt.gasUsed.toString(),
      effectiveGasPrice: receipt.effectiveGasPrice?.toString() ?? null,
      actualInput: null,
      grossVenueOutput: null,
      netWalletOutput: null,
      hookFeeAmount: null,
      matchedWallet: false,
      failureReason: receipt.status === "success" ? null : "the transaction reverted on chain",
    };
    if (receipt.status !== "success") return base;

    const poolManager = UNISWAP_V4_ROBINHOOD.poolManager.toLowerCase();
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== poolManager) continue;
      let decoded;
      try {
        decoded = decodeEventLog({ abi: UNISWAP_V4_POOL_MANAGER_ABI, topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex });
      } catch {
        continue;
      }
      if (decoded.eventName !== "Swap") continue;
      const args = decoded.args as unknown as { id: string; amount0: bigint; amount1: bigint };
      if (plan.poolId && String(args.id).toLowerCase() !== plan.poolId.toLowerCase()) continue;

      // One leg is negative (paid by the trader) and one positive (received).
      const paid = args.amount0 < 0n ? args.amount0 : args.amount1;
      const gross = args.amount0 > 0n ? args.amount0 : args.amount1;
      if (paid >= 0n || gross <= 0n) continue;

      const transferred = transferToWallet(receipt, plan);
      const hookFee = hookFeeFor(receipt, plan);
      const net = transferred ?? (hookFee === null ? null : gross - hookFee);

      return {
        ...base,
        actualInput: (-paid).toString(),
        grossVenueOutput: gross.toString(),
        netWalletOutput: net === null ? null : net.toString(),
        hookFeeAmount: hookFee === null ? (net === null ? null : (gross - net).toString()) : hookFee.toString(),
        matchedWallet: transferred !== null,
      };
    }
    return base;
  }
}

/**
 * The output currency actually transferred to this wallet, summed across logs.
 *
 * Null for a native output, which emits no transfer log — that case falls through to the
 * hook's own event. Summing rather than taking the first match is deliberate: a route that
 * credits the wallet in more than one piece would otherwise under-report.
 */
function transferToWallet(receipt: ReceiptFacts, plan: ExecutionPlan): bigint | null {
  const currency = plan.outputCurrency.toLowerCase();
  if (currency === NATIVE_CURRENCY) return null;

  let total: bigint | null = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== currency) continue;
    let decoded;
    try {
      decoded = decodeEventLog({ abi: ERC20_TRANSFER_ABI, topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex });
    } catch {
      continue;
    }
    const args = decoded.args as unknown as { to: string; value: bigint };
    if (String(args.to).toLowerCase() !== plan.walletAddress.toLowerCase()) continue;
    total = (total ?? 0n) + args.value;
  }
  return total;
}

/** The hook's own declared take for this pool: fee plus creator tax. */
function hookFeeFor(receipt: ReceiptFacts, plan: ExecutionPlan): bigint | null {
  const hook = plan.hookAddress ? plan.hookAddress.toLowerCase() : null;
  for (const log of receipt.logs) {
    if (hook && log.address.toLowerCase() !== hook) continue;
    let decoded;
    try {
      decoded = decodeEventLog({ abi: PONS_HOOK_FEE_ABI, topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex });
    } catch {
      continue;
    }
    const args = decoded.args as unknown as { poolId: string; feeAmount: bigint; taxAmount: bigint };
    if (plan.poolId && String(args.poolId).toLowerCase() !== plan.poolId.toLowerCase()) continue;
    return args.feeAmount + args.taxAmount;
  }
  return null;
}
