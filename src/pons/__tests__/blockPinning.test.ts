import { describe, expect, it } from "vitest";

import type { ChainClientResult } from "../chainClient";
import {
  DEFAULT_MAX_LAG_BLOCKS,
  assertProviderFresh,
  blocksAgree,
  isTooStale,
  readAtPinnedBlock,
  type PinnedBlock,
} from "../blockPinnedReader";

/**
 * Phase 7D.3.1 §4 — cross-provider block consistency.
 *
 * The failure this guards against is subtle and dangerous: with failover in front of a
 * multi-read group, two reads can land on different providers and therefore different
 * blocks or forks, producing a snapshot that never existed on chain but looks fine.
 */

function ok<T>(data: T): ChainClientResult<T> {
  return { status: "AVAILABLE", data, source: "test", fetchedAt: new Date(), attempts: 1 };
}
function fail<T>(): ChainClientResult<T> {
  return { status: "UNAVAILABLE", source: "test", fetchedAt: new Date(), code: "RPC_ERROR", reason: "down", attempts: 1 };
}

describe("blocksAgree", () => {
  it("requires the hash to match, not just the height", () => {
    // Two providers can both be "at block 100" on different forks.
    expect(blocksAgree({ number: 100n, hash: "0xaaa" }, { number: 100n, hash: "0xbbb" })).toBe(false);
    expect(blocksAgree({ number: 100n, hash: "0xaaa" }, { number: 100n, hash: "0xAAA" })).toBe(true);
    expect(blocksAgree({ number: 100n, hash: "0xaaa" }, { number: 101n, hash: "0xaaa" })).toBe(false);
  });
});

describe("staleness", () => {
  it("rejects a provider behind the pinned block — the state simply is not there", () => {
    expect(isTooStale(99n, 100n)).toBe(true);
  });

  it("accepts a provider within the lag allowance", () => {
    expect(isTooStale(100n, 100n)).toBe(false);
    expect(isTooStale(100n + DEFAULT_MAX_LAG_BLOCKS, 100n)).toBe(false);
  });

  it("rejects a provider too far ahead of the pin to still serve it", () => {
    expect(isTooStale(100n + DEFAULT_MAX_LAG_BLOCKS + 1n, 100n)).toBe(true);
  });

  it("assertProviderFresh reports a reason code, not just a boolean", () => {
    const result = assertProviderFresh(50n, { number: 100n, hash: "0xaaa" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe("PROVIDER_TOO_STALE");
    expect(result.detail).toContain("100");
  });
});

describe("readAtPinnedBlock", () => {
  it("pins one block and passes it to every read in the group", async () => {
    const seen: PinnedBlock[] = [];
    const result = await readAtPinnedBlock(
      { getHead: async () => ok(500n), getBlockHash: async () => ok("0xabc") },
      async (block) => {
        // A real group performs several reads; all must receive the same pin.
        seen.push(block);
        seen.push(block);
        return "evidence";
      }
    );

    expect(result.status).toBe("OK");
    expect(result.block).toEqual({ number: 500n, hash: "0xabc" });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual(seen[1]);
  });

  it("records the block hash alongside the data as provenance", async () => {
    const result = await readAtPinnedBlock(
      { getHead: async () => ok(500n), getBlockHash: async () => ok("0xabc") },
      async () => ({ price: 1n })
    );
    expect(result.block?.hash).toBe("0xabc");
    expect(result.block?.number).toBe(500n);
  });

  it("rejects the snapshot when the pinned hash changes mid-group", async () => {
    // Alternating hashes: the pin read and the verification re-read NEVER agree, which
    // is a provider flapping between forks. A stable second value would legitimately
    // settle on the restart, so the mock has to keep disagreeing to exercise rejection.
    let call = 0;
    const result = await readAtPinnedBlock(
      {
        getHead: async () => ok(500n),
        getBlockHash: async () => ok(call++ % 2 === 0 ? "0xaaa" : "0xbbb"),
        maxRestarts: 1,
      },
      async () => "evidence"
    );

    expect(result.status).toBe("REJECTED");
    expect(result.failure).toBe("BLOCK_HASH_MISMATCH");
    // It restarted the whole group rather than keeping partial reads.
    expect(result.restarts).toBeGreaterThan(0);
  });

  it("restarts at a fresh block and succeeds when the chain settles", async () => {
    // Attempt 1: pin 0xaaa, verify returns 0xbbb (reorg). Attempt 2: consistent.
    const hashes = ["0xaaa", "0xbbb", "0xccc", "0xccc"];
    let i = 0;
    const result = await readAtPinnedBlock(
      { getHead: async () => ok(500n), getBlockHash: async () => ok(hashes[i++]), maxRestarts: 2 },
      async () => "evidence"
    );

    expect(result.status).toBe("OK");
    expect(result.restarts).toBe(1);
    expect(result.block?.hash).toBe("0xccc");
  });

  it("rejects rather than falling back to latest when the head is unavailable", async () => {
    const result = await readAtPinnedBlock(
      { getHead: async () => fail<bigint>(), getBlockHash: async () => ok("0xabc") },
      async () => "evidence"
    );
    expect(result.status).toBe("REJECTED");
    expect(result.failure).toBe("NO_BLOCK");
    expect(result.data).toBeUndefined();
  });

  it("rejects when the pinned block cannot be re-read — never returns a partial snapshot", async () => {
    let call = 0;
    const result = await readAtPinnedBlock(
      {
        getHead: async () => ok(500n),
        getBlockHash: async () => (call++ === 0 ? ok("0xaaa") : fail<string>()),
      },
      async () => "evidence"
    );

    expect(result.status).toBe("REJECTED");
    expect(result.failure).toBe("STATE_UNAVAILABLE");
    expect(result.data).toBeUndefined();
  });

  it("surfaces a read failure inside the group with its block context", async () => {
    const result = await readAtPinnedBlock(
      { getHead: async () => ok(500n), getBlockHash: async () => ok("0xabc") },
      async () => {
        throw new Error("extsload failed");
      }
    );

    expect(result.status).toBe("REJECTED");
    expect(result.failure).toBe("READ_FAILED");
    expect(result.detail).toContain("extsload failed");
    expect(result.block?.number).toBe(500n);
  });

  it("can skip post-verification for a single-read group", async () => {
    let hashCalls = 0;
    const result = await readAtPinnedBlock(
      {
        getHead: async () => ok(500n),
        getBlockHash: async () => { hashCalls++; return ok("0xabc"); },
      },
      async () => "single",
      { verifyAfter: false }
    );

    expect(result.status).toBe("OK");
    // Pinned once, not re-verified — appropriate only when there is nothing to mix.
    expect(hashCalls).toBe(1);
  });
});
