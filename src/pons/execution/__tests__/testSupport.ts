/**
 * Shared doubles for the Phase 7E.1 execution tests.
 *
 * The quotes below are shaped exactly like quoteService's output, because every venue
 * reads them as if quoteService produced them. They are fixtures, not captured chain data:
 * the numbers only need to be internally consistent, and the real pricing is covered by
 * the 7D.3.2 fork evidence.
 */

import type { Abi, Hex } from "viem";

import type { ChainCaller, ChainClientResult, EthCallOutcome, RawBlockRef } from "../../chainClient";
import { NATIVE_CURRENCY, UNISWAP_V4_ROBINHOOD } from "../../quote/protocol";
import type { PonsQuote } from "../../quote/quoteService";
import type { WalletProbe } from "../venue";

export const WALLET = "0x1111111111111111111111111111111111111111";
export const TOKEN = "0x2222222222222222222222222222222222222222";
export const CURVE = "0x3333333333333333333333333333333333333333";
export const USDG = "0x4444444444444444444444444444444444444444";
export const BLOCK = { number: "62211539", hash: "0xaaaa000000000000000000000000000000000000000000000000000000000000", timestamp: "1800000000" };

function available<T>(data: T): ChainClientResult<T> {
  return { status: "AVAILABLE", data, source: "test", fetchedAt: new Date(0), attempts: 1 };
}

export function unavailable<T>(reason = "no provider"): ChainClientResult<T> {
  return { status: "UNAVAILABLE", source: "test", fetchedAt: new Date(0), code: "NETWORK", reason, attempts: 1 };
}

export interface FakeCallerOptions {
  /** Block hash to serve for the quote's block; a different one simulates a reorg. */
  blockHash?: string;
  /** Keyed `${address}:${functionName}` — a missing key throws, so a test cannot pass by accident. */
  reads?: Record<string, unknown>;
  blockRefUnavailable?: boolean;
}

/**
 * A ChainCaller that answers only what a test set up.
 *
 * An unexpected read is a thrown error rather than a default, so a venue quietly gaining a
 * new chain read shows up as a failing test instead of a silently wrong answer.
 */
export class FakeCaller implements ChainCaller {
  readonly reads: string[] = [];

  constructor(private readonly options: FakeCallerOptions = {}) {}

  async getBlockNumber(): Promise<ChainClientResult<bigint>> {
    return available(BigInt(BLOCK.number));
  }

  async getBlockRef(blockNumber: bigint): Promise<ChainClientResult<RawBlockRef>> {
    if (this.options.blockRefUnavailable) return unavailable("block ref down");
    return available({ number: blockNumber, hash: (this.options.blockHash ?? BLOCK.hash) as Hex, parentHash: "0x" as Hex, timestamp: BigInt(BLOCK.timestamp) } as RawBlockRef);
  }

  async getTransaction(): Promise<ChainClientResult<never>> {
    throw new Error("getTransaction is not used by the execution venues");
  }

  async getLogs(): Promise<ChainClientResult<never>> {
    throw new Error("getLogs is not used by the execution venues");
  }

  async readContract<T>(params: { address: string; abi: Abi; functionName: string; args: readonly unknown[] }): Promise<ChainClientResult<T>> {
    const key = `${params.address.toLowerCase()}:${params.functionName}`;
    this.reads.push(key);
    const reads = this.options.reads ?? {};
    if (!(key in reads)) throw new Error(`unexpected read ${key}`);
    const value = reads[key];
    if (value === "UNAVAILABLE") return unavailable<T>(`read ${key} unavailable`);
    return available(value as T);
  }

  async call(): Promise<ChainClientResult<EthCallOutcome>> {
    throw new Error("call is not used by buildTransaction");
  }
}

export function fakeProbe(options: { balance?: bigint; gas?: bigint; balanceUnavailable?: boolean; gasUnavailable?: boolean } = {}): WalletProbe {
  return {
    async getBalance() {
      if (options.balanceUnavailable) return unavailable<bigint>("balance down");
      return available(options.balance ?? 10n ** 18n);
    },
    async estimateGas() {
      if (options.gasUnavailable) return unavailable<bigint>("estimate down");
      return available(options.gas ?? 200_000n);
    },
  };
}

