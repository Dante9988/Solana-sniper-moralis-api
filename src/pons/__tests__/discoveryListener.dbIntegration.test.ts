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
import { ChainClientResult, ChainReader, RawBlockRef } from "../chainClient";
import { RawEvmLog } from "../ponsAdapter";
import { RobinhoodChainConfig } from "../config";

const RUN_DB_TESTS = process.env.PONS_RUN_DB_TESTS === "true";

const FIXTURES_DIR = path.join(__dirname, "fixtures");
const CHAIN = "robinhood";
const TEST_TOKEN_ADDRESS = "0x055650555be80649397084cd3f8a09b4350e8612";

function loadRawLog(name: string): RawEvmLog {
  const raw = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8"));
  return { ...raw, blockNumber: BigInt(raw.blockNumber) };
}

const TEST_CONFIG: RobinhoodChainConfig = Object.freeze({
  chainId: 4663,
  rpcHttpUrl: "http://unused-in-this-test.invalid",
  rpcWsUrl: "wss://unused-in-this-test.invalid",
  explorerUrl: "https://unused-in-this-test.invalid",
  factoryAddress: "0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB",
  lockerAddress: "0x736D76699C26D0d966744cAe304C000d471f7F35",
  factoryLegacyAddress: "0x0c37a24F5D23A486FA692d1500881d698B1F77a4",
  lockerLegacyAddress: "0x31ca5E101941A93A7DD6d0497928700625CF54B5",
  quoteAddress: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  pollIntervalMs: 5_000,
  graduationPollIntervalMs: 60_000,
  maxBlockRangePerPoll: 2_000,
  confirmationLagBlocks: 0,
  freshStartLookbackBlocks: 100,
});

/** A canned, in-memory chain — deterministic block hashes by height (computed on demand, not precomputed for every height), and a fixed set of logs/enrichment, so this test never touches the network. */
class FakeChainReader implements ChainReader {
  latest: bigint;
  /** height -> hash override, used only to simulate a reorg at a specific height the test cares about; every other height hashes deterministically on demand. */
  blockHashOverrides = new Map<bigint, string>();
  logsByRange: RawEvmLog[] = [];
  enrichment = { supply: 1_000_000_000_000_000_000_000_000_000n, isToken0: true, poolFee: 10_000 };

  constructor(latest: bigint) {
    this.latest = latest;
  }

  async getBlockNumber(): Promise<ChainClientResult<bigint>> {
    return { status: "AVAILABLE", data: this.latest, source: "fake", fetchedAt: new Date() };
  }

  async getBlockRef(blockNumber: bigint): Promise<ChainClientResult<RawBlockRef>> {
    const hash = this.blockHashOverrides.get(blockNumber) ?? `0xhash-${blockNumber.toString()}`;
    return { status: "AVAILABLE", data: { number: blockNumber, hash }, source: "fake", fetchedAt: new Date() };
  }

  async getLogs(params: { fromBlock: bigint; toBlock: bigint }): Promise<ChainClientResult<RawEvmLog[]>> {
    const inRange = this.logsByRange.filter((l) => l.blockNumber >= params.fromBlock && l.blockNumber <= params.toBlock);
    return { status: "AVAILABLE", data: inRange, source: "fake", fetchedAt: new Date() };
  }

  async readContract<T>(): Promise<ChainClientResult<T>> {
    return { status: "AVAILABLE", data: this.enrichment as unknown as T, source: "fake", fetchedAt: new Date() };
  }
}

describe.skipIf(!RUN_DB_TESTS)("DiscoveryListener — real Postgres integration", () => {
  const prisma = new PrismaClient();

  beforeAll(async () => {
    await prisma.discoveredToken.deleteMany({ where: { chain: CHAIN, tokenAddress: TEST_TOKEN_ADDRESS } });
    await prisma.chainIngestionCheckpoint.deleteMany({ where: { source: DISCOVERY_CHECKPOINT_SOURCE } });
  });

  afterAll(async () => {
    await prisma.discoveredToken.deleteMany({ where: { chain: CHAIN, tokenAddress: TEST_TOKEN_ADDRESS } });
    await prisma.chainIngestionCheckpoint.deleteMany({ where: { source: DISCOVERY_CHECKPOINT_SOURCE } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.discoveredToken.deleteMany({ where: { chain: CHAIN, tokenAddress: TEST_TOKEN_ADDRESS } });
    await prisma.chainIngestionCheckpoint.deleteMany({ where: { source: DISCOVERY_CHECKPOINT_SOURCE } });
  });

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
    expect(row?.supply.toFixed()).toBe("1000000000000000000000000000");

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

  it("detects a reorg at the checkpoint height and halts rather than silently continuing", async () => {
    const fixture = loadRawLog("token_launched_9019252.json");
    const fakeChain = new FakeChainReader(9_019_252n);
    fakeChain.logsByRange = [fixture];

    const listener = new DiscoveryListener({ chainClient: fakeChain, db: prisma, config: TEST_CONFIG });
    const first = await listener.runOnce();
    expect(first.status).toBe("PROCESSED");
    if (first.status !== "PROCESSED") throw new Error("expected PROCESSED");

    // Simulate a reorg: the chain now reports a different hash at the
    // height we already checkpointed.
    fakeChain.blockHashOverrides.set(first.toBlock, "0xREORGED-HASH");
    fakeChain.latest = first.toBlock + 10n;

    const second = await listener.runOnce();
    expect(second.status).toBe("REORG_DETECTED");

    // Checkpoint must not have advanced past the reorged height.
    const checkpoint = await prisma.chainIngestionCheckpoint.findUnique({ where: { source: DISCOVERY_CHECKPOINT_SOURCE } });
    expect(checkpoint?.lastHeight.toString()).toBe(first.toBlock.toString());
  });
});
