/**
 * Phase 7D §5 — the Pons V2 counterpart to ponsAdapter.ts.
 *
 * Pure decode-only, same discipline as ponsAdapter.ts: no RPC calls, no
 * subscriptions. DiscoveryV2Listener (§6) is responsible for all I/O.
 *
 * Not a ChainAdapter implementation (src/discovery/types.ts) — V2's
 * TokenLaunched has no initialBuyAmount arg and its graduation is a third,
 * distinct fact (PoolGraduated) that interface doesn't model yet. Exposed
 * as plain functions instead; see NormalizedTokenGraduated's doc-comment
 * for why that seam isn't widened here.
 */

import { decodeEventLog, decodeFunctionData, getAbiItem, toEventSelector, toFunctionSelector } from "viem";
import type { NormalizedTokenDiscovered, NormalizedTokenGraduated, NormalizedTradeExecuted } from "../discovery/types";
import { decimalDivide } from "../discovery/decimal";
import { PONS_V2_FACTORY_ABI, UNISWAP_V4_POOL_MANAGER_ABI } from "./abiV2";
import type { RawEvmLog } from "./ponsAdapter";

const CHAIN = "robinhood" as const;
const VENUE = "pons_v2" as const;

/**
 * viem's decodeEventLog, given an explicit `eventName`, does not itself
 * verify topics[0] against that event's selector — a log with *fewer*
 * indexed topics than the named event expects (verified live: a
 * PoolGraduated log, 1 indexed arg, decoded "successfully" as TokenLaunched,
 * 3 indexed args, with the missing fields simply undefined) decodes without
 * throwing. An explicit topic0 check is required for these decoders to
 * actually fail closed on the wrong event, rather than relying on
 * decodeEventLog's exception to do it.
 */
const TOKEN_LAUNCHED_TOPIC0 = toEventSelector(getAbiItem({ abi: PONS_V2_FACTORY_ABI, name: "TokenLaunched" }));
const POOL_GRADUATED_TOPIC0 = toEventSelector(getAbiItem({ abi: PONS_V2_FACTORY_ABI, name: "PoolGraduated" }));
const INITIALIZE_TOPIC0 = toEventSelector(getAbiItem({ abi: UNISWAP_V4_POOL_MANAGER_ABI, name: "Initialize" }));
const SWAP_V4_TOPIC0 = toEventSelector(getAbiItem({ abi: UNISWAP_V4_POOL_MANAGER_ABI, name: "Swap" }));

/**
 * Phase 7D §1 (metadata) — the 3 real launch entrypoints, each verified
 * live (see abiV2.ts's header). `decodeLaunchMetadata` only recognizes a
 * transaction whose input starts with one of these — anything else
 * (routed through an unverified bundler/router, as the example token was)
 * fails closed rather than guessing at a layout.
 */
const LAUNCH_FUNCTION_SELECTORS = new Set(
  (["launchToken", "launchTokenFor"] as const).flatMap((name) =>
    PONS_V2_FACTORY_ABI.filter((item) => item.type === "function" && item.name === name).map((item) => toFunctionSelector(item as Parameters<typeof toFunctionSelector>[0]).toLowerCase())
  )
);

/**
 * Result of calling totalSupply() on the launched token, fetched by the
 * listener immediately after seeing a TokenLaunched log. V2's
 * getLaunchedToken() struct has no supply field (verified on-chain — see
 * abiV2.ts), unlike V1's, so this is the only enrichment V2 discovery
 * needs.
 */
export interface PonsV2LaunchEnrichment {
  readonly supply: bigint;
}

export interface RawPonsV2TokenDiscovery {
  readonly log: RawEvmLog;
  readonly enrichment: PonsV2LaunchEnrichment;
}

export interface RawPonsV2Graduation {
  readonly log: RawEvmLog;
}

/** Phase 7D §1 (metadata) — logo/description/socials as decoded from a real launchToken/launchTokenFor call. Never contract storage — see abiV2.ts. */
export interface RichLaunchMetadata {
  readonly name: string;
  readonly symbol: string;
  readonly logoUrl: string;
  readonly description: string;
  readonly socials: {
    readonly twitter: string;
    readonly telegram: string;
    readonly discord: string;
    readonly website: string;
    readonly farcaster: string;
  };
}

