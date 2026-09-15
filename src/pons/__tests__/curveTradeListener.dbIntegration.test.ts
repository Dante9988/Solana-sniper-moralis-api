/**
 * Phase 7D.4 §3 — CurveTradeListener against real Postgres and a fake chain serving REAL captured
 * CurveBuy/CurveSell logs (src/pons/__fixtures__/curveTrades.json).
 *
 * Disposable database only (see src/testSupport/disposableDatabaseGuard.ts). Run serially:
 *   PONS_RUN_DB_TESTS=true DATABASE_URL=postgresql://…/ci_x_test npx vitest run --no-file-parallelism src/pons/__tests__/curveTradeListener.dbIntegration.test.ts
 */
import { PrismaClient } from "@prisma/client";
import type { AbiEvent } from "viem";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import fixture from "../__fixtures__/curveTrades.json";
import type { ChainClientResult, EventLogReader } from "../chainClient";
import { CURVE_TRADE_CHECKPOINT_SOURCE, CurveTradeListener } from "../curveTradeListener";
import { DISCOVERY_V2_CHECKPOINT_SOURCE } from "../discoveryV2Listener";
import type { RawEvmLog } from "../ponsAdapter";
import { TRADE_V2_CHECKPOINT_SOURCE } from "../tradeV2Listener";
import { loadFinality } from "../../candles/candleAggregationService";
import { FakeChainReader, TEST_CONFIG } from "./testSupport";

const RUN_DB_TESTS = process.env.PONS_RUN_DB_TESTS === "true";
const CHAIN = "robinhood";

const rows = fixture.rows;
const rawLog = (row: (typeof rows)[number]): RawEvmLog => ({ ...row.log, topics: row.log.topics as `0x${string}`[], data: row.log.data as `0x${string}`, blockNumber: BigInt(row.log.blockNumber) });
const TOKENS = [...new Map(rows.map((r) => [r.token.toLowerCase(), r])).values()];
const FIRST = BigInt(Math.min(...rows.map((r) => Number(r.log.blockNumber))));
const LAST = BigInt(Math.max(...rows.map((r) => Number(r.log.blockNumber))));

/** Serves every stored log in range regardless of address, like a topic-only eth_getLogs. */
class FakeCurveChain extends FakeChainReader implements EventLogReader {
  async getLogsByEvents(params: { events: readonly AbiEvent[]; fromBlock: bigint; toBlock: bigint }): Promise<ChainClientResult<RawEvmLog[]>> {
    return { status: "AVAILABLE", data: this.logsByRange.filter((l) => l.blockNumber >= params.fromBlock && l.blockNumber <= params.toBlock), source: "fake", fetchedAt: new Date(), attempts: 1 };
  }
}

function buildChain(): FakeCurveChain {
  const chain = new FakeCurveChain(LAST + 10n);
  chain.logsByRange = rows.map(rawLog);
  for (const row of rows) chain.setBlockHash(BigInt(row.log.blockNumber), row.log.blockHash);
  return chain;
}

