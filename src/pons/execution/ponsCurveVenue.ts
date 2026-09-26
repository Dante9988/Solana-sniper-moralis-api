/**
 * Phase 7E.1 §6 — real BUY and SELL on an ungraduated Pons V2 bonding curve.
 *
 * The curve is its own contract and its own counterparty: no router, no Permit2, no pool
 * key. `buy(quoteIn, minTokensOut, recipient)` and `sell(tokensIn, minQuoteOut, recipient)`
 * are the entrypoints, both verified present in deployed curve bytecode and both driven
 * against the real contracts by the Phase 7D.3.2 fork simulator.
 *
 * Pricing is not re-implemented here. `quote()` and `simulate()` call the existing
 * services, so the numbers a user reviews come from the same code that the 68/68
 * quote-vs-execution fork evidence covers.
 */

import { decodeEventLog, type Hex } from "viem";

import { PONS_V2_CURVE_ABI } from "../abiV2";
import { ROBINHOOD_CHAIN_ID } from "../quote/protocol";
import { quotePonsV2, type PonsQuote, type QuoteOutcome, type QuoteRequest } from "../quote/quoteService";
import { simulateQuote, type SimulationOutcome } from "../quote/simulationService";
import { buildErc20Approval, isNative, readErc20Allowance } from "./approvals";
import { ADDRESS_RE, checkBalances, checkChain, checkQuoteStillValid, estimateGasLimit, unsignedTransaction } from "./buildCommon";
import { EXECUTION_CALLDATA_VERSION, PONS_CURVE_EXECUTION_ABI } from "./executionProtocol";
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

export class RobinhoodPonsExecutionVenue implements SpotExecutionVenue {
  readonly id = "ROBINHOOD_PONS_CURVE" as const;

  supports(quote: PonsQuote): boolean {
    return quote.venue === "PONS_V2_BONDING_CURVE" && quote.venueState.kind === "curve";
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
      return { status: "REFUSED", reason: "VENUE_MISMATCH", detail: "this quote was not produced by the bonding-curve venue" };
    }
    if (!ADDRESS_RE.test(walletAddress)) {
      return { status: "REFUSED", reason: "UNSUPPORTED_ROUTE", detail: "walletAddress must be a 20-byte hex address" };
    }
    const chain = checkChain(quote);
    if (chain) return chain;
    const validity = await checkQuoteStillValid(quote, deps.caller, now);
    if (validity) return validity;
    const balances = await checkBalances(quote, walletAddress, deps);
    if (balances) return balances;

    // Narrowed by supports(), but TypeScript needs it said out loud.
    if (quote.venueState.kind !== "curve") {
      return { status: "REFUSED", reason: "VENUE_MISMATCH", detail: "quote carries no curve state" };
    }
    const curve = quote.venueState.curve;
    const amountIn = BigInt(quote.input.amount);
    const minimumOut = BigInt(quote.output.minimum);
    const wallet = walletAddress.toLowerCase() as Hex;

    const approvals: ApprovalRequirement[] = [];
    if (!isNative(quote.input.currency)) {
      const current = await readErc20Allowance(deps.caller, { token: quote.input.currency, owner: wallet, spender: curve });
      if (!current.ok) return { status: "UNAVAILABLE", reason: "RPC_UNAVAILABLE", detail: current.detail };
      approvals.push(
        buildErc20Approval({
          chainId: ROBINHOOD_CHAIN_ID,
          token: quote.input.currency,
          tokenSymbol: quote.input.symbol,
          spender: curve,
          amount: amountIn,
          current: current.value,
          kind: "ERC20_TO_CURVE",
        })
      );
    }

    // A native-quoted curve takes the spend as BOTH the argument and msg.value, exactly as
    // the fork-verified simulator drives it.
    const value = quote.side === "buy" && isNative(quote.input.currency) ? amountIn : 0n;
    const swap = unsignedTransaction({
      to: curve,
      abi: PONS_CURVE_EXECUTION_ABI,
      functionName: quote.side === "buy" ? "buy" : "sell",
      args: [amountIn, minimumOut, wallet],
      value,
      description:
        quote.side === "buy"
          ? `Buy ${quote.output.symbol ?? "this token"}, receiving at least ${quote.output.minimum} base units.`
          : `Sell ${quote.input.symbol ?? "this token"}, receiving at least ${quote.output.minimum} base units.`,
    });
    swap.gasLimit = await estimateGasLimit({ from: wallet, to: curve, data: swap.data, value }, deps);

    const plan: ExecutionPlan = {
      venue: this.id,
      route: { kind: "BONDING_CURVE", target: curve },
      chainId: ROBINHOOD_CHAIN_ID,
      walletAddress: wallet,
      side: quote.side,
      tokenAddress: quote.tokenAddress,
      approvals,
      swap,
      poolId: null,
      outputCurrency: quote.output.currency,
      hookAddress: null,
      // The curve has no deadline parameter; its protection is minTokensOut/minQuoteOut.
      deadline: null,
      expectedOutput: quote.output.expected,
      minimumOutput: quote.output.minimum,
      quoteBlock: quote.block,
      calldataVersion: EXECUTION_CALLDATA_VERSION,
    };
    return { status: "BUILT", plan };
  }

  /**
   * Read the fill out of the curve's own event rather than trusting the quote.
   *
   * CurveBuy/CurveSell carry `recipient`, so a transaction that succeeded but paid someone
   * else is detectable — `matchedWallet` says so instead of silently crediting the user.
   *
   * The curve has no hook, and its events already report what the recipient received
   * (ponsV2Adapter relies on the same reading), so gross and net are the same number here
   * and the hook fee is null rather than zero: "no such thing" is not "nothing".
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

    const target = plan.route.target.toLowerCase();
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== target) continue;
      let decoded;
      try {
        decoded = decodeEventLog({ abi: PONS_V2_CURVE_ABI, topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex });
      } catch {
        continue; // Not one of the curve's two trade events.
      }
      const args = decoded.args as unknown as Record<string, bigint | string>;
      const recipient = String(args.recipient ?? "").toLowerCase();
      const matchedWallet = recipient === plan.walletAddress;
      if (decoded.eventName === "CurveBuy" && plan.side === "buy") {
        const out = String(args.tokensOut);
        // Only a fill that actually named this wallet may be reported as its receipt.
        return { ...base, actualInput: String(args.quoteIn), grossVenueOutput: out, netWalletOutput: matchedWallet ? out : null, matchedWallet };
      }
      if (decoded.eventName === "CurveSell" && plan.side === "sell") {
        const out = String(args.quoteOut);
        return { ...base, actualInput: String(args.tokensIn), grossVenueOutput: out, netWalletOutput: matchedWallet ? out : null, matchedWallet };
      }
    }
    // Confirmed, but the curve emitted nothing we recognise. Reported, never invented.
    return { ...base, failureReason: null };
  }
}
