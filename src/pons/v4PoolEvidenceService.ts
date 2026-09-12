/**
 * Phase 7D.3 §5 — fetch Uniswap V4 pool evidence for a graduated Pons V2 token.
 *
 * Thin orchestration over `v4PoolState.ts` (pure math, fixture-tested) and the existing
 * `ChainReader` (retries, backoff, failure classification). Nothing is computed here that
 * is not covered by the fixture tests.
 *
 * Fails closed in every direction: an RPC failure, a token the factory does not know, a
 * pre-graduation token, or an uninitialized pool each produce a reason code rather than a
 * partially-invented number.
 */

import { parseAbi, type Abi } from "viem";

import { PONS_V2_FACTORY_ABI } from "./abiV2";
import type { ChainReader } from "./chainClient";
import {
  buildPoolEvidence,
  buildPoolKey,
  liquiditySlot,
  poolIdFor,
  poolStateSlot,
  type MissingReason,
  type PoolEvidence,
} from "./v4PoolState";

/** PoolManager inherits Extsload; StateView is not deployed on Robinhood Chain. */
const EXTSLOAD_ABI = parseAbi(["function extsload(bytes32 slot) view returns (bytes32)"]) as unknown as Abi;

/** `phase` from getLaunchedToken. 2 == graduated onto the V4 pool (verified live). */
const PHASE_GRADUATED = 2;

export type PoolEvidenceResult =
  | { status: "AVAILABLE"; evidence: PoolEvidence }
  | { status: "UNAVAILABLE"; reason: MissingReason; detail: string };

function unavailable(reason: MissingReason, detail: string): PoolEvidenceResult {
  return { status: "UNAVAILABLE", reason, detail };
}

export interface LaunchedTokenView {
  pairToken: string;
  poolFee: number;
  tickSpacing: number;
  creatorTaxBps: number;
  phase: number;
}

/**
 * Read the factory's record for a token. Separate so callers that already hold it (the
 * discovery listener, for instance) can skip the round trip.
 */
export async function readLaunchedToken(
  reader: ChainReader,
  factoryAddress: string,
  tokenAddress: string
): Promise<{ ok: true; launch: LaunchedTokenView } | { ok: false; reason: MissingReason; detail: string }> {
  const result = await reader.readContract<Record<string, unknown>>({
    address: factoryAddress,
    abi: PONS_V2_FACTORY_ABI as unknown as Abi,
    functionName: "getLaunchedToken",
    args: [tokenAddress as `0x${string}`],
  });

  if (result.status === "UNAVAILABLE") {
    return { ok: false, reason: "RPC_UNAVAILABLE", detail: `${result.code}: ${result.reason}` };
  }

  const raw = result.data as Record<string, unknown>;
  // `exists` is the factory's own "do I know this token" flag — trust it rather than
  // inferring from zeroed fields.
  if (raw.exists === false) {
    return { ok: false, reason: "UNSUPPORTED_VENUE", detail: "factory does not know this token" };
  }

  return {
    ok: true,
    launch: {
      pairToken: String(raw.pairToken),
      poolFee: Number(raw.poolFee),
      tickSpacing: Number(raw.tickSpacing),
      creatorTaxBps: Number(raw.creatorTaxBps),
      phase: Number(raw.phase),
    },
  };
}

/**
 * Fetch pool evidence for one token.
 *
 * `hooksAddress` is resolved from the factory's `memeHook()` by the caller (the discovery
 * listener already caches it at startup) rather than hardcoded, so a redeployed hook does
 * not silently produce wrong PoolIds.
 */
export async function fetchPoolEvidence(params: {
  reader: ChainReader;
  factoryAddress: string;
  poolManagerAddress: string;
  hooksAddress: string;
  tokenAddress: string;
  /** Pass when already known, to skip a round trip. */
  launch?: LaunchedTokenView;
}): Promise<PoolEvidenceResult> {
  const { reader, tokenAddress } = params;

  let launch = params.launch;
  if (!launch) {
    const read = await readLaunchedToken(reader, params.factoryAddress, tokenAddress);
    if (!read.ok) return unavailable(read.reason, read.detail);
    launch = read.launch;
  }

  // Pre-graduation tokens live on a bonding curve, not a V4 pool. Reading pool state for
  // them would return an uninitialized slot, which is a different and more confusing
  // failure than saying plainly that it has not graduated.
  if (launch.phase !== PHASE_GRADUATED) {
    return unavailable("NOT_GRADUATED", `phase ${launch.phase}; V4 pool exists only after graduation`);
  }

  const poolKey = buildPoolKey({
    tokenAddress,
    pairToken: launch.pairToken,
    poolFee: launch.poolFee,
    tickSpacing: launch.tickSpacing,
    hooks: params.hooksAddress,
  });
  const poolId = poolIdFor(poolKey);
  const stateSlot = poolStateSlot(poolId);

  const [slot0Read, liquidityRead] = await Promise.all([
    reader.readContract<`0x${string}`>({
      address: params.poolManagerAddress,
      abi: EXTSLOAD_ABI,
      functionName: "extsload",
      args: [stateSlot],
    }),
    reader.readContract<`0x${string}`>({
      address: params.poolManagerAddress,
      abi: EXTSLOAD_ABI,
      functionName: "extsload",
      args: [liquiditySlot(stateSlot)],
    }),
  ]);

  if (slot0Read.status === "UNAVAILABLE") {
    return unavailable("RPC_UNAVAILABLE", `slot0: ${slot0Read.code}: ${slot0Read.reason}`);
  }
  if (liquidityRead.status === "UNAVAILABLE") {
    return unavailable("RPC_UNAVAILABLE", `liquidity: ${liquidityRead.code}: ${liquidityRead.reason}`);
  }

  const blockRead = await reader.getBlockNumber();
  const observedAtBlock = blockRead.status === "AVAILABLE" ? blockRead.data.toString() : "";

  const built = buildPoolEvidence({
    poolKey,
    poolId,
    slot0Word: slot0Read.data,
    liquidityWord: liquidityRead.data,
    creatorTaxBps: launch.creatorTaxBps,
    observedAtBlock,
  });

  if (!built.ok) {
    return unavailable(built.reason, "pool slot0 is zero — pool not initialized at this block");
  }
  return { status: "AVAILABLE", evidence: built.evidence };
}
