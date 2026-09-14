/**
 * Phase 7D.3.2 §4 — market evidence for the token terminal, for both Pons V2 venues.
 *
 * Replaces the V4-only /pool view's weakest parts:
 *   - it assumed native ETH was currency0 and labelled everything else "WETH"; 75 of 164
 *     graduated pools pair with an ERC-20 (USDG, cbBTC, tokenized stocks);
 *   - it treated every non-2 graduation phase as "not graduated", hiding Swept/Rescued;
 *   - it showed only the creator tax, not the hook's own per-pool fee;
 *   - it had nothing at all for the 98% of launches still on their bonding curve.
 *
 * Liquidity semantics, deliberately:
 *   - Raw V4 active liquidity `L` is exposed only as `advanced.activeLiquidityRaw`. It is
 *     not ETH, not dollars and not what a seller can receive, and it is never labelled so.
 *   - `depth` is the meaningful figure: what fixed trade sizes would actually return, from
 *     the SAME calculation the quote endpoint uses and the fork suite verified (curve
 *     formula, or the official V4Quoter). Nothing else is presented as depth.
 *   - USD is unavailable: there is no trusted conversion for this chain.
 *
 * Read at one pinned block in at most two Multicall3 calls.
 */

import { type Hex } from "viem";

import { PONS_V2_FACTORY_ABI } from "../abiV2";
import type { ChainCaller } from "../chainClient";
import { buildPoolKey, poolIdFor } from "../v4PoolState";
import { CURVE_QUOTE_CALCULATION_VERSION, curveSpotQuotePerTokenX36, curveSpotTokenPerQuoteX36, quoteCurveBuy, quoteCurveSell, type CurveState } from "./curveQuote";
import { multicallAt, readValue, snapshotAt, type ContractRead, type ReadResult } from "./pinnedReads";
import {
  ERC20_METADATA_ABI,
  NATIVE_CURRENCY,
  PONS_CURVE_ABI,
  PONS_MEME_HOOK_ABI,
  PONS_V2_PHASE,
  QUOTE_SOURCE_REFERENCES,
  STATE_VIEW_ABI,
  UNISWAP_V4_ROBINHOOD,
  V4_QUOTER_ABI,
  type SourceReference,
} from "./protocol";
import { V4_QUOTE_CALCULATION_VERSION, shortfallVsSpotBps, spotOutPerInX36, v4Direction, type PoolKeyHex } from "./v4Quote";

export const MARKET_EVIDENCE_CALCULATION_VERSION = "pons-v2-market-evidence-1";

const Q96 = 1n << 96n;
const BPS = 10_000n;
/** Depth sizes as fractions of the pair-side reserve that prices trades: 0.1%, 1%, 5%. */
const DEPTH_FRACTIONS_BPS = [10n, 100n, 500n] as const;

export type PhaseCode = "BONDING_CURVE" | "GRADUATION_IN_PROGRESS" | "UNISWAP_V4_POOL" | "RESCUED";

export interface DepthRow {
  side: "buy" | "sell";
  amountIn: string;
  expectedOut: string | null;
  allInImpactBps: number | null;
  /** Why this size has no figure, e.g. the curve would clamp or the quoter reverted. */
  unavailableReason: string | null;
}

export interface MarketEvidence {
  chain: "robinhood";
  tokenAddress: string;
  phase: { code: PhaseCode; onChainValue: number };
  venue: "PONS_V2_BONDING_CURVE" | "PONS_V2_UNISWAP_V4";
  block: { number: string; hash: string; timestamp: string };
  observedAt: string;
  calculationVersion: string;
  token: { symbol: string | null; decimals: number };
  pairAsset: { currency: string; symbol: string | null; decimals: number };
  /** Pair-asset base units per 10^tokenDecimals token base units (one whole token), scaled by 1e36. */
  spotPrice: { pairBaseUnitsPerWholeTokenX36: string; method: "CURVE_RESERVES" | "POOL_SQRT_PRICE" };
  fees: { kind: "CURVE_PROTOCOL_FEE" | "CURVE_CREATOR_TAX" | "HOOK_FEE" | "HOOK_CREATOR_TAX"; bps: number; source: string }[];
  curve: {
    address: string;
    realQuoteHeld: string;
    graduationThreshold: string;
    graduationProgressBps: number;
    sellableTokens: string;
    snipeWindowOpen: boolean;
  } | null;
  depth: { method: "CURVE_FORMULA_AT_PINNED_BLOCK" | "V4_QUOTER_ETH_CALL"; referenceReserve: string; rows: DepthRow[] };
  advanced: {
    poolId: string | null;
    poolKey: PoolKeyHex | null;
    sqrtPriceX96: string | null;
    tick: number | null;
    /** Uniswap V4 active liquidity L. Protocol parameter only — never ETH, USD or sell proceeds. */
    activeLiquidityRaw: string | null;
    lpFeeHundredthsBip: number | null;
    curveQuoteReserveIncludingVirtual: string | null;
    curveTokenReserve: string | null;
  };
  usd: { available: false; reason: string };
  missingEvidence: { code: string; detail: string }[];
  limitations: { code: string; message: string }[];
  sourceReferences: readonly SourceReference[];
}

