/**
 * Phase 7B.5A §3/§10 — pool-set scaling tests: chunked, bounded-concurrency
 * Swap log queries across a large tracked-pool set, with full completeness
 * preserved (no pool is ever aged out or dropped — see ARCHITECTURE.md's
 * Phase 7B.5A section for why chunking, not a working-set/aging model, was
 * selected).
 *
 * Run:
 *   PONS_RUN_DB_TESTS=true DATABASE_URL=postgresql://... npx vitest run src/pons/__tests__/tradePoolScaling.dbIntegration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { DISCOVERY_CHECKPOINT_SOURCE, ROBINHOOD_CHAIN } from "../discoveryListener";
import { TradeListener, TRADE_CHECKPOINT_SOURCE } from "../tradeListener";
import { TEST_CONFIG, FakeChainReader, makeSwapLog, nextTestAddress, withGetLogsConcurrencyTracking } from "./testSupport";

const RUN_DB_TESTS = process.env.PONS_RUN_DB_TESTS === "true";
const CHAIN = ROBINHOOD_CHAIN;

describe.skipIf(!RUN_DB_TESTS)("trade pool-set scaling — real Postgres integration", () => {
  const prisma = new PrismaClient();
  const seededTokens = new Set<string>();

  async function cleanup() {
    const tokens = [...seededTokens];
    if (tokens.length > 0) {
      await prisma.chainTrade.deleteMany({ where: { chain: CHAIN, tokenAddress: { in: tokens } } });
      await prisma.discoveredToken.deleteMany({ where: { chain: CHAIN, tokenAddress: { in: tokens } } });
    }
    await prisma.chainIngestionCheckpoint.deleteMany({ where: { source: { in: [DISCOVERY_CHECKPOINT_SOURCE, TRADE_CHECKPOINT_SOURCE] } } });
    await prisma.chainBlockCheckpoint.deleteMany({ where: { chain: CHAIN } });
    seededTokens.clear();
  }

  beforeAll(cleanup);
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });
  beforeEach(cleanup);

  it("a large tracked-pool set is queried in bounded, chunked, bounded-concurrency eth_getLogs calls without dropping any pool's trades", async () => {
    // Deliberately not a multiple of tradePoolChunkSize (40), to prove the
    // final short chunk is handled too.
    const POOL_COUNT = 97;
    const pools: { token: string; pool: string }[] = [];
    for (let i = 0; i < POOL_COUNT; i += 1) {
      const token = nextTestAddress();
      const pool = nextTestAddress();
      pools.push({ token, pool });
      seededTokens.add(token);
    }

    await prisma.discoveredToken.createMany({
      data: pools.map(({ token, pool }, i) => ({
        chain: CHAIN,
        venue: "pons",
        tokenAddress: token,
        deployer: nextTestAddress(),
        poolAddress: pool,
        quoteAddress: TEST_CONFIG.quoteAddress.toLowerCase(),
        supply: "1",
        initialBuyAmount: "0",
        isToken0: true,
        poolFee: 3_000,
        sourceHeight: BigInt(i),
        sourceHash: `0xhash-${i}`,
        sourceTxHash: `0xlaunch-scale-${i}`,
        sourceIndex: 0,
      })),
    });
    await prisma.chainIngestionCheckpoint.create({
      data: { source: DISCOVERY_CHECKPOINT_SOURCE, lastHeight: 100n, lastHash: "0xhash-100" },
    });

    // Every single pool trades exactly once in this tick — completeness
    // means every one of these 97 trades must be recorded, not just the
    // ones that happen to fall in the first chunk.
    const fakeChain = new FakeChainReader(100n);
    fakeChain.logsByRange = pools.map(({ pool }, i) => makeSwapLog({ pool: pool as `0x${string}`, amount0: -1000n, amount1: 500n, blockNumber: 50n, txHash: `0xswap-scale-${i}`, logIndex: 0 }));

    let observedPeak = 0;
    let getLogsCalls = 0;
    const trackedChain = withGetLogsConcurrencyTracking(fakeChain, (peak) => {
      observedPeak = Math.max(observedPeak, peak);
    });
    const originalGetLogs = trackedChain.getLogs.bind(trackedChain);
    trackedChain.getLogs = (params) => {
      getLogsCalls += 1;
      return originalGetLogs(params);
    };

    const listener = new TradeListener({ chainClient: trackedChain, db: prisma, config: TEST_CONFIG });
    const result = await listener.runOnce();

    expect(result.status).toBe("PROCESSED");
    if (result.status !== "PROCESSED") throw new Error("expected PROCESSED");
    expect(result.poolsQueried).toBe(POOL_COUNT);

    // 97 pools at a chunk size of 40 -> ceil(97/40) = 3 chunks/calls.
    const expectedChunks = Math.ceil(POOL_COUNT / TEST_CONFIG.tradePoolChunkSize);
    expect(result.rpcLogCalls).toBe(expectedChunks);
    expect(getLogsCalls).toBe(expectedChunks);

    // Bounded concurrency across those chunk calls — never more than
    // tradeQueryConcurrency in flight, but more than one at a time given
    // there is more than one chunk to fetch.
    expect(observedPeak).toBeLessThanOrEqual(TEST_CONFIG.tradeQueryConcurrency);
    expect(observedPeak).toBeGreaterThan(1);

    // Full completeness: every pool's trade was recorded, none silently
    // dropped or aged out because the working set grew large.
    expect(result.tradesRecorded).toBe(POOL_COUNT);
    const tradeCount = await prisma.chainTrade.count({ where: { chain: CHAIN, tokenAddress: { in: pools.map((p) => p.token) } } });
    expect(tradeCount).toBe(POOL_COUNT);
  });
});
