/**
 * Phase 7D.4 — market snapshot worker on real PostgreSQL with a scripted Multicall3 chain.
 *   PONS_RUN_DB_TESTS=true DATABASE_URL=postgresql://…/ci_x_test npx vitest run --no-file-parallelism src/pons/market/__tests__/marketSnapshotWorker.dbIntegration.test.ts
 */
import { PrismaClient } from "@prisma/client";
import { decodeFunctionData, encodeFunctionData, encodeFunctionResult, type Abi, type Hex } from "viem";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { QuoteUsdRateProvider } from "../../../candles/usdPricing";
import type { ChainCaller } from "../../chainClient";
import { PONS_V2_FACTORY_ABI } from "../../abiV2";
import { MULTICALL3_ABI, PONS_MEME_HOOK_ABI, STATE_VIEW_ABI } from "../../quote/protocol";
import { buildPoolKey, poolIdFor } from "../../v4PoolState";
import { recordSampleAndChange, runSnapshotBatch, seedSnapshots, SNAPSHOT_CURVE_ABI } from "../marketSnapshotWorker";

const RUN = process.env.PONS_RUN_DB_TESTS === "true";
const ERC20 = [
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const satisfies Abi;

const BONDING = "0x7d9a393758c06e816e1d3ce2d5474eb364f84554";
const BONDING_CURVE = "0x3fbbc58982bff63c8146909dadc2beb6175428cf";
const GRAD = "0x6cde1147da625a9cb84edf656eb603e26576d6f3";
const GRAD_CURVE = "0x76fc402a0fd14913d22772e2631deca2a85615cf";
const POOL = "0x87c656041aa50a6e216ffdaa5a9df308bfe69751c4179ce04112a044217e26a5";
const STALE = "0x5555555555555555555555555555555555555555"; // DB says bonding, chain says graduated
const STALE_CURVE = "0x5555555555555555555555555555555555555556";
const NATIVE = "0x0000000000000000000000000000000000000000";
const FACTORY = "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e";
const HOOK = "0x1111111111111111111111111111111111110044";
const TOKENS = [BONDING, GRAD, STALE];

type Handler = (fn: string, args: readonly unknown[]) => unknown;

/** Real mainnet values from 2026-09-15 (see marketSnapshot.test.ts). */
function chain(overrides: { reserves?: [bigint, bigint]; failRpc?: boolean; phase?: number; hookMemecoin?: string } = {}): ChainCaller & { calls: number } {
  const curve: Record<string, unknown> = {
    getReserves: overrides.reserves ?? [1744286899831547514n, 963144308520716522580550845n],
    realQuoteReserve: 64286899831547514n,
    reservedTokens: 285714285714285714285714285n,
    launchSupply: 10n ** 27n,
    sellableTokens: 677430022806430808294836560n,
    graduated: false,
    readyToGraduate: false,
    graduationThreshold: 4200000000000000000n,
  };
  const targets: Record<string, { abi: Abi; handle: Handler }> = {
    [BONDING_CURVE]: { abi: SNAPSHOT_CURVE_ABI as Abi, handle: (fn) => curve[fn] },
    [STALE_CURVE]: { abi: SNAPSHOT_CURVE_ABI as Abi, handle: (fn) => (fn === "graduated" ? true : curve[fn]) },
    "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b": {
      abi: STATE_VIEW_ABI as Abi,
      handle: (fn) => (fn === "getSlot0" ? [2383382949210321874271083906747709n, 206244, 0, 0] : 29277002188455995824267n),
    },
  };
  for (const t of TOKENS) targets[t] = { abi: ERC20, handle: (fn) => (fn === "decimals" ? 18 : 10n ** 27n) };
  const staleKey = buildPoolKey({ tokenAddress: STALE, pairToken: NATIVE, poolFee: 10_000, tickSpacing: 200, hooks: HOOK });
  targets[FACTORY] = {
    abi: PONS_V2_FACTORY_ABI as Abi,
    handle: (fn, args) =>
      fn === "memeHook"
        ? HOOK
        : { token: args[0], curve: STALE_CURVE, deployer: NATIVE, creatorFeeRecipient: NATIVE, pairToken: NATIVE, graduationThreshold: 1n, poolFee: 10_000, tickSpacing: 200, creatorTaxBps: 0, buybackEnabled: false, phase: overrides.phase ?? 2, sweptQuote: 0n, sweptTokens: 0n, sweptAt: 0n, exists: true },
  };
  targets[HOOK] = {
    abi: PONS_MEME_HOOK_ABI as Abi,
    handle: (_fn, args) => {
      const registered = args[0] === poolIdFor(staleKey);
      return [registered, staleKey.currency0 === STALE, overrides.hookMemecoin ?? STALE, NATIVE, NATIVE, NATIVE, NATIVE, 0, 0, 0, 0, 0, false];
    },
  };
  const fake = {
    calls: 0,
    async getBlockNumber() {
      return { status: "AVAILABLE", data: 63_000_000n, source: "fake", fetchedAt: new Date(), attempts: 1 } as const;
    },
    async getBlockRef(n: bigint) {
      return { status: "AVAILABLE", data: { number: n, hash: "0x" + "ab".repeat(32), timestamp: 1_789_480_000n, parentHash: "0x" + "cd".repeat(32) }, source: "fake", fetchedAt: new Date(), attempts: 1 } as never;
    },
    async call(params: { data: Hex }) {
      fake.calls += 1;
      if (overrides.failRpc) return { status: "UNAVAILABLE", code: "RPC_ERROR", reason: "down https://rpc.example/key", source: "fake", fetchedAt: new Date(), attempts: 1 } as const;
      const { args } = decodeFunctionData({ abi: MULTICALL3_ABI, data: params.data });
      const calls = args[0] as readonly { target: Hex; callData: Hex }[];
      const results = calls.map((c) => {
        const t = targets[c.target.toLowerCase()];
        const decoded = decodeFunctionData({ abi: t.abi, data: c.callData });
        const value = t.handle(decoded.functionName, decoded.args ?? []);
        return { success: true, returnData: encodeFunctionResult({ abi: t.abi, functionName: decoded.functionName, result: value } as never) };
      });
      return { status: "AVAILABLE", data: { kind: "SUCCESS", data: encodeFunctionResult({ abi: MULTICALL3_ABI, functionName: "aggregate3", result: results }) }, source: "fake", fetchedAt: new Date(), attempts: 1 } as const;
    },
  };
  void encodeFunctionData;
  return fake as unknown as ChainCaller & { calls: number };
}

const usd: QuoteUsdRateProvider = {
  name: "fixed",
  async getHistoricalRate() {
    return { status: "AVAILABLE", rate: { rateUsdPerQuote: "4500", observedAt: new Date(), source: "chainlink:ETH/USD" } };
  },
};

describe.skipIf(!RUN)("market snapshot worker — real Postgres", () => {
  const db = new PrismaClient();
  const token = (tokenAddress: string, curveAddress: string, graduated: boolean, poolId: string | null, i: number) =>
    db.discoveredToken.create({
      data: {
        chain: "robinhood", venue: "pons_v2", tokenAddress, curveAddress, graduated, poolId, isToken0: poolId ? false : null,
        deployer: NATIVE.replace(/0$/, "1"), quoteAddress: NATIVE, initialBuyAmount: 0, sourceHeight: BigInt(900_000_000 + i),
        sourceHash: "0x" + "00".repeat(32), sourceTxHash: "0x" + i.toString(16).padStart(64, "0"), sourceIndex: i,
      },
    });
  const cleanup = async () => {
    await db.tokenMarketSample.deleteMany({ where: { tokenAddress: { in: TOKENS } } });
    await db.tokenMarketSnapshot.deleteMany({ where: { tokenAddress: { in: TOKENS } } });
    await db.discoveredToken.deleteMany({ where: { tokenAddress: { in: TOKENS } } });
  };
  beforeEach(async () => {
    await cleanup();
    // Keep unrelated rows out of the due queue for this test.
    await db.tokenMarketSnapshot.updateMany({ data: { nextRefreshAt: new Date(Date.now() + 86_400_000) } });
    await token(BONDING, BONDING_CURVE, false, null, 1);
    await token(GRAD, GRAD_CURVE, true, POOL, 2);
    await token(STALE, STALE_CURVE, false, null, 3);
  });
  afterAll(async () => {
    await cleanup();
    await db.$disconnect();
  });

  it("seeds, reads a curve and a pool at one block, values them in USD, and refuses to guess a missing pool", async () => {
    expect(await seedSnapshots(db)).toBeGreaterThanOrEqual(3);
    const stats = await runSnapshotBatch({ db, caller: chain(), usd });
    expect(stats).toMatchObject({ ok: 2, failed: 1 });

    const b = await db.tokenMarketSnapshot.findUniqueOrThrow({ where: { chain_tokenAddress: { chain: "robinhood", tokenAddress: BONDING } } });
    expect(b).toMatchObject({ status: "OK", venue: "PONS_V2_BONDING_CURVE", bondingProgressBps: 515, graduated: false, blockNumber: 63_000_000n });
    expect(Number(b.marketCapUsd)).toBeCloseTo(1.811 * 4500, -1);
    expect(Number(b.liquidityUsd)).toBeCloseTo(0.0642869 * 4500, 0);
    expect(b.priceUsd?.toString()).toMatch(/^0\.0000081/);

    const g = await db.tokenMarketSnapshot.findUniqueOrThrow({ where: { chain_tokenAddress: { chain: "robinhood", tokenAddress: GRAD } } });
    expect(g).toMatchObject({ status: "OK", venue: "UNISWAP_V4_POOL", graduated: true, bondingProgressBps: 10_000 });

    const s = await db.tokenMarketSnapshot.findUniqueOrThrow({ where: { chain_tokenAddress: { chain: "robinhood", tokenAddress: STALE } } });
    expect(s).toMatchObject({ status: "FAILED", lastError: "graduated on chain; pool not indexed yet", priceQuoteX36: null });
  });

  it("keeps the last good values and redacts URLs when the RPC fails, and schedules unchanged tokens later", async () => {
    await seedSnapshots(db);
    const now = new Date();
    await runSnapshotBatch({ db, caller: chain(), usd, now: () => now });
    await db.tokenMarketSnapshot.updateMany({ where: { tokenAddress: { in: TOKENS } }, data: { nextRefreshAt: now } });
    await runSnapshotBatch({ db, caller: chain({ failRpc: true }), usd, now: () => now });
    const b = await db.tokenMarketSnapshot.findUniqueOrThrow({ where: { chain_tokenAddress: { chain: "robinhood", tokenAddress: BONDING } } });
    expect(b.status).toBe("OK");
    expect(b.priceQuoteX36).not.toBeNull();
    expect(b.lastError).not.toMatch(/rpc\.example/);

    await db.tokenMarketSnapshot.updateMany({ where: { tokenAddress: { in: TOKENS } }, data: { nextRefreshAt: now } });
    const later = new Date(now.getTime() + 1000);
    await runSnapshotBatch({ db, caller: chain(), usd, now: () => later });
    const unchanged = await db.tokenMarketSnapshot.findUniqueOrThrow({ where: { chain_tokenAddress: { chain: "robinhood", tokenAddress: BONDING } } });
    expect(unchanged.unchangedReads).toBe(1);
    expect(unchanged.nextRefreshAt!.getTime() - later.getTime()).toBeGreaterThanOrEqual(5 * 60_000);

    await db.tokenMarketSnapshot.updateMany({ where: { tokenAddress: BONDING }, data: { nextRefreshAt: later } });
    await runSnapshotBatch({ db, caller: chain({ reserves: [1844286899831547514n, 913144308520716522580550845n] }), usd, now: () => later });
    const moved = await db.tokenMarketSnapshot.findUniqueOrThrow({ where: { chain_tokenAddress: { chain: "robinhood", tokenAddress: BONDING } } });
    expect(moved.unchangedReads).toBe(0);
    expect(moved.nextRefreshAt!.getTime() - later.getTime()).toBe(60_000);
  });

  it("computes the 1h market-cap change only against a sample from about an hour ago", async () => {
    await seedSnapshots(db);
    const t0 = new Date("2026-09-15T12:00:00Z");
    await recordSampleAndChange(db, BONDING, t0, "1000", 1n);
    let snap = await db.tokenMarketSnapshot.findUniqueOrThrow({ where: { chain_tokenAddress: { chain: "robinhood", tokenAddress: BONDING } } });
    expect(snap.marketCapChange1hUsd).toBeNull();
    await recordSampleAndChange(db, BONDING, new Date(t0.getTime() + 2 * 60_000), "1100", 1n);
    expect(await db.tokenMarketSample.count({ where: { tokenAddress: BONDING } })).toBe(1);
    await recordSampleAndChange(db, BONDING, new Date(t0.getTime() + 60 * 60_000), "1500", 1n);
    snap = await db.tokenMarketSnapshot.findUniqueOrThrow({ where: { chain_tokenAddress: { chain: "robinhood", tokenAddress: BONDING } } });
    expect(Number(snap.marketCapChange1hUsd)).toBe(500);
    expect(Number(snap.marketCapChange1hPct)).toBe(50);
  });

  it("prices a token that graduated after discovery's height from its derived, hook-verified pool", async () => {
    await seedSnapshots(db);
    const stats = await runSnapshotBatch({ db, caller: chain(), usd, factoryAddress: FACTORY });
    expect(stats.failed).toBe(0);
    const s = await db.tokenMarketSnapshot.findUniqueOrThrow({ where: { chain_tokenAddress: { chain: "robinhood", tokenAddress: STALE } } });
    expect(s).toMatchObject({ status: "OK", venue: "UNISWAP_V4_POOL", graduated: true });
    expect(s.priceQuoteX36).not.toBeNull();
  });

  it("refuses a derived pool the hook does not register for this token, and retries a sweep in progress soon", async () => {
    await seedSnapshots(db);
    const now = new Date();
    await runSnapshotBatch({ db, caller: chain({ hookMemecoin: "0x9999999999999999999999999999999999999999" }), usd, factoryAddress: FACTORY, now: () => now });
    let s = await db.tokenMarketSnapshot.findUniqueOrThrow({ where: { chain_tokenAddress: { chain: "robinhood", tokenAddress: STALE } } });
    expect(s).toMatchObject({ status: "FAILED", lastError: "hook registration does not match the factory record", priceQuoteX36: null });

    await db.tokenMarketSnapshot.updateMany({ where: { tokenAddress: STALE }, data: { nextRefreshAt: now } });
    await runSnapshotBatch({ db, caller: chain({ phase: 1 }), usd, factoryAddress: FACTORY, now: () => now });
    s = await db.tokenMarketSnapshot.findUniqueOrThrow({ where: { chain_tokenAddress: { chain: "robinhood", tokenAddress: STALE } } });
    expect(s).toMatchObject({ status: "FAILED", lastError: "graduating: curve closed, pool not created yet" });
    expect(s.nextRefreshAt!.getTime() - now.getTime()).toBe(60_000);
  });
});
