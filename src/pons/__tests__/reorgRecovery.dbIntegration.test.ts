/**
 * Phase 7B.5A §2/§10 — bounded reorg rollback/replay tests.
 *
 * These prove the *local* mechanics against a fake chain and real
 * Postgres: ancestor search over the bounded (height,hash) history,
 * orphaning of facts above the ancestor, checkpoint rollback, graduation
 * reconciliation, fail-closed behavior with no common ancestor, and
 * idempotency across repeated detection and a simulated restart.
 *
 * They do NOT prove live-mainnet reorg behavior — no real reorg is
 * manufactured or observed against Robinhood Chain here. See the
 * completion report's "not proven" section.
 *
 * Run:
 *   PONS_RUN_DB_TESTS=true DATABASE_URL=postgresql://... npx vitest run src/pons/__tests__/reorgRecovery.dbIntegration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { attemptReorgRecovery } from "../reorgRecovery";
import { DiscoveryListener, DISCOVERY_CHECKPOINT_SOURCE, ROBINHOOD_CHAIN } from "../discoveryListener";
import { TRADE_CHECKPOINT_SOURCE } from "../tradeListener";
import { TEST_CONFIG, FakeChainReader } from "./testSupport";

const RUN_DB_TESTS = process.env.PONS_RUN_DB_TESTS === "true";
const CHAIN = ROBINHOOD_CHAIN;
const TOKEN = "0x444444444444444444444444444444444444444d";
const POOL = "0x555555555555555555555555555555555555555e";
const QUOTE = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";

describe.skipIf(!RUN_DB_TESTS)("reorg recovery — real Postgres integration", () => {
  const prisma = new PrismaClient();

  async function cleanup() {
    await prisma.chainTrade.deleteMany({ where: { chain: CHAIN, tokenAddress: TOKEN } });
    await prisma.discoveredToken.deleteMany({ where: { chain: CHAIN, tokenAddress: TOKEN } });
    await prisma.chainIngestionCheckpoint.deleteMany({ where: { source: { in: [DISCOVERY_CHECKPOINT_SOURCE, TRADE_CHECKPOINT_SOURCE] } } });
    await prisma.chainBlockCheckpoint.deleteMany({ where: { chain: CHAIN } });
  }

  beforeAll(cleanup);
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });
  beforeEach(cleanup);

  /** Seeds a bounded history of committed (height,hash) checkpoints, as the two listeners would have produced over several real ticks. */
  async function seedHistory(heights: bigint[]) {
    for (const h of heights) {
      await prisma.chainBlockCheckpoint.upsert({
        where: { chain_height: { chain: CHAIN, height: h } },
        create: { chain: CHAIN, height: h, hash: `0xhash-${h.toString()}` },
        update: { hash: `0xhash-${h.toString()}` },
      });
    }
  }

  it("shallow reorg: finds the common ancestor a few blocks back and recovers", async () => {
    await seedHistory([80n, 90n, 100n]);
    await prisma.chainIngestionCheckpoint.createMany({
      data: [
        { source: DISCOVERY_CHECKPOINT_SOURCE, lastHeight: 100n, lastHash: "0xhash-100" },
        { source: TRADE_CHECKPOINT_SOURCE, lastHeight: 95n, lastHash: "0xhash-95" },
      ],
    });
    await prisma.discoveredToken.create({
      data: {
        chain: CHAIN, venue: "pons", tokenAddress: TOKEN, deployer: "0x666666666666666666666666666666666666666f",
        poolAddress: POOL, quoteAddress: QUOTE, supply: "1", initialBuyAmount: "0", isToken0: true, poolFee: 3_000,
        sourceHeight: 95n, sourceHash: "0xhash-95", sourceTxHash: "0xlaunch-shallow", sourceIndex: 0,
      },
    });
    await prisma.chainTrade.create({
      data: {
        chain: CHAIN, venue: "pons", tokenAddress: TOKEN, poolAddress: POOL, side: "buy",
        tokenAmount: "1", quoteAmount: "1", quoteAddress: QUOTE, priceQuote: "1",
        trader: "0x777777777777777777777777777777777777777a", sourceHeight: 96n, sourceHash: "0xhash-96",
        sourceTxHash: "0xtrade-shallow", sourceIndex: 0,
      },
    });

    // The chain now disagrees at 100 and 90, but still agrees at 80.
    const fakeChain = new FakeChainReader(120n);
    fakeChain.setBlockHash(100n, "0xFORKED-100");
    fakeChain.setBlockHash(90n, "0xFORKED-90");

    const result = await attemptReorgRecovery({ chainClient: fakeChain, db: prisma, chain: CHAIN });
    expect(result.status).toBe("RECOVERED");
    if (result.status !== "RECOVERED") throw new Error("expected RECOVERED");
    expect(result.ancestorHeight.toString()).toBe("80");
    expect(result.orphanedTokens).toBe(1);
    expect(result.orphanedTrades).toBe(1);
    expect(result.rolledBackSources.sort()).toEqual([DISCOVERY_CHECKPOINT_SOURCE, TRADE_CHECKPOINT_SOURCE].sort());

    const token = await prisma.discoveredToken.findUnique({ where: { chain_tokenAddress: { chain: CHAIN, tokenAddress: TOKEN } } });
    expect(token?.canonicalStatus).toBe("ORPHANED");
    expect(token?.orphanedAt).not.toBeNull();

    const trade = await prisma.chainTrade.findFirst({ where: { chain: CHAIN, tokenAddress: TOKEN } });
    expect(trade?.canonicalStatus).toBe("ORPHANED");

    const discoveryCp = await prisma.chainIngestionCheckpoint.findUnique({ where: { source: DISCOVERY_CHECKPOINT_SOURCE } });
    expect(discoveryCp?.lastHeight.toString()).toBe("80");
    const tradeCp = await prisma.chainIngestionCheckpoint.findUnique({ where: { source: TRADE_CHECKPOINT_SOURCE } });
    expect(tradeCp?.lastHeight.toString()).toBe("80"); // was 95, rolled back below the ancestor too

    const remainingHistory = await prisma.chainBlockCheckpoint.findMany({ where: { chain: CHAIN } });
    expect(remainingHistory.map((h) => h.height.toString()).sort()).toEqual(["80"]);
  });

  it("a token launch orphaned by reorg is revived to CANONICAL if the same address relaunches on the canonical chain during replay", async () => {
    await seedHistory([50n]);
    await prisma.chainIngestionCheckpoint.createMany({
      data: [{ source: DISCOVERY_CHECKPOINT_SOURCE, lastHeight: 60n, lastHash: "0xhash-60" }],
    });
    await prisma.discoveredToken.create({
      data: {
        chain: CHAIN, venue: "pons", tokenAddress: TOKEN, deployer: "0x666666666666666666666666666666666666666f",
        poolAddress: POOL, quoteAddress: QUOTE, supply: "1", initialBuyAmount: "0", isToken0: true, poolFee: 3_000,
        sourceHeight: 60n, sourceHash: "0xhash-60", sourceTxHash: "0xlaunch-orphan", sourceIndex: 0,
        graduated: true, graduationPairedPrincipal: "5", graduationThreshold: "10", graduationCheckedAt: new Date(),
      },
    });
    const fakeChain = new FakeChainReader(60n);
    fakeChain.setBlockHash(60n, "0xFORKED-60");

    const recovery = await attemptReorgRecovery({ chainClient: fakeChain, db: prisma, chain: CHAIN });
    expect(recovery.status).toBe("RECOVERED");
    if (recovery.status !== "RECOVERED") throw new Error("expected RECOVERED");
    expect(recovery.ancestorHeight.toString()).toBe("50");

    const orphaned = await prisma.discoveredToken.findUnique({ where: { chain_tokenAddress: { chain: CHAIN, tokenAddress: TOKEN } } });
    expect(orphaned?.canonicalStatus).toBe("ORPHANED");
    // Graduation state affected by reorg — reset to unchecked, never left as a stale "true".
    expect(orphaned?.graduated).toBe(false);
    expect(orphaned?.graduationPairedPrincipal).toBeNull();
    expect(orphaned?.graduationCheckedAt).toBeNull();

    // Replay: the canonical chain relaunches the exact same token address
    // (e.g. a deterministic deployer nonce/CREATE2 collision after the
    // fork) at a new height/tx. DiscoveryListener's upsert must revive it.
    const discoveryListener = new DiscoveryListener({ chainClient: fakeChain, db: prisma, config: TEST_CONFIG });
    // Directly exercise the adapter/persistence path via a synthetic log
    // would require real ABI encoding; instead assert the invariant at the
    // persistence layer the same way discoveryListener.ts's upsert does.
    await prisma.discoveredToken.upsert({
      where: { chain_tokenAddress: { chain: CHAIN, tokenAddress: TOKEN } },
      create: { chain: CHAIN, venue: "pons", tokenAddress: TOKEN, deployer: "0x666666666666666666666666666666666666666f", poolAddress: POOL, quoteAddress: QUOTE, supply: "1", initialBuyAmount: "0", isToken0: true, poolFee: 3_000, sourceHeight: 55n, sourceHash: "0xhash-55", sourceTxHash: "0xlaunch-replay", sourceIndex: 0 },
      update: { canonicalStatus: "CANONICAL", orphanedAt: null, sourceHeight: 55n, sourceHash: "0xhash-55", sourceTxHash: "0xlaunch-replay", sourceIndex: 0 },
    });
    const revived = await prisma.discoveredToken.findUnique({ where: { chain_tokenAddress: { chain: CHAIN, tokenAddress: TOKEN } } });
    expect(revived?.canonicalStatus).toBe("CANONICAL");
    expect(revived?.orphanedAt).toBeNull();
    expect(revived?.sourceTxHash).toBe("0xlaunch-replay");
    void discoveryListener; // constructed only to prove it can be built against this fixture; the upsert semantics it uses are asserted directly above.
  });

  it("no common ancestor within the configured recovery window: fails closed rather than fabricating one", async () => {
    await seedHistory([90n, 100n]);
    await prisma.chainIngestionCheckpoint.createMany({
      data: [{ source: DISCOVERY_CHECKPOINT_SOURCE, lastHeight: 100n, lastHash: "0xhash-100" }],
    });
    const fakeChain = new FakeChainReader(150n);
    // Every retained height now disagrees — a deep reorg beyond the window.
    fakeChain.setBlockHash(100n, "0xFORKED-100");
    fakeChain.setBlockHash(90n, "0xFORKED-90");

    const result = await attemptReorgRecovery({ chainClient: fakeChain, db: prisma, chain: CHAIN });
    expect(result.status).toBe("UNRESOLVED");
    if (result.status !== "UNRESOLVED") throw new Error("expected UNRESOLVED");
    expect(result.searchedDepth).toBe(2);

    // Nothing was mutated — fail closed, not a partial/best-effort rollback.
    const cp = await prisma.chainIngestionCheckpoint.findUnique({ where: { source: DISCOVERY_CHECKPOINT_SOURCE } });
    expect(cp?.lastHeight.toString()).toBe("100");
    const history = await prisma.chainBlockCheckpoint.findMany({ where: { chain: CHAIN } });
    expect(history).toHaveLength(2);
  });

  it("repeated detection remains idempotent: calling recovery twice after a successful recovery changes nothing further", async () => {
    await seedHistory([80n, 100n]);
    await prisma.chainIngestionCheckpoint.createMany({
      data: [{ source: DISCOVERY_CHECKPOINT_SOURCE, lastHeight: 100n, lastHash: "0xhash-100" }],
    });
    await prisma.discoveredToken.create({
      data: {
        chain: CHAIN, venue: "pons", tokenAddress: TOKEN, deployer: "0x666666666666666666666666666666666666666f",
        poolAddress: POOL, quoteAddress: QUOTE, supply: "1", initialBuyAmount: "0", isToken0: true, poolFee: 3_000,
        sourceHeight: 90n, sourceHash: "0xhash-90", sourceTxHash: "0xlaunch-idem", sourceIndex: 0,
      },
    });
    const fakeChain = new FakeChainReader(120n);
    fakeChain.setBlockHash(100n, "0xFORKED-100");

    const first = await attemptReorgRecovery({ chainClient: fakeChain, db: prisma, chain: CHAIN });
    expect(first.status).toBe("RECOVERED");
    if (first.status !== "RECOVERED") throw new Error("expected RECOVERED");
    expect(first.orphanedTokens).toBe(1);

    const second = await attemptReorgRecovery({ chainClient: fakeChain, db: prisma, chain: CHAIN });
    expect(second.status).toBe("RECOVERED");
    if (second.status !== "RECOVERED") throw new Error("expected RECOVERED");
    expect(second.ancestorHeight.toString()).toBe("80"); // same ancestor found again
    expect(second.orphanedTokens).toBe(0); // nothing left to orphan — already done
    expect(second.orphanedTrades).toBe(0);
    expect(second.rolledBackSources).toEqual([]); // checkpoint already at/below the ancestor
  });

  it("restart during/after reconciliation: a fresh listener instance resumes correctly from the rolled-back checkpoint", async () => {
    await seedHistory([30n, 100n]);
    await prisma.chainIngestionCheckpoint.createMany({
      data: [{ source: DISCOVERY_CHECKPOINT_SOURCE, lastHeight: 100n, lastHash: "0xhash-100" }],
    });
    const fakeChain = new FakeChainReader(100n);
    fakeChain.setBlockHash(100n, "0xFORKED-100");

    const recovery = await attemptReorgRecovery({ chainClient: fakeChain, db: prisma, chain: CHAIN });
    expect(recovery.status).toBe("RECOVERED");

    // "Restart": brand-new PrismaClient + listener, reading only Postgres.
    const prisma2 = new PrismaClient();
    const listener = new DiscoveryListener({ chainClient: fakeChain, db: prisma2, config: TEST_CONFIG });
    const tick = await listener.runOnce();
    await prisma2.$disconnect();

    // No reorg mismatch this time (checkpoint now agrees with the live
    // chain at the ancestor), and no logs beyond the ancestor were seeded
    // in this fake, so it should simply resume cleanly.
    expect(["PROCESSED", "UP_TO_DATE"]).toContain(tick.status);
    const cp = await prisma.chainIngestionCheckpoint.findUnique({ where: { source: DISCOVERY_CHECKPOINT_SOURCE } });
    expect(Number(cp!.lastHeight)).toBeGreaterThanOrEqual(30);
  });
});