describe.skipIf(!RUN_DB_TESTS)("CurveTradeListener — real Postgres, real curve logs", () => {
  const prisma = new PrismaClient();
  const tokenAddresses = TOKENS.map((r) => r.token.toLowerCase());

  async function cleanup() {
    await prisma.chainTrade.deleteMany({ where: { chain: CHAIN, tokenAddress: { in: tokenAddresses } } });
    await prisma.discoveredToken.deleteMany({ where: { chain: CHAIN, tokenAddress: { in: tokenAddresses } } });
    await prisma.chainIngestionCheckpoint.deleteMany({ where: { source: { in: [CURVE_TRADE_CHECKPOINT_SOURCE, DISCOVERY_V2_CHECKPOINT_SOURCE, TRADE_V2_CHECKPOINT_SOURCE] } } });
    await prisma.chainBlockCheckpoint.deleteMany({ where: { chain: CHAIN } });
  }

  async function seed(discoveryHeight: bigint) {
    for (const row of TOKENS) {
      await prisma.discoveredToken.create({
        data: {
          chain: CHAIN,
          venue: "pons_v2",
          tokenAddress: row.token.toLowerCase(),
          deployer: "0x0000000000000000000000000000000000000001",
          curveAddress: row.emitter,
          quoteAddress: row.pairToken,
          initialBuyAmount: "0",
          sourceHeight: FIRST - 100n,
          sourceHash: `0xhash-${FIRST - 100n}`,
          sourceTxHash: `0x${row.token.slice(2).padEnd(64, "0")}`,
          sourceIndex: 0,
        },
      });
    }
    await prisma.chainIngestionCheckpoint.create({ data: { source: DISCOVERY_V2_CHECKPOINT_SOURCE, lastHeight: discoveryHeight, lastHash: `0xhash-${discoveryHeight}` } });
  }

  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("records every real curve trade with trader-side amounts, block time and a checkpoint", async () => {
    await seed(LAST + 5n);
    const listener = new CurveTradeListener({ chainClient: buildChain(), db: prisma, config: TEST_CONFIG });

    const result = await listener.runOnce();
    expect(result.status).toBe("PROCESSED");

    const stored = await prisma.chainTrade.findMany({ where: { chain: CHAIN, tokenAddress: { in: tokenAddresses } }, orderBy: [{ sourceHeight: "asc" }, { sourceIndex: "asc" }] });
    expect(stored).toHaveLength(rows.length);
    for (const row of rows) {
      const trade = stored.find((t) => t.sourceTxHash === row.log.transactionHash && t.sourceIndex === row.log.logIndex)!;
      expect(trade.side).toBe(row.event === "CurveBuy" ? "buy" : "sell");
      expect(trade.venue).toBe("pons_v2");
      expect(trade.poolAddress).toBe(row.emitter.toLowerCase());
      expect(trade.sourceHash).toBe(row.log.blockHash);
      expect(trade.sourceTimestamp).not.toBeNull();
    }
    const cp = await prisma.chainIngestionCheckpoint.findUnique({ where: { source: CURVE_TRADE_CHECKPOINT_SOURCE } });
    expect(cp?.lastHeightTimestamp).not.toBeNull();
  });

  it("drops a look-alike log from an unregistered contract", async () => {
    await seed(LAST + 5n);
    const chain = buildChain();
    chain.logsByRange.push({ ...rawLog(rows[0]), address: "0x000000000000000000000000000000000000dead", logIndex: 999 });
    const result = await new CurveTradeListener({ chainClient: chain, db: prisma, config: TEST_CONFIG }).runOnce();
    expect(result.status).toBe("PROCESSED");
    if (result.status === "PROCESSED") expect(result.foreignLogsDropped).toBe(1);
    expect(await prisma.chainTrade.count({ where: { chain: CHAIN, sourceIndex: 999 } })).toBe(0);
  });

  it("never scans past the V2 discovery checkpoint", async () => {
    await seed(FIRST - 50n);
    const result = await new CurveTradeListener({ chainClient: buildChain(), db: prisma, config: TEST_CONFIG }).runOnce();
    expect(result.status).toBe("PROCESSED"); // covers FIRST-100 .. FIRST-50 only
    expect(await prisma.chainTrade.count({ where: { chain: CHAIN, tokenAddress: { in: tokenAddresses } } })).toBe(0);
    const again = await new CurveTradeListener({ chainClient: buildChain(), db: prisma, config: TEST_CONFIG }).runOnce();
    expect(again.status).toBe("WAITING_ON_DISCOVERY");
  });

  it("is idempotent when a block range is processed twice", async () => {
    await seed(LAST + 5n);
    const chain = buildChain();
    await new CurveTradeListener({ chainClient: chain, db: prisma, config: TEST_CONFIG }).runOnce();
    await prisma.chainIngestionCheckpoint.delete({ where: { source: CURVE_TRADE_CHECKPOINT_SOURCE } });
    await new CurveTradeListener({ chainClient: chain, db: prisma, config: TEST_CONFIG }).runOnce();
    expect(await prisma.chainTrade.count({ where: { chain: CHAIN, tokenAddress: { in: tokenAddresses } } })).toBe(rows.length);
  });

  it("candle finality for V2 needs both the curve and V4 trade streams, and takes the lagging one", async () => {
    await seed(LAST + 5n);
    await new CurveTradeListener({ chainClient: buildChain(), db: prisma, config: TEST_CONFIG }).runOnce();
    expect((await loadFinality(prisma, CHAIN)).tradeLastHeightTimestamp).toBeNull(); // V4 stream never committed

    const earlier = new Date("2026-01-01T00:00:00Z");
    await prisma.chainIngestionCheckpoint.create({ data: { source: TRADE_V2_CHECKPOINT_SOURCE, lastHeight: 1n, lastHash: "0xhash-1", lastHeightTimestamp: earlier } });
    expect((await loadFinality(prisma, CHAIN)).tradeLastHeightTimestamp?.toISOString()).toBe(earlier.toISOString());
  });
});
