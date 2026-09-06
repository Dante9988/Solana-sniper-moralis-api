/**
 * Phase 7B.4 §4.2 — the Pons implementation of the ChainAdapter seam
 * (src/discovery/types.ts).
 *
 * Pure decode-only, like src/pump/normalizeTrade.ts's normalizeTradeEvent:
 * no RPC calls, no subscriptions. The listener (§4.3/§4.4, not built in
 * this step) is responsible for all I/O — fetching logs, calling
 * getLaunchedToken() for enrichment, resolving which side of a pool is the
 * tracked token — and hands this adapter already-decoded, already-enriched
 * plain data. That keeps this file trivially unit-testable against fixed
 * inputs and keeps viem's Log/decode types out of the venue-agnostic
 * contract in src/discovery/types.ts.
 */

import { decodeEventLog } from "viem";
import type { NormalizedTokenDiscovered, NormalizedTradeExecuted, ChainAdapter } from "../discovery/types";
import { decimalDivide } from "../discovery/decimal";
import { PONS_FACTORY_ABI, UNISWAP_V3_POOL_ABI } from "./abi";

const CHAIN = "robinhood" as const;
const VENUE = "pons" as const;

/** The minimal shape of a fetched log this adapter needs — independent of viem's own Log type so callers can pass a plain object in tests. */
export interface RawEvmLog {
  readonly address: string;
  readonly topics: readonly `0x${string}`[];
  readonly data: `0x${string}`;
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly transactionHash: string;
  readonly logIndex: number;
}

/**
 * Result of calling getLaunchedToken(token) on the factory, fetched by the
 * listener immediately after seeing a TokenLaunched log. supply isn't on
 * the log itself (verified on-chain — see abi.ts) so this enrichment is
 * mandatory, not optional.
 */
export interface PonsLaunchEnrichment {
  readonly supply: bigint;
  readonly isToken0: boolean;
  readonly poolFee: number;
}

export interface RawPonsTokenDiscovery {
  readonly log: RawEvmLog;
  readonly enrichment: PonsLaunchEnrichment;
}

/**
 * The Swap log alone doesn't name which token it trades — only pool
 * address, signed amount0/amount1, and pool state. The listener resolves
 * tokenAddress/quoteAddress/isToken0 from its own discovered-token registry
 * (persisted by the discovery listener, §4.3) before calling this adapter.
 */
export interface RawPonsSwap {
  readonly log: RawEvmLog;
  readonly tokenAddress: string;
  readonly quoteAddress: string;
  readonly isToken0: boolean;
}

function toDecimalString(value: bigint): string {
  return value.toString();
}

export const ponsAdapter: ChainAdapter<RawPonsTokenDiscovery, RawPonsSwap> = {
  chain: CHAIN,
  venue: VENUE,

  decodeTokenDiscovered(raw: RawPonsTokenDiscovery): NormalizedTokenDiscovered | null {
    let decoded;
    try {
      decoded = decodeEventLog({
        abi: PONS_FACTORY_ABI,
        eventName: "TokenLaunched",
        topics: raw.log.topics as [`0x${string}`, ...`0x${string}`[]],
        data: raw.log.data,
      });
    } catch {
      // Not a TokenLaunched log (wrong topic0/shape) — fail closed, do not guess.
      return null;
    }

    const args = decoded.args as {
      token: string;
      deployer: string;
      pairToken: string;
      pool: string;
      initialBuyAmount: bigint;
    };

    return {
      kind: "tokenDiscovered",
      chain: CHAIN,
      venue: VENUE,
      tokenAddress: args.token,
      deployer: args.deployer,
      poolAddress: args.pool,
      quoteAddress: args.pairToken,
      supply: toDecimalString(raw.enrichment.supply),
      initialBuyAmount: toDecimalString(args.initialBuyAmount),
      provenance: {
        sourceHeight: raw.log.blockNumber.toString(),
        sourceHash: raw.log.blockHash,
        sourceTxHash: raw.log.transactionHash,
        sourceIndex: raw.log.logIndex,
      },
      observedAt: new Date().toISOString(),
    };
  },

  decodeTrade(raw: RawPonsSwap): NormalizedTradeExecuted | null {
    let decoded;
    try {
      decoded = decodeEventLog({
        abi: UNISWAP_V3_POOL_ABI,
        eventName: "Swap",
        topics: raw.log.topics as [`0x${string}`, ...`0x${string}`[]],
        data: raw.log.data,
      });
    } catch {
      return null;
    }

    const args = decoded.args as {
      sender: string;
      recipient: string;
      amount0: bigint;
      amount1: bigint;
    };

    // Uniswap V3 sign convention: positive = flowed INTO the pool (paid by
    // the trader), negative = flowed OUT of the pool (received by the
    // trader). Direction depends on which side of the pool is our token —
    // verified against a real Swap log during ABI verification (abi.ts).
    const tokenAmountSigned = raw.isToken0 ? args.amount0 : args.amount1;
    const quoteAmountSigned = raw.isToken0 ? args.amount1 : args.amount0;

    if (tokenAmountSigned === 0n) {
      // Fail closed rather than guess a side for a degenerate/zero swap leg.
      return null;
    }

    const side: "buy" | "sell" = tokenAmountSigned < 0n ? "buy" : "sell";
    const tokenAmount = tokenAmountSigned < 0n ? -tokenAmountSigned : tokenAmountSigned;
    const quoteAmount = quoteAmountSigned < 0n ? -quoteAmountSigned : quoteAmountSigned;

    return {
      kind: "tradeExecuted",
      chain: CHAIN,
      venue: VENUE,
      tokenAddress: raw.tokenAddress,
      poolAddress: raw.log.address,
      side,
      tokenAmount: toDecimalString(tokenAmount),
      quoteAmount: toDecimalString(quoteAmount),
      quoteAddress: raw.quoteAddress,
      priceQuote: decimalDivide(quoteAmount.toString(), tokenAmount.toString()),
      priceUsd: null,
      trader: args.recipient,
      provenance: {
        sourceHeight: raw.log.blockNumber.toString(),
        sourceHash: raw.log.blockHash,
        sourceTxHash: raw.log.transactionHash,
        sourceIndex: raw.log.logIndex,
      },
      observedAt: new Date().toISOString(),
    };
  },
};