export type MarketEvidenceOutcome =
  | { status: "AVAILABLE"; evidence: MarketEvidence }
  | { status: "UNSUPPORTED"; reason: "UNKNOWN_TOKEN" | "PROTOCOL_MISMATCH" | "GRADUATION_IN_PROGRESS" | "RESCUED" | "POOL_REGISTRATION_INCONSISTENT"; detail: string; block: MarketEvidence["block"] | null }
  | { status: "UNAVAILABLE"; reason: "RPC_UNAVAILABLE" | "INCONSISTENT_SNAPSHOT"; detail: string };

class Unsupported extends Error {
  constructor(readonly reason: Extract<MarketEvidenceOutcome, { status: "UNSUPPORTED" }>["reason"], detail: string) {
    super(detail);
  }
}

const CURVE_EXTRA_ABI = [...PONS_CURVE_ABI, ...([{ type: "function", name: "realQuoteReserve", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }] as const)];

function assetMeta(currency: string, symbol: ReadResult | undefined, decimals: ReadResult | undefined) {
  if (currency === NATIVE_CURRENCY) return { symbol: "ETH", decimals: 18 };
  const d = decimals?.ok ? Number(decimals.value) : NaN;
  if (!Number.isInteger(d)) throw new Unsupported("PROTOCOL_MISMATCH", `decimals() unreadable for ${currency}`);
  return { symbol: symbol?.ok ? String(symbol.value) : null, decimals: d };
}

function metaReads(currency: string): ContractRead[] {
  return currency === NATIVE_CURRENCY
    ? []
    : [
        { address: currency, abi: ERC20_METADATA_ABI, functionName: "symbol" },
        { address: currency, abi: ERC20_METADATA_ABI, functionName: "decimals" },
      ];
}

/** Raw price (pair base units per token base unit, X36) → per whole token. */
function perWholeToken(rawX36: bigint, tokenDecimals: number): bigint {
  return rawX36 * 10n ** BigInt(tokenDecimals);
}

const LIMITATIONS = [
  { code: "DEPTH_IS_REFERENCE_SIZES", message: "Depth shows what three reference trade sizes would return at this block. Your own size needs its own quote." },
  { code: "ADVANCED_NOT_RESERVES", message: "Advanced protocol parameters are not ETH reserves, dollar liquidity or available sell proceeds." },
  { code: "USD_UNAVAILABLE", message: "No trusted USD conversion exists for this chain." },
];

export async function fetchMarketEvidence(tokenAddress: string, deps: { caller: ChainCaller; factoryAddress: string; now?: () => Date }): Promise<MarketEvidenceOutcome> {
  const token = tokenAddress.toLowerCase() as Hex;
  const now = deps.now ?? (() => new Date());

  const snapshot = await snapshotAt(deps.caller, async (block) => {
    try {
      return { ok: true as const, evidence: await atBlock(token, block, deps, now) };
    } catch (error) {
      if (error instanceof Unsupported) return { ok: false as const, error };
      throw error;
    }
  });

  if (snapshot.status === "REJECTED" || !snapshot.data) {
    return snapshot.failure === "BLOCK_HASH_MISMATCH"
      ? { status: "UNAVAILABLE", reason: "INCONSISTENT_SNAPSHOT", detail: snapshot.detail ?? "block changed during the read" }
      : { status: "UNAVAILABLE", reason: "RPC_UNAVAILABLE", detail: snapshot.detail ?? "chain data unavailable" };
  }
  const block = snapshot.block!;
  if (!snapshot.data.ok) {
    return {
      status: "UNSUPPORTED",
      reason: snapshot.data.error.reason,
      detail: snapshot.data.error.message,
      block: { number: block.number.toString(), hash: block.hash, timestamp: block.timestamp.toString() },
    };
  }
  return { status: "AVAILABLE", evidence: snapshot.data.evidence };
}