const COMMON = {
  chain: "robinhood" as const,
  chainId: 4663,
  tokenAddress: TOKEN,
  block: BLOCK,
  quotedAt: "2026-09-25T00:00:00.000Z",
  expiresAt: "2026-09-25T00:00:30.000Z",
  calculationVersion: "test-calc-1",
  policyVersion: "quote-policy-1",
  warnings: [],
  limitations: [],
  sourceReferences: [],
  fees: [],
  spent: "1000",
  refund: "0",
  slippageBps: 100,
  priceImpact: { allInBps: 12, poolOnlyBps: null, spotOutPerInX36: "1" },
};

/** Ungraduated launch quoted in native ETH: a buy needs no approval. */
export function curveBuyQuote(overrides: Partial<PonsQuote> = {}): PonsQuote {
  return {
    ...COMMON,
    side: "buy",
    venue: "PONS_V2_BONDING_CURVE",
    method: "CURVE_FORMULA_AT_PINNED_BLOCK",
    input: { currency: NATIVE_CURRENCY, symbol: "ETH", decimals: 18, amount: "1000" },
    output: { currency: TOKEN, symbol: "DRIFT", decimals: 18, amount: "5000", expected: "5000", minimum: "4950" },
    venueState: { kind: "curve", curve: CURVE, quoteReserve: "10", tokenReserve: "20", sellableTokens: "30", graduationThreshold: "40", trackedQuote: "50" },
    ...overrides,
  } as PonsQuote;
}

/** Selling the memecoin back to the curve: an ERC-20 input, so one approval. */
export function curveSellQuote(overrides: Partial<PonsQuote> = {}): PonsQuote {
  return curveBuyQuote({
    side: "sell",
    input: { currency: TOKEN, symbol: "DRIFT", decimals: 18, amount: "5000" },
    output: { currency: NATIVE_CURRENCY, symbol: "ETH", decimals: 18, amount: "990", expected: "990", minimum: "980" },
    ...overrides,
  });
}

const POOL_KEY = {
  currency0: NATIVE_CURRENCY as Hex,
  currency1: TOKEN as Hex,
  fee: 3000,
  tickSpacing: 60,
  hooks: "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044" as Hex,
};

export const POOL_ID = "0xbbbb000000000000000000000000000000000000000000000000000000000000";

/** Graduated launch, native ETH in: no approval, but a router and a deadline. */
export function poolBuyQuote(overrides: Partial<PonsQuote> = {}): PonsQuote {
  return {
    ...COMMON,
    side: "buy",
    venue: "PONS_V2_UNISWAP_V4",
    method: "V4_QUOTER_ETH_CALL",
    input: { currency: NATIVE_CURRENCY, symbol: "ETH", decimals: 18, amount: "1000" },
    output: { currency: TOKEN, symbol: "DRIFT", decimals: 18, amount: "5000", expected: "5000", minimum: "4950" },
    venueState: {
      kind: "pool",
      poolId: POOL_ID,
      poolKey: POOL_KEY,
      sqrtPriceX96: "79228162514264337593543950336",
      tick: 0,
      activeLiquidityRaw: "1000000",
      quoter: UNISWAP_V4_ROBINHOOD.v4Quoter,
      quoterGasEstimate: "120000",
    },
    ...overrides,
  } as PonsQuote;
}

/** Graduated launch, ERC-20 in: the two-approval path (token -> Permit2 -> router). */
export function poolSellQuote(overrides: Partial<PonsQuote> = {}): PonsQuote {
  return poolBuyQuote({
    side: "sell",
    input: { currency: TOKEN, symbol: "DRIFT", decimals: 18, amount: "5000" },
    output: { currency: NATIVE_CURRENCY, symbol: "ETH", decimals: 18, amount: "990", expected: "990", minimum: "980" },
    ...overrides,
  });
}
