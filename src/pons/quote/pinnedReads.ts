/**
 * Phase 7D.3.2 — block-pinned read groups.
 *
 * A quote is several reads (launch record, pool or curve state, token metadata, the quoter
 * itself) that only mean something together. Each group goes out as ONE Multicall3
 * `aggregate3` at an explicit block, so every value in it provably comes from the same
 * state, and the whole snapshot runs inside `readAtPinnedBlock`, which re-checks the
 * pinned hash afterwards and restarts on a reorg or a provider disagreement.
 *
 * One call per group is also what keeps this usable on the rate-limited providers this
 * chain has: a graduated-pool quote is 2 eth_calls plus the block lookups, not 15.
 */

import { decodeFunctionResult, encodeFunctionData, type Abi, type Hex } from "viem";

import type { ChainCaller } from "../chainClient";
import { readAtPinnedBlock, type PinnedBlock, type SnapshotResult } from "../blockPinnedReader";
import { MULTICALL3, MULTICALL3_ABI } from "./protocol";

export interface ContractRead {
  address: string;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

export type ReadResult<T = unknown> = { ok: true; value: T } | { ok: false; revertData: Hex };

/** Thrown inside a read group; `readAtPinnedBlock` turns it into a REJECTED snapshot. */
export class PinnedReadError extends Error {
  constructor(
    message: string,
    readonly kind: "RPC_UNAVAILABLE" | "UNSUPPORTED_CAPABILITY" | "MULTICALL_REVERTED"
  ) {
    super(message);
    this.name = "PinnedReadError";
  }
}

export async function multicallAt(caller: ChainCaller, blockNumber: bigint, reads: readonly ContractRead[]): Promise<ReadResult[]> {
  const data = encodeFunctionData({
    abi: MULTICALL3_ABI,
    functionName: "aggregate3",
    args: [
      reads.map((r) => ({
        target: r.address as Hex,
        allowFailure: true,
        callData: encodeFunctionData({ abi: r.abi, functionName: r.functionName, args: r.args ?? [] } as never),
      })),
    ],
  });

  const result = await caller.call({ to: MULTICALL3, data, blockNumber });
  if (result.status === "UNAVAILABLE") {
    throw new PinnedReadError(`${result.code}: ${result.reason}`, "RPC_UNAVAILABLE");
  }
  if (result.data.kind === "UNSUPPORTED_CAPABILITY") {
    throw new PinnedReadError(result.data.message, "UNSUPPORTED_CAPABILITY");
  }
  if (result.data.kind === "REVERTED") {
    // allowFailure is true for every entry, so the aggregate itself should never revert.
    throw new PinnedReadError(`multicall reverted: ${result.data.data.slice(0, 10)}`, "MULTICALL_REVERTED");
  }

  const decoded = decodeFunctionResult({ abi: MULTICALL3_ABI, functionName: "aggregate3", data: result.data.data }) as readonly {
    success: boolean;
    returnData: Hex;
  }[];

  return decoded.map((entry, i) => {
    if (!entry.success) return { ok: false, revertData: entry.returnData };
    const read = reads[i];
    try {
      const value = decodeFunctionResult({ abi: read.abi, functionName: read.functionName, data: entry.returnData } as never);
      return { ok: true, value };
    } catch {
      /**
       * Phase 7D.5 — a call can "succeed" and still return nothing decodable. The case that
       * matters here: `eth_call` to an address with no code at that block returns `0x` with
       * `success: true`, which is what happens if a token is read at a block before it was
       * deployed. Left to throw, one such entry took down the whole aggregate — and with it
       * every other token batched alongside it.
       *
       * An undecodable return is not a usable value, so it is reported the same way a revert
       * is: that one read failed, the rest of the batch stands.
       */
      return { ok: false, revertData: entry.returnData };
    }
  });
}

export interface PinnedBlockWithTime extends PinnedBlock {
  timestamp: bigint;
}

/**
 * Run `group` at one pinned block. The block's timestamp is captured from the same
 * `eth_getBlockByNumber` that establishes its hash — quote expiry and the curve's snipe
 * window are both measured against chain time, not server time.
 */
export async function snapshotAt<T>(
  caller: ChainCaller,
  group: (block: PinnedBlockWithTime) => Promise<T>,
  options: { maxRestarts?: number } = {}
): Promise<SnapshotResult<T> & { block?: PinnedBlockWithTime }> {
  const timestamps = new Map<bigint, bigint>();
  const result = await readAtPinnedBlock<T>(
    {
      getHead: () => caller.getBlockNumber(),
      getBlockHash: async (n) => {
        const ref = await caller.getBlockRef(n);
        if (ref.status === "UNAVAILABLE") return ref;
        timestamps.set(n, ref.data.timestamp);
        return { ...ref, data: ref.data.hash };
      },
      maxRestarts: options.maxRestarts ?? 2,
    },
    (block) => group({ ...block, timestamp: timestamps.get(block.number) ?? 0n })
  );
  const { block, ...rest } = result;
  return block ? { ...rest, block: { ...block, timestamp: timestamps.get(block.number) ?? 0n } } : rest;
}

export function readValue<T>(result: ReadResult | undefined, what: string): T {
  if (!result || !result.ok) {
    throw new PinnedReadError(`${what} reverted${result && !result.ok ? ` (${result.revertData.slice(0, 10)})` : ""}`, "MULTICALL_REVERTED");
  }
  return result.value as T;
}
