/**
 * Phase 7B.5A §1/§10 — regression test reproducing the historical
 * discovery/trade race (ARCHITECTURE.md §19.9 item 2) and proving the
 * discovery-before-trades barrier (tradeListener.ts) fixes it.
 *
 * The historical bug: the trade loop computed its own toBlock purely from
 * the chain tip and its own checkpoint, completely independent of the
 * discovery checkpoint. If the trade loop's timer fired while a pool's
 * TokenLaunched log sat on-chain but discovery hadn't yet processed that
 * block range, the trade loop could advance its checkpoint straight past
 * that pool's launch block — and since a pool can never appear in
 * trackedTokens before discovery persists it, that pool's trades in the
 * skipped range were permanently unreachable once the checkpoint moved on.
 *
 * This test drives the two listeners directly, out of their timers, in the
 * exact order that reproduces the race (trade tick fires before discovery
 * has processed the range containing a new pool's launch), and proves the
 * new pool still receives every eligible trade once discovery catches up.
 *
 * Run:
 *   PONS_RUN_DB_TESTS=true DATABASE_URL=postgresql://... npx vitest run src/pons/__tests__/coordinationBarrier.dbIntegration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import fs from "fs";
import path from "path";
import { DiscoveryListener, DISCOVERY_CHECKPOINT_SOURCE } from "../discoveryListener";
import { TradeListener, TRADE_CHECKPOINT_SOURCE } from "../tradeListener";
import { RawEvmLog } from "../ponsAdapter";
import { TEST_CONFIG, FakeChainReader } from "./testSupport";

const RUN_DB_TESTS = process.env.PONS_RUN_DB_TESTS === "true";
const FIXTURES_DIR = path.join(__dirname, "fixtures");
const CHAIN = "robinhood";

// "Pool B" — the token whose launch the trade loop must not skip over.
const POOL_B_TOKEN = "0x055650555be80649397084cd3f8a09b4350e8612";
const POOL_B_ADDRESS = "0x8f4f723f10fc7bad28742d25c91158c728557c4c";

// "Pool A" — an already-discovered, unrelated pool tracked from the start
// so the trade listener never short-circuits with NO_POOLS_TRACKED.
const POOL_A_TOKEN = "0x111111111111111111111111111111111111111a";
const POOL_A_ADDRESS = "0x222222222222222222222222222222222222222b";
const POOL_A_QUOTE = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";

function loadRawLogAt(name: string, blockNumber: bigint): RawEvmLog {
  const raw = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8"));
  return { ...raw, blockNumber, blockHash: `0xhash-${blockNumber.toString()}` };
}

describe.skipIf(!RUN_DB_TESTS)("discovery/trade coordination barrier — real Postgres integration", () => {
  const prisma = new PrismaClient();

  async function cleanup() {
    await prisma.chainTrade.deleteMany({ where: { chain: CHAIN, tokenAddress: { in: [POOL_A_TOKEN, POOL_B_TOKEN] } } });
    await prisma.discoveredToken.deleteMany({ where: { chain: CHAIN, tokenAddress: { in: [POOL_A_TOKEN, POOL_B_TOKEN] } } });
    await prisma.chainIngestionCheckpoint.deleteMany({ where: { source: { in: [DISCOVERY_CHECKPOINT_SOURCE, TRADE_CHECKPOINT_SOURCE] } } });
    await prisma.chainBlockCheckpoint.deleteMany({ where: { chain: CHAIN } });
  }

  beforeAll(cleanup);
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });
  beforeEach(cleanup);

  it("a pool discovered after the trade loop begins still receives all eligible trades from its required starting block onward", async () => {
    // --- Initial state: both loops already caught up to height 49. ---
    await prisma.discoveredToken.create({
      data: {
        chain: CHAIN,
        venue: "pons",
        tokenAddress: POOL_A_TOKEN,
        deployer: "0x333333333333333333333333333333333333333c",
        poolAddress: POOL_A_ADDRESS,
        quoteAddress: POOL_A_QUOTE,
        supply: "1000000000000000000000000000",
        initialBuyAmount: "0",
        isToken0: true,
        poolFee: 3_000,
        sourceHeight: 10n,
        sourceHash: "0xhash-10",
        sourceTxHash: "0xa-launch-tx",
        sourceIndex: 0,
      },
    });
    await prisma.chainIngestionCheckpoint.createMany({
      data: [
        { source: DISCOVERY_CHECKPOINT_SOURCE, lastHeight: 49n, lastHash: "0xhash-49" },
        { source: TRADE_CHECKPOINT_SOURCE, lastHeight: 49n, lastHash: "0xhash-49" },
      ],
    });

    // Pool B launches on-chain at block 60 and trades at block 70 — both
    // already sitting in "chain history" the whole time. The chain tip is
    // already at 100, well past both, before either loop ticks again.
    const fakeChain = new FakeChainReader(100n);
    fakeChain.logsByRange = [loadRawLogAt("token_launched_9019252.json", 60n), loadRawLogAt("swap_9019252.json", 70n)];

    const discoveryListener = new DiscoveryListener({ chainClient: fakeChain, db: prisma, config: TEST_CONFIG });
    const tradeListener = new TradeListener({ chainClient: fakeChain, db: prisma, config: TEST_CONFIG });

    // --- Step 1: the trade loop's timer fires FIRST — the exact race. ---
    // Discovery hasn't processed blocks 50-100 yet (its checkpoint is still
    // 49), so pool B does not exist in trackedTokens. The historical bug
    // let the trade loop advance its own checkpoint to the chain tip (100)
    // regardless, permanently skipping block 60-100 for pool B once it was
    // later discovered. The barrier must instead refuse to advance past
    // the discovery checkpoint (49).
    const raceTick = await tradeListener.runOnce();
    expect(raceTick.status).toBe("WAITING_ON_DISCOVERY");

    const tradeCheckpointAfterRace = await prisma.chainIngestionCheckpoint.findUnique({ where: { source: TRADE_CHECKPOINT_SOURCE } });
    expect(tradeCheckpointAfterRace?.lastHeight.toString()).toBe("49"); // did not advance

    // --- Step 2: discovery catches up, persisting pool B before its own checkpoint moves past block 60. ---
    const discoveryTick = await discoveryListener.runOnce();
    expect(discoveryTick.status).toBe("PROCESSED");
    if (discoveryTick.status !== "PROCESSED") throw new Error("expected PROCESSED");
    expect(discoveryTick.tokensDiscovered).toBe(1);

    const poolB = await prisma.discoveredToken.findUnique({ where: { chain_tokenAddress: { chain: CHAIN, tokenAddress: POOL_B_TOKEN } } });
    expect(poolB?.canonicalStatus).toBe("CANONICAL");
    expect(poolB?.enrichmentStatus).toBe("COMPLETE");
    expect(poolB?.poolAddress).toBe(POOL_B_ADDRESS);

    // --- Step 3: the trade loop ticks again — pool B is now trackable, and the barrier now permits reaching its trade. ---
    const catchUpTick = await tradeListener.runOnce();
    expect(catchUpTick.status).toBe("PROCESSED");
    if (catchUpTick.status !== "PROCESSED") throw new Error("expected PROCESSED");
    expect(catchUpTick.fromBlock.toString()).toBe("50"); // resumed from exactly where it left off — no gap, no re-processing
    expect(catchUpTick.tradesRecorded).toBe(1);

    const poolBTrade = await prisma.chainTrade.findFirst({ where: { chain: CHAIN, tokenAddress: POOL_B_TOKEN } });
    expect(poolBTrade).not.toBeNull();
    expect(poolBTrade?.sourceHeight.toString()).toBe("70");

    const finalTradeCheckpoint = await prisma.chainIngestionCheckpoint.findUnique({ where: { source: TRADE_CHECKPOINT_SOURCE } });
    expect(finalTradeCheckpoint?.lastHeight.toString()).toBe("100");
  });

  it("is restart-safe: a fresh listener instance reads the same barrier from Postgres, not from any in-memory state", async () => {
    await prisma.chainIngestionCheckpoint.createMany({
      data: [{ source: DISCOVERY_CHECKPOINT_SOURCE, lastHeight: 20n, lastHash: "0xhash-20" }],
    });
    const fakeChain = new FakeChainReader(100n);
    await prisma.discoveredToken.create({
      data: {
        chain: CHAIN,
        venue: "pons",
        tokenAddress: POOL_A_TOKEN,
        deployer: "0x333333333333333333333333333333333333333c",
        poolAddress: POOL_A_ADDRESS,
        quoteAddress: POOL_A_QUOTE,
        supply: "1",
        initialBuyAmount: "0",
        isToken0: true,
        poolFee: 3_000,
        sourceHeight: 5n,
        sourceHash: "0xhash-5",
        sourceTxHash: "0xa-launch-tx-2",
        sourceIndex: 0,
      },
    });

    const prisma2 = new PrismaClient();
    const freshTradeListener = new TradeListener({ chainClient: fakeChain, db: prisma2, config: TEST_CONFIG });
    const result = await freshTradeListener.runOnce();
    await prisma2.$disconnect();

    // No trade checkpoint exists yet, so it fresh-starts within
    // freshStartLookbackBlocks — but must still be capped by the discovery
    // checkpoint (20), read fresh from Postgres by a brand-new instance.
    expect(result.status === "WAITING_ON_DISCOVERY" || result.status === "PROCESSED").toBe(true);
    if (result.status === "PROCESSED") {
      expect(Number(result.toBlock)).toBeLessThanOrEqual(20);
    }
  });
});
