/**
 * Phase 7D.3.2 §5 — amount-specific, block-pinned quotes for Pons V2 tokens.
 *
 * Supported paths, both execution-verified on a mainnet fork:
 *   - PONS_V2_BONDING_CURVE  (phase 0): curve formula over pinned view state
 *   - PONS_V2_UNISWAP_V4     (phase 2): the official V4Quoter via eth_call
 *
 * Explicitly unsupported, with a reason code and never a number: phase 1 (Swept — neither
 * curve nor pool trades), phase 3 (Rescued), tokens the factory does not know, pools whose
 * hook registration disagrees with the factory, the curve's anti-snipe window, quoter
 * reverts, and trades whose price impact exceeds policy.
 *
 * A quote is an ESTIMATE at one block. It is not an execution simulation (see
 * simulationService.ts) and it is not a fill.
 */

import { type Hex } from "viem";

import { PONS_V2_FACTORY_ABI } from "../abiV2";
import type { ChainCaller } from "../chainClient";
import { buildPoolKey, poolIdFor } from "../v4PoolState";
import {
  CURVE_QUOTE_CALCULATION_VERSION,
  curveSpotQuotePerTokenX36,
  curveSpotTokenPerQuoteX36,
  quoteCurveBuy,
  quoteCurveSell,
  type CurveState,
} from "./curveQuote";
import { PinnedReadError, multicallAt, readValue, snapshotAt, type ContractRead, type PinnedBlockWithTime } from "./pinnedReads";
import {
  ERC20_METADATA_ABI,
  NATIVE_CURRENCY,
  PONS_CURVE_ABI,
  PONS_MEME_HOOK_ABI,
  PONS_V2_PHASE,
  QUOTE_SOURCE_REFERENCES,
  ROBINHOOD_CHAIN_ID,
  STATE_VIEW_ABI,
  UNISWAP_V4_ROBINHOOD,
  V4_QUOTER_ABI,
  type SourceReference,
} from "./protocol";
import {
  V4_QUOTE_CALCULATION_VERSION,
  minimumOutput,
  reconstructHookTake,
  shortfallVsSpotBps,
  spotOutPerInX36,
  v4Direction,
  type PoolKeyHex,
  type TradeSide,
} from "./v4Quote";

/** Bump when any rule below that changes a quote's numbers or refusals changes. */
export const QUOTE_POLICY_VERSION = "quote-policy-1";

export const QUOTE_POLICY = {
  /** Quotes expire on wall-clock time; blocks on this chain are sub-second. */
  ttlMs: 30_000,
  minSlippageBps: 1,
  maxSlippageBps: 5_000,
  /** All-in shortfall vs spot at or above which a quote carries a warning. */
  warnPriceImpactBps: 1_000,
  /** Refuse outright. The fork evidence shows the quoter will happily quote a 99.99% loss. */
  maxPriceImpactBps: 5_000,
  maxAmount: (1n << 128n) - 1n,
} as const;

export type Venue = "PONS_V2_BONDING_CURVE" | "PONS_V2_UNISWAP_V4";

export type UnsupportedReason =
  | "ZERO_AMOUNT"
  | "UNKNOWN_TOKEN"
  | "PROTOCOL_MISMATCH"
  | "GRADUATION_IN_PROGRESS"
  | "LAUNCH_RESCUED"
  | "POOL_REGISTRATION_INCONSISTENT"
  | "SNIPE_WINDOW_OPEN"
  | "CURVE_GRADUATED"
  | "OUTPUT_ROUNDS_TO_ZERO"
  | "INSUFFICIENT_LIQUIDITY"
  | "CURVE_CANNOT_PAY"
  | "QUOTER_REVERTED"
  | "PRICE_IMPACT_EXCEEDS_POLICY";

export interface AssetAmount {
  currency: string;
  symbol: string | null;
  decimals: number;
  amount: string;
}

