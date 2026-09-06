/**
 * Real-Postgres integration test for the Phase 7B.4 discovery listener:
 * checkpoint persistence, restart recovery (no gap, no duplicates), and
 * reorg detection. Follows the exact opt-in convention established by
 * src/pump/__tests__/pumpTrade.dbIntegration.test.ts.
 *
 * The chain itself is faked here (a canned ChainReader, no network) — this
 * test's job is to prove the Postgres/checkpoint/idempotency machinery, not
 * to re-prove live RPC reachability (that's proven separately against the
 * real testnet endpoint; see the completion report).
 *
 * Run in isolation from other *.dbIntegration.test.ts files (or with
 * vitest's fileParallelism disabled) — this file and its sibling share the
 * same real fixture's token/pool address as their test identity, so running
 * both concurrently against the same Postgres races on that shared row.
 *
 * Run:
 *   PONS_RUN_DB_TESTS=true DATABASE_URL=postgresql://... npx vitest run src/pons/__tests__/discoveryListener.dbIntegration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import fs from "fs";
import path from "path";
import { DiscoveryListener, DISCOVERY_CHECKPOINT_SOURCE } from "../discoveryListener";
import { RawEvmLog } from "../ponsAdapter";
import { TEST_CONFIG, FakeChainReader } from "./testSupport";

const RUN_DB_TESTS = process.env.PONS_RUN_DB_TESTS === "true";

const FIXTURES_DIR = path.join(__dirname, "fixtures");
const CHAIN = "robinhood";
const TEST_TOKEN_ADDRESS = "0x055650555be80649397084cd3f8a09b4350e8612";

function loadRawLog(name: string): RawEvmLog {
  const raw = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8"));
  return { ...raw, blockNumber: BigInt(raw.blockNumber) };
}

describe.skipIf(!RUN_DB_TESTS)("DiscoveryListener — real Postgres integration", () => {
  const prisma = new PrismaClient();

  async function cleanup() {
    await prisma.discoveredToken.deleteMany({ where: { chain: CHAIN, tokenAddress: TEST_TOKEN_ADDRESS } });
    await prisma.chainIngestionCheckpoint.deleteMany({ where: { source: DISCOVERY_CHECKPOINT_SOURCE } });
    await prisma.chainBlockCheckpoint.deleteMany({ where: { chain: CHAIN } });
  }

  beforeAll(cleanup);
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });
  beforeEach(cleanup);

  it("persists a real discovered token and sets the checkpoint on first tick", async () => {
    const fixture = loadRawLog("token_launched_9019252.json");
    const fakeChain = new FakeChainReader(9_019_252n);
    fakeChain.logsByRange = [fixture];

    const listener = new DiscoveryListener({ chainClient: fakeChain, db: prisma, config: TEST_CONFIG });
    const result = await listener.runOnce();

    expect(result.status).toBe("PROCESSED");
    if (result.status !== "PROCESSED") throw new Error("expected PROCESSED");
    expect(result.tokensDiscovered).toBe(1);

    const row = await prisma.discoveredToken.findUnique({ where: { chain_tokenAddress: { chain: CHAIN, tokenAddress: TEST_TOKEN_ADDRESS } } });
    expect(row).not.toBeNull();
    expect(row?.poolAddress?.toLowerCase()).toBe("0x8f4f723f10fc7bad28742d25c91158c728557c4c");
    // Prisma.Decimal#toString() can render large integers in scientific
    // notation (e.g. "1e+27") — .toFixed() is the correct way to get the
    // full decimal-safe digit string back out. This distinction matters
    // everywhere a Decimal crosses back into JSON (the read routes, §4.7).
    expect(row?.supply?.toFixed()).toBe("1000000000000000000000000000");

    const checkpoint = await prisma.chainIngestionCheckpoint.findUnique({ where: { source: DISCOVERY_CHECKPOINT_SOURCE } });
    expect(checkpoint?.lastHeight.toString()).toBe(result.toBlock.toString());
  });

  it("is idempotent across a simulated process restart — no duplicate row, checkpoint resumes without a gap", async () => {
    const fixture = loadRawLog("token_launched_9019252.json");
    const fakeChain = new FakeChainReader(9_019_252n);
    fakeChain.logsByRange = [fixture];

    // "Process 1": discovers and commits.
    const listener1 = new DiscoveryListener({ chainClient: fakeChain, db: prisma, config: TEST_CONFIG });
    const first = await listener1.runOnce();
    expect(first.status).toBe("PROCESSED");

    // "Restart": a brand-new PrismaClient instance and a brand-new listener,
    // exactly like a real process restart — reads the checkpoint fresh from
    // Postgres rather than any in-memory state.
    const prisma2 = new PrismaClient();
    const listener2 = new DiscoveryListener({ chainClient: fakeChain, db: prisma2, config: TEST_CONFIG });
    const second = await listener2.runOnce();
    await prisma2.$disconnect();

    // No new blocks and no new logs since the checkpoint already covers
    // this range — the correct outcome is UP_TO_DATE, not reprocessing.
    expect(second.status).toBe("UP_TO_DATE");

    const count = await prisma.discoveredToken.count({ where: { chain: CHAIN, tokenAddress: TEST_TOKEN_ADDRESS } });
    expect(count).toBe(1); // exactly one row despite two listener instances touching the same range
  });

  it("detects a reorg at the checkpoint height and fails closed when no earlier canonical ancestor is available", async () => {
    const fixture = loadRawLog("token_launched_9019252.json");
    const fakeChain = new FakeChainReader(9_019_252n);
    fakeChain.logsByRange = [fixture];

    const listener = new DiscoveryListener({ chainClient: fakeChain, db: prisma, config: TEST_CONFIG });
    const first = await listener.runOnce();
    expect(first.status).toBe("PROCESSED");
    if (first.status !== "PROCESSED") throw new Error("expected PROCESSED");

    // Simulate a reorg: the chain now reports a different hash at the
    // height we already checkpointed. This listener has only ever
    // committed one checkpoint, so the (height,hash) history has exactly
    // one entry — which now also disagrees with the live chain — leaving
    // no earlier canonical ancestor to roll back to within the retained
    // window. See reorgRecovery.dbIntegration.test.ts for the case where a
    // deeper history lets recovery actually succeed.
    fakeChain.setBlockHash(first.toBlock, "0xREORGED-HASH");
    fakeChain.latest = first.toBlock + 10n;

    const second = await listener.runOnce();
    expect(second.status).toBe("REORG_UNRESOLVED");

    // Checkpoint must not have advanced past the reorged height, and the
    // fail-closed state must be persisted for the source-health projection.
    const checkpoint = await prisma.chainIngestionCheckpoint.findUnique({ where: { source: DISCOVERY_CHECKPOINT_SOURCE } });
    expect(checkpoint?.lastHeight.toString()).toBe(first.toBlock.toString());
    expect(checkpoint?.reorgUnresolvedAt).not.toBeNull();

    // Repeated detection must remain idempotent — calling it again does not
    // throw, double-mark, or otherwise change the outcome.
    const third = await listener.runOnce();
    expect(third.status).toBe("REORG_UNRESOLVED");
    const checkpointAfterRetry = await prisma.chainIngestionCheckpoint.findUnique({ where: { source: DISCOVERY_CHECKPOINT_SOURCE } });
    expect(checkpointAfterRetry?.reorgUnresolvedAt?.getTime()).toBe(checkpoint?.reorgUnresolvedAt?.getTime());
  });
});
