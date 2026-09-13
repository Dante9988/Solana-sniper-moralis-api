import { describe, expect, it } from "vitest";

import fixtures from "../__fixtures__/v4PoolState.json";
import type { ChainClientResult, ChainReader } from "../chainClient";
import { fetchPoolEvidence } from "../v4PoolEvidenceService";

/**
 * Phase 7D.3 §5 — the fail-closed contract.
 *
 * Every path that cannot produce honest evidence must return a reason code. None may
 * return a zero price, a partial object, or throw.
 */

const POOL = fixtures.pools[0] as any;
const FACTORY = fixtures.factory as string;
const POOL_MANAGER = fixtures.poolManager as string;
const HOOKS = fixtures.memeHook as string;

function ok<T>(data: T): ChainClientResult<T> {
  return { status: "AVAILABLE", data, source: "test", fetchedAt: new Date(), attempts: 1 };
}
function fail<T>(): ChainClientResult<T> {
  return {
    status: "UNAVAILABLE",
    source: "test",
    fetchedAt: new Date(),
    code: "NETWORK_ERROR",
    reason: "connection reset",
    attempts: 3,
  };
}

/** A reader wired to the captured fixture, with per-call overrides. */
function makeReader(overrides: {
  launch?: ChainClientResult<unknown>;
  slot0?: ChainClientResult<unknown>;
  liquidity?: ChainClientResult<unknown>;
  blockNumber?: ChainClientResult<bigint>;
} = {}): ChainReader {
  const launchData = {
    pairToken: POOL.launch.pairToken,
    poolFee: POOL.launch.poolFee,
    tickSpacing: POOL.launch.tickSpacing,
    creatorTaxBps: POOL.launch.creatorTaxBps,
    phase: POOL.launch.phase,
    exists: true,
  };

  return {
    getBlockNumber: async () => (overrides.blockNumber ?? ok(BigInt(fixtures.blockNumber))) as any,
    getBlockRef: async () => fail() as any,
    getTransaction: async () => fail() as any,
    getLogs: async () => fail() as any,
    readContract: (async (params: { functionName: string; args: readonly unknown[] }) => {
      if (params.functionName === "getLaunchedToken") return overrides.launch ?? ok(launchData);
      // Two extsload calls: state slot, then state slot + 3.
      const slot = String(params.args[0]).toLowerCase();
      const isLiquidity = BigInt(slot) === BigInt(POOL.stateSlot) + 3n;
      if (isLiquidity) return overrides.liquidity ?? ok(POOL.raw.liquidityWord);
      return overrides.slot0 ?? ok(POOL.raw.slot0Word);
    }) as ChainReader["readContract"],
  };
}

const baseParams = {
  factoryAddress: FACTORY,
  poolManagerAddress: POOL_MANAGER,
  hooksAddress: HOOKS,
  tokenAddress: POOL.token as string,
};

describe("fetchPoolEvidence", () => {
  it("returns real evidence for a graduated token", async () => {
    const result = await fetchPoolEvidence({ reader: makeReader(), ...baseParams });

    expect(result.status).toBe("AVAILABLE");
    if (result.status !== "AVAILABLE") return;

    expect(result.evidence.poolId).toBe(POOL.poolId.toLowerCase());
    expect(result.evidence.protocol).toBe("uniswap-v4");
    expect(result.evidence.liquidity).toBeGreaterThan(0n);
    expect(result.evidence.priceC1PerC0X18).toBeGreaterThan(0n);
    expect(result.evidence.observedAtBlock).toBe(fixtures.blockNumber);
    expect(result.evidence.executionCaveat).toMatch(/not an executable quote/i);
  });

  it("says NOT_GRADUATED rather than reading an empty pool", async () => {
    const reader = makeReader({
      launch: ok({ ...POOL.launch, phase: 1, exists: true }),
    });
    const result = await fetchPoolEvidence({ reader, ...baseParams });

    expect(result.status).toBe("UNAVAILABLE");
    if (result.status !== "UNAVAILABLE") return;
    expect(result.reason).toBe("NOT_GRADUATED");
  });

  it("says UNSUPPORTED_VENUE when the factory does not know the token", async () => {
    const reader = makeReader({ launch: ok({ ...POOL.launch, exists: false }) });
    const result = await fetchPoolEvidence({ reader, ...baseParams });

    expect(result.status).toBe("UNAVAILABLE");
    if (result.status !== "UNAVAILABLE") return;
    expect(result.reason).toBe("UNSUPPORTED_VENUE");
  });

  it.each([
    ["launch read", { launch: fail() }],
    ["slot0 read", { slot0: fail() }],
    ["liquidity read", { liquidity: fail() }],
  ])("degrades to RPC_UNAVAILABLE when the %s fails", async (_label, override) => {
    const result = await fetchPoolEvidence({ reader: makeReader(override as any), ...baseParams });

    expect(result.status).toBe("UNAVAILABLE");
    if (result.status !== "UNAVAILABLE") return;
    expect(result.reason).toBe("RPC_UNAVAILABLE");
    // The detail names which read failed, so an operator can act on it.
    expect(result.detail).toMatch(/NETWORK_ERROR/);
  });

  it("reports POOL_NOT_INITIALIZED instead of a zero price", async () => {
    const reader = makeReader({ slot0: ok(`0x${"0".repeat(64)}`) });
    const result = await fetchPoolEvidence({ reader, ...baseParams });

    expect(result.status).toBe("UNAVAILABLE");
    if (result.status !== "UNAVAILABLE") return;
    expect(result.reason).toBe("POOL_NOT_INITIALIZED");
  });

  it("still returns evidence when the block number is unavailable", async () => {
    // Freshness is nice to have; losing it must not discard real pool state.
    const reader = makeReader({ blockNumber: fail() as ChainClientResult<bigint> });
    const result = await fetchPoolEvidence({ reader, ...baseParams });

    expect(result.status).toBe("AVAILABLE");
    if (result.status !== "AVAILABLE") return;
    expect(result.evidence.observedAtBlock).toBe("");
  });

  it("never reports a USD figure", async () => {
    const result = await fetchPoolEvidence({ reader: makeReader(), ...baseParams });
    expect(result.status).toBe("AVAILABLE");
    if (result.status !== "AVAILABLE") return;
    // USD requires a trustworthy conversion that does not exist for this chain.
    // BigInt is not JSON-serializable, which is itself the contract: the API boundary
    // must render these as decimal strings, never as JS numbers.
    const serialized = JSON.stringify(result.evidence, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v
    );
    expect(serialized.toLowerCase()).not.toContain("usd");
  });
});