export interface FeeLine {
  kind: "CURVE_PROTOCOL_FEE" | "CURVE_CREATOR_TAX" | "HOOK_FEE" | "HOOK_CREATOR_TAX";
  bps: number;
  currency: string;
  chargedOn: "INPUT" | "OUTPUT";
  /** Exact when the calculation determines it; otherwise a 1-wei range (see reconstructHookTake). */
  amount: { min: string; max: string; exact: boolean };
}

export interface Limitation {
  code: string;
  message: string;
}

export interface PonsQuote {
  chain: "robinhood";
  chainId: number;
  tokenAddress: string;
  side: TradeSide;
  venue: Venue;
  method: "CURVE_FORMULA_AT_PINNED_BLOCK" | "V4_QUOTER_ETH_CALL";
  input: AssetAmount;
  output: AssetAmount & { expected: string; minimum: string };
  /** Curve buys that exhaust the allocation spend less than offered and refund the rest. */
  spent: string;
  refund: string;
  slippageBps: number;
  fees: FeeLine[];
  priceImpact: { allInBps: number; poolOnlyBps: number | null; spotOutPerInX36: string };
  block: { number: string; hash: string; timestamp: string };
  quotedAt: string;
  expiresAt: string;
  calculationVersion: string;
  policyVersion: string;
  venueState:
    | { kind: "curve"; curve: string; quoteReserve: string; tokenReserve: string; sellableTokens: string; graduationThreshold: string; trackedQuote: string }
    | { kind: "pool"; poolId: string; poolKey: PoolKeyHex; sqrtPriceX96: string; tick: number; activeLiquidityRaw: string; quoter: string; quoterGasEstimate: string };
  warnings: Limitation[];
  limitations: Limitation[];
  sourceReferences: readonly SourceReference[];
}

export type QuoteOutcome =
  | { status: "QUOTED"; quote: PonsQuote }
  | {
      status: "UNSUPPORTED";
      reason: UnsupportedReason;
      detail: string;
      tokenAddress: string;
      side: TradeSide;
      block: { number: string; hash: string; timestamp: string } | null;
      venue: Venue | null;
      policyVersion: string;
    }
  | { status: "UNAVAILABLE"; reason: "RPC_UNAVAILABLE" | "INCONSISTENT_SNAPSHOT" | "PROVIDER_CAPABILITY"; detail: string };

export interface QuoteRequest {
  tokenAddress: string;
  side: TradeSide;
  amountIn: bigint;
  slippageBps: number;
}

export interface QuoteDeps {
  caller: ChainCaller;
  factoryAddress: string;
  now?: () => Date;
}

const ALWAYS: Limitation[] = [
  { code: "ESTIMATE_NOT_EXECUTION", message: "A quote estimates the trade at one block. It is not a simulation of your transaction and not a fill." },
  { code: "NO_WALLET_CHECKS", message: "Wallet balance, approvals and network are not checked by a quote." },
  { code: "STATE_MOVES", message: "Any trade landing before yours changes the price. The minimum output is the protection, and a transaction below it reverts." },
  { code: "USD_UNAVAILABLE", message: "No trusted USD conversion exists for this chain, so no USD values are shown." },
];

class Unsupported extends Error {
  constructor(
    readonly reason: UnsupportedReason,
    detail: string,
    readonly venue: Venue | null
  ) {
    super(detail);
  }
}

interface LaunchRecord {
  curve: string;
  pairToken: string;
  graduationThreshold: bigint;
  poolFee: number;
  tickSpacing: number;
  phase: number;
  exists: boolean;
}

function assetMeta(
  currency: string,
  symbolRead: { ok: boolean; value?: unknown } | undefined,
  decimalsRead: { ok: boolean; value?: unknown } | undefined
): { symbol: string | null; decimals: number } {
  if (currency.toLowerCase() === NATIVE_CURRENCY) return { symbol: "ETH", decimals: 18 };
  // Decimals are load-bearing for display; a token that will not report them is refused
  // rather than assumed to be 18.
  const decimals = decimalsRead?.ok ? Number(decimalsRead.value) : NaN;
  if (!Number.isInteger(decimals)) throw new Unsupported("PROTOCOL_MISMATCH", `decimals() unreadable for ${currency}`, null);
  return { symbol: symbolRead?.ok ? String(symbolRead.value) : null, decimals };
}

