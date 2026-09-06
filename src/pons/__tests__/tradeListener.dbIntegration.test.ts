/**
 * Real-Postgres integration test for the Phase 7B.4 trade listener. Same
 * opt-in convention and fake-chain-real-Postgres split as
 * discoveryListener.dbIntegration.test.ts.
 *
 * Run in isolation from other *.dbIntegration.test.ts files (or with
 * vitest's fileParallelism disabled) — this file and its sibling share the
 * same real fixture's token/pool address as their test identity, so running
 * both concurrently against the same Postgres races on that shared row.
 *
 * Run:
 *   PONS_RUN_DB_TESTS=true DATABASE_URL=postgresql://... npx vitest run src/pons/__tests__/tradeListener.dbIntegration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import fs from "fs";
import path from "path";
import { TradeListener, TRADE_CHECKPOINT_SOURCE } from "../tradeListener";
import { ChainClientResult, ChainReader, RawBlockRef } from "../chainClient";
import { RawEvmLog } from "../ponsAdapter";
import { RobinhoodChainConfig } from "../config";

const RUN_DB_TESTS = process.env.PONS_RUN_DB_TESTS === "true";

const FIXTURES_DIR = path.join(__dirname, "fixtures");
const CHAIN = "robinhood";
const TEST_TOKEN_ADDRESS = "0x055650555be80649397084cd3f8a09b4350e8612";
const TEST_POOL_ADDRESS = "0x8f4f723f10fc7bad28742d25c91158c728557c4c";
const TEST_QUOTE_ADDRESS = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";

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
  quoteAddress: TEST_QUOTE_ADDRESS,
  pollIntervalMs: 5_000,
  graduationPollIntervalMs: 60_000,
  maxBlockRangePerPoll: 2_000,
  confirmationLagBlocks: 0,
  freshStartLookbackBlocks: 100,
});

class FakeChainReader implements ChainReader {
  latest: bigint;
  blockHashOverrides = new Map<bigint, string>();
  logsByRange: RawEvmLog[] = [];

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
    throw new Error("not used by TradeListener");
  }
}

describe.skipIf(!RUN_DB_TESTS)("TradeListener — real Postgres integration", () => {
  const prisma = new PrismaClient();

  async function seedTrackedToken() {
    await prisma.discoveredToken.upsert({
      where: { chain_tokenAddress: { chain: CHAIN, tokenAddress: TEST_TOKEN_ADDRESS } },
      create: {
        chain: CHAIN,
        venue: "pons",
        tokenAddress: TEST_TOKEN_ADDRESS,
        deployer: "0xb6e60e418e198aad0360be847863e0477420239a",
        poolAddress: TEST_POOL_ADDRESS,
        quoteAddress: TEST_QUOTE_ADDRESS,
        supply: "1000000000000000000000000000",
        initialBuyAmount: "10000000000000000",
        isToken0: true,
        poolFee: 10_000,
        sourceHeight: 9_019_252n,
        sourceHash: "0xhash-9019252",
        sourceTxHash: "0x92476c6f12444023711b221057dcffab166f673027479008f959ca37f5f21eb7",
        sourceIndex: 15,
      },
      update: {},
    });
  }

  async function cleanup() {
    await prisma.chainTrade.deleteMany({ where: { chain: CHAIN, tokenAddress: TEST_TOKEN_ADDRESS } });
    await prisma.discoveredToken.deleteMany({ where: { chain: CHAIN, tokenAddress: TEST_TOKEN_ADDRESS } });
    await prisma.chainIngestionCheckpoint.deleteMany({ where: { source: TRADE_CHECKPOINT_SOURCE } });
  }

  beforeAll(cleanup);
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });
  beforeEach(cleanup);

  it("returns NO_POOLS_TRACKED when no token has been discovered yet", async () => {
    const fakeChain = new FakeChainReader(9_019_252n);
    const listener = new TradeListener({ chainClient: fakeChain, db: prisma, config: TEST_CONFIG });
    const result = await listener.runOnce();
    expect(result.status).toBe("NO_POOLS_TRACKED");
  });

  it("persists a real trade against a tracked pool and sets the checkpoint", async () => {
    await seedTrackedToken();
    const fixture = loadRawLog("swap_9019252.json");
    const fakeChain = new FakeChainReader(9_019_252n);
    fakeChain.logsByRange = [fixture];

    const listener = new TradeListener({ chainClient: fakeChain, db: prisma, config: TEST_CONFIG });
    const result = await listener.runOnce();

    expect(result.status).toBe("PROCESSED");
    if (result.status !== "PROCESSED") throw new Error("expected PROCESSED");
    expect(result.tradesRecorded).toBe(1);

    const row = await prisma.chainTrade.findFirst({ where: { chain: CHAIN, tokenAddress: TEST_TOKEN_ADDRESS } });
    expect(row).not.toBeNull();
    expect(row?.side).toBe("buy");
    expect(row?.tokenAmount.toFixed()).toBe("7249784874772468972176245");
    expect(row?.quoteAmount.toFixed()).toBe("10000000000000000");

    const checkpoint = await prisma.chainIngestionCheckpoint.findUnique({ where: { source: TRADE_CHECKPOINT_SOURCE } });
    expect(checkpoint?.lastHeight.toString()).toBe(result.toBlock.toString());
  });

  it("is idempotent across a simulated restart — no duplicate trade row", async () => {
    await seedTrackedToken();
    const fixture = loadRawLog("swap_9019252.json");
    const fakeChain = new FakeChainReader(9_019_252n);
    fakeChain.logsByRange = [fixture];

    const listener1 = new TradeListener({ chainClient: fakeChain, db: prisma, config: TEST_CONFIG });
    const first = await listener1.runOnce();
    expect(first.status).toBe("PROCESSED");

    const prisma2 = new PrismaClient();
    const listener2 = new TradeListener({ chainClient: fakeChain, db: prisma2, config: TEST_CONFIG });
    const second = await listener2.runOnce();
    await prisma2.$disconnect();
    expect(second.status).toBe("UP_TO_DATE");

    const count = await prisma.chainTrade.count({ where: { chain: CHAIN, tokenAddress: TEST_TOKEN_ADDRESS } });
    expect(count).toBe(1);
  });
});
