import { describe, expect, it } from "vitest";

import fixtures from "../__fixtures__/v4PoolState.json";
import {
  POOL_EVIDENCE_CALCULATION_VERSION,
  buildPoolEvidence,
  buildPoolKey,
  decodeLiquidity,
  decodeSlot0,
  isDynamicFee,
  liquiditySlot,
  poolIdFor,
  poolStateSlot,
  priceC0PerC1X18,
  priceC1PerC0X18,
  sortCurrencies,
} from "../v4PoolState";

/**
 * Phase 7D.3 §5 regression coverage.
 *
 * Driven by `__fixtures__/v4PoolState.json`: raw `extsload` words and real
 * `getLaunchedToken` returns captured from Robinhood Chain mainnet at block 61351410.
 * Nothing here is hand-written, so a change in decoding or derivation fails against real
 * protocol bytes rather than against my own assumptions.
 */

const POOLS = fixtures.pools as Array<{
  token: string;
  poolKey: { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string };
  poolId: string;
  stateSlot: string;
  raw: { slot0Word: string; liquidityWord: string };
  launch: { pairToken: string; poolFee: number; tickSpacing: number; creatorTaxBps: number; phase: number; graduationThreshold: string };
}>;

/** Independently known poolIds, persisted by ingestion from on-chain PoolGraduated events. */
const PERSISTED_POOL_IDS: Record<string, string> = {
  "0x21884b3a1a16ac0dd698bd66d25287a05acb254a":
    "0x554be5f8fc76bf8a5de1022e3caae249d4888a88d508a6d1b1b8345a2aef51b8",
  "0x187b69cbc8de7937b7a1d2b4fa39e0d2445efbc1":
    "0x18b555622790311e89a5fb423f3a6b3cf34713257bcc1c125c150b059f2a2076",
  "0x8407d207e1b1fcf93bcce2e9abe0d708eb108f4a":
    "0xb83541295f3af956466fcfd6f54ed0ea2fd5d667cd5435042abe2adf49cef7fa",
};

describe("fixtures", () => {
  it("carries real captured pools", () => {
    expect(POOLS.length).toBeGreaterThanOrEqual(3);
    expect(fixtures.chainId).toBe(4663);
    expect(BigInt(fixtures.blockNumber)).toBeGreaterThan(0n);
  });
});

describe("sortCurrencies", () => {
  it("orders numerically, not lexicographically", () => {
    // "0x9..." < "0xa..." as strings, but these must sort by numeric value.
    const [c0, c1] = sortCurrencies(
      "0xffffffffffffffffffffffffffffffffffffffff",
      "0x0000000000000000000000000000000000000001"
    );
    expect(c0).toBe("0x0000000000000000000000000000000000000001");
    expect(c1).toBe("0xffffffffffffffffffffffffffffffffffffffff");
  });

  it("puts native ETH (0x0) first, which is how every Pons V2 pool is keyed", () => {
    const [c0] = sortCurrencies("0x0000000000000000000000000000000000000000", POOLS[0].token);
    expect(c0).toBe("0x0000000000000000000000000000000000000000");
  });
});

describe("poolIdFor — verified against ids persisted from on-chain events", () => {
  it.each(POOLS.map((p) => [p.token, p] as const))(
    "re-derives the persisted poolId for %s",
    (token, pool) => {
      const key = buildPoolKey({
        tokenAddress: token,
        pairToken: pool.launch.pairToken,
        poolFee: pool.launch.poolFee,
        tickSpacing: pool.launch.tickSpacing,
        hooks: fixtures.memeHook,
      });

      const derived = poolIdFor(key);
      expect(derived).toBe(pool.poolId.toLowerCase());
      // And it matches what ingestion independently recorded from PoolGraduated.
      expect(derived).toBe(PERSISTED_POOL_IDS[token].toLowerCase());
    }
  );

  it("changes if any PoolKey field changes", () => {
    const pool = POOLS[0];
    const base = buildPoolKey({
      tokenAddress: pool.token,
      pairToken: pool.launch.pairToken,
      poolFee: pool.launch.poolFee,
      tickSpacing: pool.launch.tickSpacing,
      hooks: fixtures.memeHook,
    });
    const id = poolIdFor(base);

    expect(poolIdFor({ ...base, fee: base.fee + 1 })).not.toBe(id);
    expect(poolIdFor({ ...base, tickSpacing: base.tickSpacing + 1 })).not.toBe(id);
    expect(poolIdFor({ ...base, hooks: "0x0000000000000000000000000000000000000001" })).not.toBe(id);
  });
});

describe("storage slot derivation", () => {
  it("matches the slot used to capture each fixture", () => {
    for (const pool of POOLS) {
      expect(poolStateSlot(pool.poolId as `0x${string}`)).toBe(pool.stateSlot.toLowerCase());
    }
  });

  it("offsets liquidity by exactly 3 words", () => {
    const base = POOLS[0].stateSlot as `0x${string}`;
    expect(BigInt(liquiditySlot(base)) - BigInt(base)).toBe(3n);
  });
});

describe("decodeSlot0 — against raw captured words", () => {
  it.each(POOLS.map((p) => [p.token, p] as const))("decodes real state for %s", (_token, pool) => {
    const slot0 = decodeSlot0(pool.raw.slot0Word as `0x${string}`);

    expect(slot0.sqrtPriceX96).toBeGreaterThan(0n);
    // These pools are deep in positive-tick territory; a sign-extension bug would flip this.
    expect(slot0.tick).toBeGreaterThan(0);
    expect(slot0.tick).toBeLessThan(887272); // MAX_TICK
    expect(slot0.lpFee).toBe(0); // verified: poolFee 0, non-dynamic
    expect(slot0.protocolFee).toBe(0);
  });

  it("sign-extends a negative int24 tick", () => {
    // tick = -1 is 0xFFFFFF in the 24-bit field at bit 160.
    const word = (0xffffffn << 160n) | 12345n;
    expect(decodeSlot0(word).tick).toBe(-1);
  });

  it("keeps sqrtPriceX96 and tick in separate fields", () => {
    // A word with only the tick set must not leak into sqrtPriceX96.
    expect(decodeSlot0(0x123n << 160n).sqrtPriceX96).toBe(0n);
  });
});