function metadataReads(currency: string): ContractRead[] {
  if (currency.toLowerCase() === NATIVE_CURRENCY) return [];
  return [
    { address: currency, abi: ERC20_METADATA_ABI, functionName: "symbol" },
    { address: currency, abi: ERC20_METADATA_ABI, functionName: "decimals" },
  ];
}

export function validateQuoteRequest(req: QuoteRequest): string | null {
  if (!/^0x[0-9a-fA-F]{40}$/.test(req.tokenAddress)) return "tokenAddress must be a 20-byte hex address";
  if (req.side !== "buy" && req.side !== "sell") return "side must be buy or sell";
  if (req.amountIn <= 0n) return "amount must be a positive integer in base units";
  if (req.amountIn > QUOTE_POLICY.maxAmount) return "amount exceeds uint128";
  if (!Number.isInteger(req.slippageBps) || req.slippageBps < QUOTE_POLICY.minSlippageBps || req.slippageBps > QUOTE_POLICY.maxSlippageBps) {
    return `slippageBps must be an integer between ${QUOTE_POLICY.minSlippageBps} and ${QUOTE_POLICY.maxSlippageBps}`;
  }
  return null;
}

export async function quotePonsV2(req: QuoteRequest, deps: QuoteDeps): Promise<QuoteOutcome> {
  const now = deps.now ?? (() => new Date());
  const token = req.tokenAddress.toLowerCase() as Hex;

  const snapshot = await snapshotAt(deps.caller, async (block) => {
    try {
      return { ok: true as const, quote: await quoteAtBlock(req, token, block, deps, now) };
    } catch (error) {
      if (error instanceof Unsupported) return { ok: false as const, error };
      throw error;
    }
  });

  if (snapshot.status === "REJECTED" || !snapshot.data) {
    const capability = snapshot.detail?.includes("state override") || snapshot.detail?.includes("UNSUPPORTED_CAPABILITY");
    if (snapshot.failure === "BLOCK_HASH_MISMATCH") {
      return { status: "UNAVAILABLE", reason: "INCONSISTENT_SNAPSHOT", detail: snapshot.detail ?? "block changed during the read" };
    }
    return { status: "UNAVAILABLE", reason: capability ? "PROVIDER_CAPABILITY" : "RPC_UNAVAILABLE", detail: snapshot.detail ?? "chain data unavailable" };
  }

  const block = snapshot.block!;
  if (!snapshot.data.ok) {
    return {
      status: "UNSUPPORTED",
      reason: snapshot.data.error.reason,
      detail: snapshot.data.error.message,
      tokenAddress: token,
      side: req.side,
      block: { number: block.number.toString(), hash: block.hash, timestamp: block.timestamp.toString() },
      venue: snapshot.data.error.venue,
      policyVersion: QUOTE_POLICY_VERSION,
    };
  }
  return { status: "QUOTED", quote: snapshot.data.quote };
}

