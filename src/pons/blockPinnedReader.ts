/**
 * Phase 7D.3.1 §4 — cross-provider block consistency.
 *
 * Pool evidence is several reads that only mean something together: slot0 and liquidity
 * describe one pool at one instant. With failover in front of them, two reads in the same
 * group can land on different providers — and therefore different blocks, or worse, the
 * same height on a different fork. Mixing those produces a snapshot that never existed on
 * chain while looking entirely plausible, which is the failure mode this phase exists to
 * eliminate.
 *
 * The contract:
 *
 *   1. Pin one block for the whole group, and record its hash.
 *   2. Read at that exact block — never at `latest`.
 *   3. When a provider changes mid-group, re-verify the pinned hash before trusting it.
 *   4. On disagreement or missing state, reject the snapshot or restart at a new block.
 *      Never silently downgrade a single read to `latest`.
 *   5. Reject a provider too far behind for the operation.
 *
 * Rejecting a snapshot is the safe outcome here: a caller that gets `INCONSISTENT` can
 * retry, whereas a caller handed a silently-mixed snapshot cannot detect the problem.
 */

import type { ChainClientResult } from "./chainClient";

export interface PinnedBlock {
  number: bigint;
  hash: string;
}

export type SnapshotFailure =
  | "NO_BLOCK" // could not establish a pinned block at all
  | "BLOCK_HASH_MISMATCH" // provider disagrees about the pinned block — likely a fork
  | "STATE_UNAVAILABLE" // provider has pruned or lacks state at the pinned block
  | "PROVIDER_TOO_STALE" // provider is behind the pinned block
  | "READ_FAILED"; // transport failure during the group

export interface SnapshotResult<T> {
  status: "OK" | "REJECTED";
  block?: PinnedBlock;
  data?: T;
  failure?: SnapshotFailure;
  detail?: string;
  /** How many times the group was restarted at a newer block before succeeding. */
  restarts: number;
}

/** How far behind the pinned block a provider may be before it is rejected. */
export const DEFAULT_MAX_LAG_BLOCKS = 25n;

export interface BlockPinnedDeps {
  /** Current head, used to choose the pin and to measure staleness. */
  getHead: () => Promise<ChainClientResult<bigint>>;
  /** Canonical hash for a height, from the provider about to serve the group. */
  getBlockHash: (blockNumber: bigint) => Promise<ChainClientResult<string>>;
  maxLagBlocks?: bigint;
  /** Restarts allowed when the pinned block is reorged away mid-group. */
  maxRestarts?: number;
}

/**
 * Detect a fork: same height, different hash. Height alone is not identity — two
 * providers can both be "at block N" on different chains.
 */
export function blocksAgree(a: PinnedBlock, b: PinnedBlock): boolean {
  return a.number === b.number && a.hash.toLowerCase() === b.hash.toLowerCase();
}

export function isTooStale(providerHead: bigint, pinned: bigint, maxLag = DEFAULT_MAX_LAG_BLOCKS): boolean {
  // Behind the pin at all means the state is simply not there yet.
  if (providerHead < pinned) return true;
  return providerHead - pinned > maxLag;
}

/**
 * Run `readGroup` against a single pinned block.
 *
 * `readGroup` receives the pin and must pass it to every read it performs; it must never
 * fall back to `latest` for an individual read. `verify` re-reads the pinned hash after
 * the group and is what catches a mid-group provider switch or a reorg.
 */
export async function readAtPinnedBlock<T>(
  deps: BlockPinnedDeps,
  readGroup: (block: PinnedBlock) => Promise<T>,
  options: { verifyAfter?: boolean } = {}
): Promise<SnapshotResult<T>> {
  const maxRestarts = deps.maxRestarts ?? 2;
  const maxLag = deps.maxLagBlocks ?? DEFAULT_MAX_LAG_BLOCKS;
  let restarts = 0;

  for (;;) {
    const head = await deps.getHead();
    if (head.status === "UNAVAILABLE") {
      return { status: "REJECTED", failure: "NO_BLOCK", detail: "head unavailable", restarts };
    }

    const hash = await deps.getBlockHash(head.data);
    if (hash.status === "UNAVAILABLE") {
      return { status: "REJECTED", failure: "NO_BLOCK", detail: "pinned block hash unavailable", restarts };
    }

    const pinned: PinnedBlock = { number: head.data, hash: hash.data };

    let data: T;
    try {
      data = await readGroup(pinned);
    } catch (error) {
      return {
        status: "REJECTED",
        failure: "READ_FAILED",
        detail: error instanceof Error ? error.message : String(error),
        block: pinned,
        restarts,
      };
    }

    if (options.verifyAfter === false) {
      return { status: "OK", block: pinned, data, restarts };
    }

    // Re-read the pinned hash. If the group was served by a different provider, or the
    // chain reorged underneath it, this is where it shows.
    const recheck = await deps.getBlockHash(pinned.number);
    if (recheck.status === "UNAVAILABLE") {
      return {
        status: "REJECTED",
        failure: "STATE_UNAVAILABLE",
        detail: "pinned block no longer retrievable",
        block: pinned,
        restarts,
      };
    }

    if (blocksAgree(pinned, { number: pinned.number, hash: recheck.data })) {
      return { status: "OK", block: pinned, data, restarts };
    }

    // Disagreement. Restart the WHOLE group at a fresh block rather than keeping the
    // reads we already have — a partially-valid snapshot is not a valid snapshot.
    restarts += 1;
    if (restarts > maxRestarts) {
      return {
        status: "REJECTED",
        failure: "BLOCK_HASH_MISMATCH",
        detail: `pinned block ${pinned.number} changed hash across ${restarts} attempts`,
        block: pinned,
        restarts,
      };
    }
  }
}

/** Reject a provider whose head is behind, or too far ahead of, the pinned block. */
export function assertProviderFresh(
  providerHead: bigint,
  pinned: PinnedBlock,
  maxLag = DEFAULT_MAX_LAG_BLOCKS
): { ok: true } | { ok: false; failure: SnapshotFailure; detail: string } {
  if (isTooStale(providerHead, pinned.number, maxLag)) {
    return {
      ok: false,
      failure: "PROVIDER_TOO_STALE",
      detail: `provider head ${providerHead} vs pinned ${pinned.number} (max lag ${maxLag})`,
    };
  }
  return { ok: true };
}
