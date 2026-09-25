import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";
import { backfillTokenTrades } from "../backfill/tokenTradeBackfill";
import { TEST_CONFIG } from "./testSupport";

const enabled = process.env.PONS_RUN_DB_TESTS === "true";
// The fixture uses a real token address; never run its cleanup against the live database.
const isolated = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/none").pathname === "/phase7d64_test";
describe.skipIf(!enabled || !isolated)("real receipt backfill replay — isolated Postgres", () => {
  const db = new PrismaClient();
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname,"fixtures/rbd_v4_buy_64164797.json"),"utf8"));
  const token = fixture.token;
  const raw = fixture.receipt.logs[0];
  const log = { ...raw, blockNumber:BigInt(raw.blockNumber), blockTimestamp:BigInt(raw.blockTimestamp) };
  const height = log.blockNumber;
  const available = (data: unknown) => ({status:"AVAILABLE",data,source:"recorded canonical receipt",fetchedAt:new Date(),attempts:1});
  const deps = {db,config:TEST_CONFIG,v2FactoryAddress:"0xfactory",chainClient:{
    getBlockNumber: async () => available(height + BigInt(TEST_CONFIG.confirmationLagBlocks)),
    getLogsByEvents: async () => available([]),
    getLogs: async () => available([log]),
    readContract: async () => available(raw.address),
  } as never};
  const cleanup = async () => {
    await db.candleInvalidation.deleteMany({where:{chain:"robinhood",tokenAddress:token}});
    await db.tokenTradeBackfill.deleteMany({where:{chain:"robinhood",tokenAddress:token}});
    await db.chainTrade.deleteMany({where:{chain:"robinhood",tokenAddress:token}});
    await db.discoveredToken.deleteMany({where:{chain:"robinhood",tokenAddress:token}});
  };
  beforeAll(async () => {
    await cleanup();
    await db.discoveredToken.create({data:{chain:"robinhood",venue:"pons_v2",tokenAddress:token,
      deployer:"0x0000000000000000000000000000000000000001",curveAddress:"0x0000000000000000000000000000000000000002",
      quoteAddress:"0x0000000000000000000000000000000000000000",initialBuyAmount:"0",sourceHeight:height,
      sourceHash:raw.blockHash,sourceTxHash:raw.transactionHash,sourceIndex:0,graduated:true,graduationSourceHeight:height,
      poolId:raw.topics[1],isToken0:false}});
  });
  afterAll(async () => {await cleanup();await db.$disconnect();});
  it("persists a canonical BUY once and does no candle rebuild or write on replay", async () => {
    const first = await backfillTokenTrades(deps,token);
    expect(first.status).toBe("COMPLETE");
    expect(first.tradesWritten).toBe(1);
    const trade = await db.chainTrade.findFirstOrThrow({where:{tokenAddress:token}});
    expect(trade.side).toBe("buy");expect(trade.normalizationVersion).toBe(2);
    expect(trade.tokenAmount.toFixed()).toBe(fixture.expectedTokenAmount);
    const versionBefore = await db.$queryRaw<Array<{version: string}>>`SELECT xmin::text AS version FROM "ChainTrade" WHERE id = ${trade.id}`;
    expect(await db.candleInvalidation.count({where:{tokenAddress:token}})).toBe(1);
    // Simulate a retry after the pool checkpoint was lost, while canonical rows remain.
    await db.tokenTradeBackfill.update({where:{chain_tokenAddress:{chain:"robinhood",tokenAddress:token}},data:{poolCursor:null,status:"PARTIAL"}});
    const replay = await backfillTokenTrades(deps,token);
    expect(replay.status).toBe("COMPLETE");expect(replay.tradesWritten).toBe(1);
    expect(await db.chainTrade.count({where:{tokenAddress:token}})).toBe(1);
    expect(await db.candleInvalidation.count({where:{tokenAddress:token}})).toBe(1);
    const versionAfter = await db.$queryRaw<Array<{version: string}>>`SELECT xmin::text AS version FROM "ChainTrade" WHERE id = ${trade.id}`;
    expect(versionAfter).toEqual(versionBefore);
  });
});