async function quoteAtBlock(
  req: QuoteRequest,
  token: Hex,
  block: PinnedBlockWithTime,
  deps: QuoteDeps,
  now: () => Date
): Promise<PonsQuote> {
  const factory = deps.factoryAddress;
  const first = await multicallAt(deps.caller, block.number, [
    { address: factory, abi: PONS_V2_FACTORY_ABI as never, functionName: "getLaunchedToken", args: [token] },
    { address: factory, abi: PONS_V2_FACTORY_ABI as never, functionName: "poolManager" },
    { address: factory, abi: PONS_V2_FACTORY_ABI as never, functionName: "memeHook" },
  ]);

  const launch = readValue<LaunchRecord>(first[0], "getLaunchedToken");
  if (!launch.exists) throw new Unsupported("UNKNOWN_TOKEN", "the Pons V2 factory has no launch for this token", null);
  const poolManager = readValue<string>(first[1], "poolManager").toLowerCase();
  const hooks = readValue<string>(first[2], "memeHook").toLowerCase() as Hex;
  if (poolManager !== UNISWAP_V4_ROBINHOOD.poolManager) {
    throw new Unsupported("PROTOCOL_MISMATCH", "factory PoolManager is not the verified Uniswap V4 deployment", null);
  }

  const phase = Number(launch.phase);
  const pairToken = launch.pairToken.toLowerCase() as Hex;
  if (phase === PONS_V2_PHASE.SWEPT) {
    throw new Unsupported("GRADUATION_IN_PROGRESS", "curve trading has stopped and the V4 pool is not created yet", null);
  }
  if (phase === PONS_V2_PHASE.RESCUED) throw new Unsupported("LAUNCH_RESCUED", "graduation was rescued by the protocol owner; no venue trades", null);

  const quotedAt = now();
  const common = {
    chain: "robinhood" as const,
    chainId: ROBINHOOD_CHAIN_ID,
    tokenAddress: token,
    side: req.side,
    slippageBps: req.slippageBps,
    block: { number: block.number.toString(), hash: block.hash, timestamp: block.timestamp.toString() },
    quotedAt: quotedAt.toISOString(),
    expiresAt: new Date(quotedAt.getTime() + QUOTE_POLICY.ttlMs).toISOString(),
    policyVersion: QUOTE_POLICY_VERSION,
    sourceReferences: QUOTE_SOURCE_REFERENCES,
  };

  if (phase === PONS_V2_PHASE.NOT_GRADUATED) {
    return quoteCurve(req, token, pairToken, launch, block, deps, common);
  }
  if (phase === PONS_V2_PHASE.POOL_CREATED) {
    return quotePool(req, token, pairToken, launch, hooks, block, deps, common);
  }
  throw new Unsupported("PROTOCOL_MISMATCH", `unknown graduation phase ${phase}`, null);
}

type Common = Pick<
  PonsQuote,
  "chain" | "chainId" | "tokenAddress" | "side" | "slippageBps" | "block" | "quotedAt" | "expiresAt" | "policyVersion" | "sourceReferences"
>;