describe("decodeLiquidity", () => {
  it.each(POOLS.map((p) => [p.token, p] as const))("reads real liquidity for %s", (_t, pool) => {
    expect(decodeLiquidity(pool.raw.liquidityWord as `0x${string}`)).toBeGreaterThan(0n);
  });

  it("takes only the low 128 bits", () => {
    const word = (1n << 200n) | 42n;
    expect(decodeLiquidity(word)).toBe(42n);
  });
});

describe("price math — integer only", () => {
  it.each(POOLS.map((p) => [p.token, p] as const))(
    "agrees with 1.0001^tick to tick resolution for %s",
    (_t, pool) => {
      const { sqrtPriceX96, tick } = decodeSlot0(pool.raw.slot0Word as `0x${string}`);
      const fromSqrt = Number(priceC1PerC0X18(sqrtPriceX96)) / 1e18;
      const fromTick = 1.0001 ** tick;

      // Two independent derivations. The tick grid is coarse, so agreement to ~1e-3 is
      // the strongest claim available; anything worse means a decoding bug.
      expect(Math.abs(fromSqrt - fromTick) / fromTick).toBeLessThan(1e-3);
    }
  );

  it("inverse price round-trips", () => {
    const { sqrtPriceX96 } = decodeSlot0(POOLS[0].raw.slot0Word as `0x${string}`);
    const forward = Number(priceC1PerC0X18(sqrtPriceX96)) / 1e18;
    const inverse = Number(priceC0PerC1X18(sqrtPriceX96)) / 1e18;
    expect(Math.abs(forward * inverse - 1)).toBeLessThan(1e-6);
  });

  it("returns 0 for an uninitialized pool rather than dividing by zero", () => {
    expect(priceC0PerC1X18(0n)).toBe(0n);
    expect(priceC1PerC0X18(0n)).toBe(0n);
  });
});

describe("isDynamicFee", () => {
  it("is false for these pools' fixed 0 fee", () => {
    for (const pool of POOLS) expect(isDynamicFee(pool.launch.poolFee)).toBe(false);
  });

  it("detects the 0x800000 marker", () => {
    expect(isDynamicFee(0x800000)).toBe(true);
    expect(isDynamicFee(3000)).toBe(false);
  });
});

describe("buildPoolEvidence", () => {
  it.each(POOLS.map((p) => [p.token, p] as const))("assembles evidence for %s", (token, pool) => {
    const key = buildPoolKey({
      tokenAddress: token,
      pairToken: pool.launch.pairToken,
      poolFee: pool.launch.poolFee,
      tickSpacing: pool.launch.tickSpacing,
      hooks: fixtures.memeHook,
    });

    const result = buildPoolEvidence({
      poolKey: key,
      poolId: poolIdFor(key),
      slot0Word: pool.raw.slot0Word as `0x${string}`,
      liquidityWord: pool.raw.liquidityWord as `0x${string}`,
      creatorTaxBps: pool.launch.creatorTaxBps,
      observedAtBlock: fixtures.blockNumber,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.evidence.protocol).toBe("uniswap-v4");
    expect(result.evidence.liquidity).toBeGreaterThan(0n);
    expect(result.evidence.priceC1PerC0X18).toBeGreaterThan(0n);
    expect(result.evidence.calculationVersion).toBe(POOL_EVIDENCE_CALCULATION_VERSION);
    // A fixed 0 fee is a real 0, not a missing value.
    expect(result.evidence.lpFeeHundredthsBip).toBe(0);
    expect(result.evidence.isDynamicFee).toBe(false);
  });

  it("fails closed on an uninitialized pool instead of reporting price 0", () => {
    const key = buildPoolKey({
      tokenAddress: POOLS[0].token,
      pairToken: POOLS[0].launch.pairToken,
      poolFee: 0,
      tickSpacing: 200,
      hooks: fixtures.memeHook,
    });

    const result = buildPoolEvidence({
      poolKey: key,
      poolId: poolIdFor(key),
      slot0Word: `0x${"0".repeat(64)}`,
      liquidityWord: `0x${"0".repeat(64)}`,
      creatorTaxBps: 200,
      observedAtBlock: fixtures.blockNumber,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("POOL_NOT_INITIALIZED");
  });

  it("always carries the after-swap tax caveat, so no caller can present this as a quote", () => {
    const key = buildPoolKey({
      tokenAddress: POOLS[0].token,
      pairToken: POOLS[0].launch.pairToken,
      poolFee: POOLS[0].launch.poolFee,
      tickSpacing: POOLS[0].launch.tickSpacing,
      hooks: fixtures.memeHook,
    });

    const result = buildPoolEvidence({
      poolKey: key,
      poolId: poolIdFor(key),
      slot0Word: POOLS[0].raw.slot0Word as `0x${string}`,
      liquidityWord: POOLS[0].raw.liquidityWord as `0x${string}`,
      creatorTaxBps: 200,
      observedAtBlock: fixtures.blockNumber,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.evidence.executionCaveat).toMatch(/2\.00% creator tax/);
    expect(result.evidence.executionCaveat).toMatch(/not an executable quote/i);
    expect(result.evidence.creatorTaxBps).toBe(200);
  });
});