/** Phase 7D §2 (transaction history) — the Uniswap V4 pool identity captured from the Initialize log accompanying PoolGraduated in the same transaction. */
export interface RawPonsV2PoolInitialized {
  readonly log: RawEvmLog;
}

export interface PonsV2PoolIdentity {
  readonly poolId: string;
  readonly isToken0: boolean;
}

export interface RawPonsV2Swap {
  readonly log: RawEvmLog;
  readonly tokenAddress: string;
  readonly quoteAddress: string;
  readonly isToken0: boolean;
}

function toDecimalString(value: bigint): string {
  return value.toString();
}

export const ponsV2Adapter = {
  chain: CHAIN,
  venue: VENUE,

  decodeTokenDiscovered(raw: RawPonsV2TokenDiscovery): (NormalizedTokenDiscovered & { curveAddress: string }) | null {
    if (raw.log.topics[0]?.toLowerCase() !== TOKEN_LAUNCHED_TOPIC0.toLowerCase()) return null;
    let decoded;
    try {
      decoded = decodeEventLog({
        abi: PONS_V2_FACTORY_ABI,
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
      curve: string;
      deployer: string;
      pairToken: string;
    };

    return {
      kind: "tokenDiscovered",
      chain: CHAIN,
      venue: VENUE,
      tokenAddress: args.token,
      deployer: args.deployer,
      // No discrete pool at discovery time — V2 launches onto a bonding
      // curve first and only gets a Uniswap V4 position at graduation.
      // Matches this field's own doc-comment in discovery/types.ts.
      poolAddress: null,
      quoteAddress: args.pairToken,
      supply: toDecimalString(raw.enrichment.supply),
      // V2's TokenLaunched carries no initial-buy argument (unlike V1) —
      // any first buy happens as a separate curve trade afterward, so "0"
      // is the correct fact here, not a guessed default.
      initialBuyAmount: "0",
      provenance: {
        sourceHeight: raw.log.blockNumber.toString(),
        sourceHash: raw.log.blockHash,
        sourceTxHash: raw.log.transactionHash,
        sourceIndex: raw.log.logIndex,
      },
      observedAt: new Date().toISOString(),
      curveAddress: args.curve,
    };
  },

  decodeTokenGraduated(raw: RawPonsV2Graduation): NormalizedTokenGraduated | null {
    if (raw.log.topics[0]?.toLowerCase() !== POOL_GRADUATED_TOPIC0.toLowerCase()) return null;
    let decoded;
    try {
      decoded = decodeEventLog({
        abi: PONS_V2_FACTORY_ABI,
        eventName: "PoolGraduated",
        topics: raw.log.topics as [`0x${string}`, ...`0x${string}`[]],
        data: raw.log.data,
      });
    } catch {
      // Not a PoolGraduated log — fail closed, do not guess.
      return null;
    }

    const args = decoded.args as {
      token: string;
      positionId: bigint;
      tokenAmount: bigint;
      pairTokenAmount: bigint;
    };

    return {
      kind: "tokenGraduated",
      chain: CHAIN,
      venue: VENUE,
      tokenAddress: args.token,
      positionId: toDecimalString(args.positionId),
      tokenAmount: toDecimalString(args.tokenAmount),
      pairTokenAmount: toDecimalString(args.pairTokenAmount),
      provenance: {
        sourceHeight: raw.log.blockNumber.toString(),
        sourceHash: raw.log.blockHash,
        sourceTxHash: raw.log.transactionHash,
        sourceIndex: raw.log.logIndex,
      },
      observedAt: new Date().toISOString(),
    };
  },

  /**
   * Phase 7D §1 (metadata) — decodes a launch transaction's own calldata
   * against the 3 verified real entrypoints (see LAUNCH_FUNCTION_SELECTORS'
   * header comment). Returns null (fail closed) for anything else — most
   * commonly a launch routed through an unverified bundler/router, whose
   * calldata this function deliberately does not attempt to parse.
   */
  decodeLaunchMetadata(txInput: string): RichLaunchMetadata | null {
    const selector = txInput.slice(0, 10).toLowerCase();
    if (!LAUNCH_FUNCTION_SELECTORS.has(selector)) return null;
    let decoded;
    try {
      decoded = decodeFunctionData({ abi: PONS_V2_FACTORY_ABI, data: txInput as `0x${string}` });
    } catch {
      return null;
    }
    const params = (decoded.args as readonly unknown[])[0] as {
      name: string;
      symbol: string;
      logo: string;
      description: string;
      socials: { twitter: string; telegram: string; discord: string; website: string; farcaster: string };
    };
    return {
      name: params.name,
      symbol: params.symbol,
      logoUrl: params.logo,
      description: params.description,
      socials: { ...params.socials },
    };
  },

  /**
   * Phase 7D §2 (transaction history) — reads the PoolId straight off a
   * real Initialize log rather than hand-computing keccak256(PoolKey).
   * Returns null if this Initialize log isn't for the given token (a
   * graduation transaction can only ever contain one matching Initialize,
   * but the caller may hand this every Initialize log in the tx/block
   * range without pre-filtering).
   */
  decodePoolInitialized(raw: RawPonsV2PoolInitialized, tokenAddress: string): PonsV2PoolIdentity | null {
    if (raw.log.topics[0]?.toLowerCase() !== INITIALIZE_TOPIC0.toLowerCase()) return null;
    let decoded;
    try {
      decoded = decodeEventLog({
        abi: UNISWAP_V4_POOL_MANAGER_ABI,
        eventName: "Initialize",
        topics: raw.log.topics as [`0x${string}`, ...`0x${string}`[]],
        data: raw.log.data,
      });
    } catch {
      return null;
    }
    const args = decoded.args as { id: string; currency0: string; currency1: string };
    const token = tokenAddress.toLowerCase();
    if (args.currency0.toLowerCase() === token) return { poolId: args.id, isToken0: true };
    if (args.currency1.toLowerCase() === token) return { poolId: args.id, isToken0: false };
    return null;
  },

  /**
   * Phase 7D §2 (transaction history) — decodes a real Uniswap V4
   * PoolManager Swap log. Same signed-amount convention as V3 (verified
   * live against the identical field semantics — see abi.ts's
   * UNISWAP_V3_POOL_ABI comment): negative = flowed OUT of the pool
   * (received by the trader, i.e. a buy), positive = flowed IN (a sell).
   */
  decodeTrade(raw: RawPonsV2Swap): NormalizedTradeExecuted | null {
    if (raw.log.topics[0]?.toLowerCase() !== SWAP_V4_TOPIC0.toLowerCase()) return null;
    let decoded;
    try {
      decoded = decodeEventLog({
        abi: UNISWAP_V4_POOL_MANAGER_ABI,
        eventName: "Swap",
        topics: raw.log.topics as [`0x${string}`, ...`0x${string}`[]],
        data: raw.log.data,
      });
    } catch {
      return null;
    }

    const args = decoded.args as { sender: string; amount0: bigint; amount1: bigint };
    const tokenAmountSigned = raw.isToken0 ? args.amount0 : args.amount1;
    const quoteAmountSigned = raw.isToken0 ? args.amount1 : args.amount0;
    if (tokenAmountSigned === 0n) return null;

    const side: "buy" | "sell" = tokenAmountSigned < 0n ? "buy" : "sell";
    const tokenAmount = tokenAmountSigned < 0n ? -tokenAmountSigned : tokenAmountSigned;
    const quoteAmount = quoteAmountSigned < 0n ? -quoteAmountSigned : quoteAmountSigned;

    return {
      kind: "tradeExecuted",
      chain: CHAIN,
      venue: VENUE,
      tokenAddress: raw.tokenAddress,
      // V4 has no discrete per-pool contract address (singleton PoolManager,
      // keyed by PoolId) — poolAddress stays null for this venue's trades,
      // same "no discrete pool" rationale as decodeTokenDiscovered above.
      poolAddress: null,
      side,
      tokenAmount: toDecimalString(tokenAmount),
      quoteAmount: toDecimalString(quoteAmount),
      quoteAddress: raw.quoteAddress,
      priceQuote: decimalDivide(quoteAmount.toString(), tokenAmount.toString()),
      priceUsd: null,
      trader: args.sender,
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