async function quoteCurve(
  req: QuoteRequest,
  token: Hex,
  pairToken: Hex,
  launch: LaunchRecord,
  block: PinnedBlockWithTime,
  deps: QuoteDeps,
  common: Common
): Promise<PonsQuote> {
  const venue: Venue = "PONS_V2_BONDING_CURVE";
  const curve = launch.curve.toLowerCase();
  const fns = [
    "getReserves",
    "feeBps",
    "creatorTaxBps",
    "sellableTokens",
    "graduated",
    "readyToGraduate",
    "snipeTaxStartBps",
    "snipeTaxSeconds",
    "launchedAt",
    "trackedQuote",
  ] as const;
  const reads: ContractRead[] = [
    ...fns.map((functionName) => ({ address: curve, abi: PONS_CURVE_ABI, functionName })),
    ...metadataReads(token),
    ...metadataReads(pairToken),
  ];
  const r = await multicallAt(deps.caller, block.number, reads);
  const [quoteReserve, tokenReserve] = readValue<readonly [bigint, bigint]>(r[0], "getReserves");
  const state: CurveState = {
    quoteReserve,
    tokenReserve,
    feeBps: readValue<bigint>(r[1], "feeBps"),
    creatorTaxBps: readValue<bigint>(r[2], "creatorTaxBps"),
    sellableTokens: readValue<bigint>(r[3], "sellableTokens"),
    graduated: readValue<boolean>(r[4], "graduated"),
    readyToGraduate: readValue<boolean>(r[5], "readyToGraduate"),
    snipeTaxStartBps: readValue<bigint>(r[6], "snipeTaxStartBps"),
    snipeTaxSeconds: readValue<bigint>(r[7], "snipeTaxSeconds"),
    launchedAt: readValue<bigint>(r[8], "launchedAt"),
  };
  const trackedQuote = readValue<bigint>(r[9], "trackedQuote");
  state.trackedQuote = trackedQuote;
  // The memecoin is always an ERC-20, so its two metadata reads always occupy 10 and 11.
  const tokenMeta = assetMeta(token, r[10], r[11]);
  const pairMeta = assetMeta(pairToken, r[12], r[13]);

  const quotePerTokenX36 = curveSpotQuotePerTokenX36(state);
  const tokenPerQuoteX36 = curveSpotTokenPerQuoteX36(state);
  const venueState = {
    kind: "curve" as const,
    curve,
    quoteReserve: state.quoteReserve.toString(),
    tokenReserve: state.tokenReserve.toString(),
    sellableTokens: state.sellableTokens.toString(),
    graduationThreshold: launch.graduationThreshold.toString(),
    trackedQuote: trackedQuote.toString(),
  };

  if (req.side === "buy") {
    const q = quoteCurveBuy(state, req.amountIn, block.timestamp);
    if (!q.ok) throw new Unsupported(q.refusal, `curve refused the buy: ${q.refusal}`, venue);
    const allIn = shortfallVsSpotBps({ amountIn: q.spent, outAmount: q.tokensOut, spotX36: tokenPerQuoteX36 });
    enforceImpact(allIn, venue);
    return {
      ...common,
      venue,
      method: "CURVE_FORMULA_AT_PINNED_BLOCK",
      input: { currency: pairToken, ...pairMeta, amount: req.amountIn.toString() },
      output: {
        currency: token,
        ...tokenMeta,
        amount: q.tokensOut.toString(),
        expected: q.tokensOut.toString(),
        minimum: minimumOutput(q.tokensOut, req.slippageBps).toString(),
      },
      spent: q.spent.toString(),
      refund: q.refund.toString(),
      fees: [
        { kind: "CURVE_PROTOCOL_FEE", bps: Number(state.feeBps), currency: pairToken, chargedOn: "INPUT", amount: exact(q.protocolFee) },
        { kind: "CURVE_CREATOR_TAX", bps: Number(state.creatorTaxBps), currency: pairToken, chargedOn: "INPUT", amount: exact(q.creatorTax) },
      ],
      priceImpact: { allInBps: allIn, poolOnlyBps: null, spotOutPerInX36: tokenPerQuoteX36.toString() },
      calculationVersion: CURVE_QUOTE_CALCULATION_VERSION,
      venueState,
      warnings: impactWarnings(allIn, q.clamped ? [{ code: "CLAMPED_FILL", message: "This buy exhausts the curve's remaining allocation. Only part of the amount would be spent; the rest is refunded." }] : []),
      limitations: [
        ...ALWAYS,
        { code: "CURVE_SNIPE_TAX_NOT_MODELLED", message: "The curve's launch-window snipe tax is not modelled; quotes are refused while it can apply." },
      ],
    };
  }

  const q = quoteCurveSell(state, req.amountIn);
  if (!q.ok) {
    if (q.refusal === "CURVE_CANNOT_PAY") {
      throw new Unsupported(q.refusal, `This sell would pay out more than the curve really holds (${trackedQuote.toString()} base units of the pair asset from real buyers), so it would revert. A smaller sell may still work.`, venue);
    }
    throw new Unsupported(q.refusal, `curve refused the sell: ${q.refusal}`, venue);
  }
  const allIn = shortfallVsSpotBps({ amountIn: req.amountIn, outAmount: q.quoteOut, spotX36: quotePerTokenX36 });
  enforceImpact(allIn, venue);
  return {
    ...common,
    venue,
    method: "CURVE_FORMULA_AT_PINNED_BLOCK",
    input: { currency: token, ...tokenMeta, amount: req.amountIn.toString() },
    output: {
      currency: pairToken,
      ...pairMeta,
      amount: q.quoteOut.toString(),
      expected: q.quoteOut.toString(),
      minimum: minimumOutput(q.quoteOut, req.slippageBps).toString(),
    },
    spent: req.amountIn.toString(),
    refund: "0",
    fees: [
      { kind: "CURVE_PROTOCOL_FEE", bps: Number(state.feeBps), currency: pairToken, chargedOn: "OUTPUT", amount: exact(q.protocolFee) },
      { kind: "CURVE_CREATOR_TAX", bps: Number(state.creatorTaxBps), currency: pairToken, chargedOn: "OUTPUT", amount: exact(q.creatorTax) },
    ],
    priceImpact: { allInBps: allIn, poolOnlyBps: null, spotOutPerInX36: quotePerTokenX36.toString() },
    calculationVersion: CURVE_QUOTE_CALCULATION_VERSION,
    venueState,
    warnings: impactWarnings(allIn, []),
    limitations: [...ALWAYS],
  };
}