async function atBlock(
  token: Hex,
  block: { number: bigint; hash: string; timestamp: bigint },
  deps: { caller: ChainCaller; factoryAddress: string },
  now: () => Date
): Promise<MarketEvidence> {
  const first = await multicallAt(deps.caller, block.number, [
    { address: deps.factoryAddress, abi: PONS_V2_FACTORY_ABI as never, functionName: "getLaunchedToken", args: [token] },
    { address: deps.factoryAddress, abi: PONS_V2_FACTORY_ABI as never, functionName: "poolManager" },
    { address: deps.factoryAddress, abi: PONS_V2_FACTORY_ABI as never, functionName: "memeHook" },
  ]);
  const launch = readValue<{ curve: string; pairToken: string; graduationThreshold: bigint; poolFee: number; tickSpacing: number; phase: number; exists: boolean }>(
    first[0],
    "getLaunchedToken"
  );
  if (!launch.exists) throw new Unsupported("UNKNOWN_TOKEN", "the Pons V2 factory has no launch for this token");
  if (readValue<string>(first[1], "poolManager").toLowerCase() !== UNISWAP_V4_ROBINHOOD.poolManager) {
    throw new Unsupported("PROTOCOL_MISMATCH", "factory PoolManager is not the verified Uniswap V4 deployment");
  }
  const hooks = readValue<string>(first[2], "memeHook").toLowerCase() as Hex;
  const phase = Number(launch.phase);
  if (phase === PONS_V2_PHASE.SWEPT) throw new Unsupported("GRADUATION_IN_PROGRESS", "the curve has stopped trading and the V4 pool has not been created yet");
  if (phase === PONS_V2_PHASE.RESCUED) throw new Unsupported("RESCUED", "graduation was rescued by the protocol owner; no venue trades");

  const pair = launch.pairToken.toLowerCase() as Hex;
  const blockRef = { number: block.number.toString(), hash: block.hash, timestamp: block.timestamp.toString() };
  const base = { chain: "robinhood" as const, tokenAddress: token, block: blockRef, observedAt: now().toISOString(), calculationVersion: MARKET_EVIDENCE_CALCULATION_VERSION, usd: { available: false as const, reason: "No trusted USD conversion exists for this chain." }, sourceReferences: QUOTE_SOURCE_REFERENCES };

  if (phase === PONS_V2_PHASE.NOT_GRADUATED) {
    const curve = launch.curve.toLowerCase();
    const fns = ["getReserves", "feeBps", "creatorTaxBps", "sellableTokens", "graduated", "readyToGraduate", "snipeTaxStartBps", "snipeTaxSeconds", "launchedAt", "realQuoteReserve"] as const;
    const r = await multicallAt(deps.caller, block.number, [...fns.map((functionName) => ({ address: curve, abi: CURVE_EXTRA_ABI as never, functionName })), ...metaReads(token), ...metaReads(pair)]);
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
    const realQuote = readValue<bigint>(r[9], "realQuoteReserve");
    const tokenMeta = assetMeta(token, r[10], r[11]);
    const pairMeta = assetMeta(pair, r[12], r[13]);
    const quotePerTokenX36 = curveSpotQuotePerTokenX36(state);
    const tokenPerQuoteX36 = curveSpotTokenPerQuoteX36(state);
    const snipeOpen = state.snipeTaxStartBps !== 0n && block.timestamp - state.launchedAt < state.snipeTaxSeconds;

    const rows: DepthRow[] = [];
    for (const f of DEPTH_FRACTIONS_BPS) {
      const amountIn = (state.quoteReserve * f) / BPS;
      const q = quoteCurveBuy(state, amountIn, block.timestamp);
      rows.push(
        q.ok && !q.clamped
          ? { side: "buy", amountIn: amountIn.toString(), expectedOut: q.tokensOut.toString(), allInImpactBps: shortfallVsSpotBps({ amountIn, outAmount: q.tokensOut, spotX36: tokenPerQuoteX36 }), unavailableReason: null }
          : { side: "buy", amountIn: amountIn.toString(), expectedOut: null, allInImpactBps: null, unavailableReason: q.ok ? "CLAMPED_FILL" : q.refusal }
      );
    }
    for (const f of DEPTH_FRACTIONS_BPS) {
      const amountIn = (state.tokenReserve * f) / BPS;
      const q = quoteCurveSell(state, amountIn);
      rows.push(
        q.ok
          ? { side: "sell", amountIn: amountIn.toString(), expectedOut: q.quoteOut.toString(), allInImpactBps: shortfallVsSpotBps({ amountIn, outAmount: q.quoteOut, spotX36: quotePerTokenX36 }), unavailableReason: null }
          : { side: "sell", amountIn: amountIn.toString(), expectedOut: null, allInImpactBps: null, unavailableReason: q.refusal }
      );
    }

    const threshold = BigInt(launch.graduationThreshold);
    return {
      ...base,
      phase: { code: "BONDING_CURVE", onChainValue: phase },
      venue: "PONS_V2_BONDING_CURVE",
      calculationVersion: `${MARKET_EVIDENCE_CALCULATION_VERSION}+${CURVE_QUOTE_CALCULATION_VERSION}`,
      token: tokenMeta,
      pairAsset: { currency: pair, ...pairMeta },
      spotPrice: { pairBaseUnitsPerWholeTokenX36: perWholeToken(quotePerTokenX36, tokenMeta.decimals).toString(), method: "CURVE_RESERVES" },
      fees: [
        { kind: "CURVE_PROTOCOL_FEE", bps: Number(state.feeBps), source: "PonsV2BondingCurve.feeBps()" },
        { kind: "CURVE_CREATOR_TAX", bps: Number(state.creatorTaxBps), source: "PonsV2BondingCurve.creatorTaxBps()" },
      ],
      curve: {
        address: curve,
        realQuoteHeld: realQuote.toString(),
        graduationThreshold: threshold.toString(),
        graduationProgressBps: threshold === 0n ? 0 : Number((realQuote * BPS) / threshold > BPS ? BPS : (realQuote * BPS) / threshold),
        sellableTokens: state.sellableTokens.toString(),
        snipeWindowOpen: snipeOpen,
      },
      depth: { method: "CURVE_FORMULA_AT_PINNED_BLOCK", referenceReserve: state.quoteReserve.toString(), rows },
      advanced: {
        poolId: null,
        poolKey: null,
        sqrtPriceX96: null,
        tick: null,
        activeLiquidityRaw: null,
        lpFeeHundredthsBip: null,
        curveQuoteReserveIncludingVirtual: state.quoteReserve.toString(),
        curveTokenReserve: state.tokenReserve.toString(),
      },
      missingEvidence: snipeOpen ? [{ code: "SNIPE_WINDOW_OPEN", detail: "launch-window snipe tax may apply; depth for buys is not modelled" }] : [],
      limitations: [...LIMITATIONS, { code: "CURVE_RESERVE_INCLUDES_VIRTUAL", message: "The curve prices trades against a virtual quote reserve on top of what it really holds; only realQuoteHeld is actually held." }],
    };
  }

  // Graduated: Uniswap V4 pool.
  const poolKey = buildPoolKey({ tokenAddress: token, pairToken: pair, poolFee: Number(launch.poolFee), tickSpacing: Number(launch.tickSpacing), hooks }) as PoolKeyHex;
  const poolId = poolIdFor(poolKey);
  const memecoinIsCurrency0 = poolKey.currency0 === token;

  // Depth sizes need the price and liquidity first, so this venue takes one extra call.
  const state = await multicallAt(deps.caller, block.number, [
    { address: hooks, abi: PONS_MEME_HOOK_ABI, functionName: "launches", args: [poolId] },
    { address: UNISWAP_V4_ROBINHOOD.stateView, abi: STATE_VIEW_ABI, functionName: "getSlot0", args: [poolId] },
    { address: UNISWAP_V4_ROBINHOOD.stateView, abi: STATE_VIEW_ABI, functionName: "getLiquidity", args: [poolId] },
    ...metaReads(token),
    ...metaReads(pair),
  ]);
  const info = readValue<readonly unknown[]>(state[0], "hook.launches");
  if (!(info[0] as boolean) || (info[1] as boolean) !== memecoinIsCurrency0) {
    throw new Unsupported("POOL_REGISTRATION_INCONSISTENT", "the hook's registration for this pool does not match the factory record");
  }
  const creatorTaxBps = Number(info[7]);
  const hookFeeBps = Number(info[10]);
  const [sqrtPriceX96, tick, , lpFee] = readValue<readonly [bigint, number, number, number]>(state[1], "getSlot0");
  const liquidity = readValue<bigint>(state[2], "getLiquidity");
  const tokenMeta = assetMeta(token, state[3], state[4]);
  const pairMeta = assetMeta(pair, state[5], state[6]);

  const buy = v4Direction({ side: "buy", memecoinIsCurrency0, poolKey });
  const sell = v4Direction({ side: "sell", memecoinIsCurrency0, poolKey });
  // Virtual reserves implied by L at the current price (Uniswap v3/v4 whitepaper: x = L/√P, y = L·√P).
  const reserve0 = sqrtPriceX96 === 0n ? 0n : (liquidity * Q96) / sqrtPriceX96;
  const reserve1 = (liquidity * sqrtPriceX96) / Q96;
  const pairReserve = memecoinIsCurrency0 ? reserve1 : reserve0;
  const tokenReserve = memecoinIsCurrency0 ? reserve0 : reserve1;

  const sizes = [
    ...DEPTH_FRACTIONS_BPS.map((f) => ({ side: "buy" as const, zeroForOne: buy.zeroForOne, amountIn: (pairReserve * f) / BPS })),
    ...DEPTH_FRACTIONS_BPS.map((f) => ({ side: "sell" as const, zeroForOne: sell.zeroForOne, amountIn: (tokenReserve * f) / BPS })),
  ];
  const quotes = await multicallAt(
    deps.caller,
    block.number,
    sizes.map((s) => ({
      address: UNISWAP_V4_ROBINHOOD.v4Quoter,
      abi: V4_QUOTER_ABI,
      functionName: "quoteExactInputSingle",
      args: [{ poolKey, zeroForOne: s.zeroForOne, exactAmount: s.amountIn, hookData: "0x" }],
    }))
  );
  const rows: DepthRow[] = sizes.map((s, i) => {
    const q = quotes[i];
    if (s.amountIn === 0n) return { side: s.side, amountIn: "0", expectedOut: null, allInImpactBps: null, unavailableReason: "ZERO_REFERENCE_SIZE" };
    if (!q.ok) return { side: s.side, amountIn: s.amountIn.toString(), expectedOut: null, allInImpactBps: null, unavailableReason: `QUOTER_REVERTED ${q.revertData.slice(0, 10)}` };
    const [out] = q.value as readonly [bigint, bigint];
    return { side: s.side, amountIn: s.amountIn.toString(), expectedOut: out.toString(), allInImpactBps: shortfallVsSpotBps({ amountIn: s.amountIn, outAmount: out, spotX36: spotOutPerInX36(sqrtPriceX96, s.zeroForOne) }), unavailableReason: null };
  });

  // Pair per token (raw): the sell direction's spot, which is output(pair) per input(token).
  const pairPerTokenRawX36 = spotOutPerInX36(sqrtPriceX96, sell.zeroForOne);
  return {
    ...base,
    phase: { code: "UNISWAP_V4_POOL", onChainValue: phase },
    venue: "PONS_V2_UNISWAP_V4",
    calculationVersion: `${MARKET_EVIDENCE_CALCULATION_VERSION}+${V4_QUOTE_CALCULATION_VERSION}`,
    token: tokenMeta,
    pairAsset: { currency: pair, ...pairMeta },
    spotPrice: { pairBaseUnitsPerWholeTokenX36: perWholeToken(pairPerTokenRawX36, tokenMeta.decimals).toString(), method: "POOL_SQRT_PRICE" },
    fees: [
      { kind: "HOOK_FEE", bps: hookFeeBps, source: "PonsV2MemeHook.launches(poolId).hookFeeBps" },
      { kind: "HOOK_CREATOR_TAX", bps: creatorTaxBps, source: "PonsV2MemeHook.launches(poolId).creatorTaxBps" },
    ],
    curve: null,
    depth: { method: "V4_QUOTER_ETH_CALL", referenceReserve: pairReserve.toString(), rows },
    advanced: {
      poolId,
      poolKey,
      sqrtPriceX96: sqrtPriceX96.toString(),
      tick: Number(tick),
      activeLiquidityRaw: liquidity.toString(),
      lpFeeHundredthsBip: Number(lpFee),
      curveQuoteReserveIncludingVirtual: null,
      curveTokenReserve: null,
    },
    missingEvidence: rows.filter((r) => r.unavailableReason).map((r) => ({ code: "DEPTH_ROW_UNAVAILABLE", detail: `${r.side} ${r.amountIn}: ${r.unavailableReason}` })),
    limitations: [...LIMITATIONS, { code: "DEPTH_SIZES_FROM_VIRTUAL_RESERVES", message: "Reference sizes are fractions of the virtual reserve implied by active liquidity; the outputs themselves come from the official quoter." }],
  };
}