async function quotePool(
  req: QuoteRequest,
  token: Hex,
  pairToken: Hex,
  launch: LaunchRecord,
  hooks: Hex,
  block: PinnedBlockWithTime,
  deps: QuoteDeps,
  common: Common
): Promise<PonsQuote> {
  const venue: Venue = "PONS_V2_UNISWAP_V4";
  const poolKey = buildPoolKey({ tokenAddress: token, pairToken, poolFee: Number(launch.poolFee), tickSpacing: Number(launch.tickSpacing), hooks }) as PoolKeyHex;
  const poolId = poolIdFor(poolKey);
  const memecoinIsCurrency0 = poolKey.currency0 === token;
  const dir = v4Direction({ side: req.side, memecoinIsCurrency0, poolKey });

  const reads: ContractRead[] = [
    { address: hooks, abi: PONS_MEME_HOOK_ABI, functionName: "launches", args: [poolId] },
    { address: UNISWAP_V4_ROBINHOOD.stateView, abi: STATE_VIEW_ABI, functionName: "getSlot0", args: [poolId] },
    { address: UNISWAP_V4_ROBINHOOD.stateView, abi: STATE_VIEW_ABI, functionName: "getLiquidity", args: [poolId] },
    {
      address: UNISWAP_V4_ROBINHOOD.v4Quoter,
      abi: V4_QUOTER_ABI,
      functionName: "quoteExactInputSingle",
      args: [{ poolKey, zeroForOne: dir.zeroForOne, exactAmount: req.amountIn, hookData: "0x" }],
    },
    ...metadataReads(token),
    ...metadataReads(pairToken),
  ];
  const r = await multicallAt(deps.caller, block.number, reads);

  const info = readValue<readonly unknown[]>(r[0], "hook.launches");
  const registered = info[0] as boolean;
  const hookMemecoinIsCurrency0 = info[1] as boolean;
  const creatorTaxBps = Number(info[7]);
  const hookFeeBps = Number(info[10]);
  if (!registered || hookMemecoinIsCurrency0 !== memecoinIsCurrency0 || (info[2] as string).toLowerCase() !== token) {
    throw new Unsupported("POOL_REGISTRATION_INCONSISTENT", "the hook's registration for this pool does not match the factory record", venue);
  }

  const [sqrtPriceX96, tick] = readValue<readonly [bigint, number, number, number]>(r[1], "getSlot0");
  const liquidity = readValue<bigint>(r[2], "getLiquidity");
  if (sqrtPriceX96 === 0n) throw new Unsupported("INSUFFICIENT_LIQUIDITY", "pool is not initialized at this block", venue);

  if (!r[3].ok) {
    throw new Unsupported("QUOTER_REVERTED", `official V4Quoter reverted (${r[3].revertData.slice(0, 10)})`, venue);
  }
  const [amountOut, gasEstimate] = r[3].value as readonly [bigint, bigint];
  if (amountOut === 0n) throw new Unsupported("OUTPUT_ROUNDS_TO_ZERO", "quoted output is zero", venue);

  const tokenMeta = assetMeta(token, r[4], r[5]);
  const pairMeta = assetMeta(pairToken, r[6], r[7]);
  const inputMeta = dir.inputCurrency === token ? tokenMeta : pairMeta;
  const outputMeta = dir.outputCurrency === token ? tokenMeta : pairMeta;

  const spot = spotOutPerInX36(sqrtPriceX96, dir.zeroForOne);
  const take = reconstructHookTake(amountOut, hookFeeBps, creatorTaxBps);
  const allIn = shortfallVsSpotBps({ amountIn: req.amountIn, outAmount: amountOut, spotX36: spot });
  const poolOnly = take ? shortfallVsSpotBps({ amountIn: req.amountIn, outAmount: take.candidates[0].grossOut, spotX36: spot }) : null;
  enforceImpact(allIn, venue);

  const range = (x: { min: bigint; max: bigint }) => ({ min: x.min.toString(), max: x.max.toString(), exact: x.min === x.max });
  const fees: FeeLine[] = take
    ? [
        { kind: "HOOK_FEE", bps: hookFeeBps, currency: dir.outputCurrency, chargedOn: "OUTPUT", amount: range(take.hookFee) },
        { kind: "HOOK_CREATOR_TAX", bps: creatorTaxBps, currency: dir.outputCurrency, chargedOn: "OUTPUT", amount: range(take.creatorTax) },
      ]
    : [];

  return {
    ...common,
    venue,
    method: "V4_QUOTER_ETH_CALL",
    input: { currency: dir.inputCurrency, ...inputMeta, amount: req.amountIn.toString() },
    output: {
      currency: dir.outputCurrency,
      ...outputMeta,
      amount: amountOut.toString(),
      expected: amountOut.toString(),
      minimum: minimumOutput(amountOut, req.slippageBps).toString(),
    },
    spent: req.amountIn.toString(),
    refund: "0",
    fees,
    priceImpact: { allInBps: allIn, poolOnlyBps: poolOnly, spotOutPerInX36: spot.toString() },
    calculationVersion: V4_QUOTE_CALCULATION_VERSION,
    venueState: {
      kind: "pool",
      poolId,
      poolKey,
      sqrtPriceX96: sqrtPriceX96.toString(),
      tick: Number(tick),
      activeLiquidityRaw: liquidity.toString(),
      quoter: UNISWAP_V4_ROBINHOOD.v4Quoter,
      quoterGasEstimate: gasEstimate.toString(),
    },
    warnings: impactWarnings(
      allIn,
      take ? [] : [{ code: "FEE_SPLIT_UNRESOLVED", message: "The hook's fee split could not be reconstructed from this quote; the expected output is still net of fees." }]
    ),
    limitations: [
      ...ALWAYS,
      {
        code: "HOOK_FEE_FROM_POOL_REGISTRATION",
        message: `Fees are the Pons hook's per-pool terms (${hookFeeBps} bps hook fee + ${creatorTaxBps} bps creator tax), taken from the output after the swap. The expected output is already net of them.`,
      },
      {
        code: "QUOTE_IS_NOT_SELLABILITY",
        message: "A successful quote does not show that a given wallet can sell: the wallet also needs the balance and a Permit2 approval for the router.",
      },
    ],
  };
}

function exact(v: bigint) {
  return { min: v.toString(), max: v.toString(), exact: true };
}

function enforceImpact(allInBps: number, venue: Venue): void {
  if (allInBps >= QUOTE_POLICY.maxPriceImpactBps) {
    throw new Unsupported(
      "PRICE_IMPACT_EXCEEDS_POLICY",
      `this size executes ${(allInBps / 100).toFixed(2)}% below the pre-trade price, above the ${QUOTE_POLICY.maxPriceImpactBps / 100}% limit`,
      venue
    );
  }
}

function impactWarnings(allInBps: number, extra: Limitation[]): Limitation[] {
  const out = [...extra];
  if (allInBps >= QUOTE_POLICY.warnPriceImpactBps) {
    out.push({ code: "HIGH_PRICE_IMPACT", message: `This size executes ${(allInBps / 100).toFixed(2)}% below the pre-trade price, fees included.` });
  }
  return out;
}

/** Map pinned-read failures thrown out of a group. Exported for tests. */
export function describeReadError(error: unknown): string {
  return error instanceof PinnedReadError ? `${error.kind}: ${error.message}` : error instanceof Error ? error.message : String(error);
}
