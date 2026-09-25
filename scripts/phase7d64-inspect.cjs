// Read-only local evidence; never prints connection strings or provider credentials.
process.env.TZ = 'UTC';
require('dotenv').config({ quiet: true });
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
const token = (process.env.TOKEN || '0xb41c7ac9d46a980f8bdf1894b392a2a07ec9992a').toLowerCase();
(async () => {
  const report = {
    at: new Date().toISOString(), token,
    identity: await db.discoveredToken.findMany({ where: { chain: 'robinhood', tokenAddress: token }, select: { tokenAddress: true, symbol: true, sourceHeight: true, graduationSourceHeight: true, graduated: true, tokenDecimals: true, quoteDecimals: true } }),
    trades: await db.$queryRaw`SELECT venue, count(*), min("sourceHeight")::text AS first_block, max("sourceHeight")::text AS last_block, min("sourceTimestamp"), max("sourceTimestamp") FROM "ChainTrade" WHERE "tokenAddress"=${token} AND "canonicalStatus"='CANONICAL' GROUP BY venue`,
    candles: await db.$queryRaw`SELECT resolution,count(*),min("bucketStart") AS earliest,max("bucketStart") AS latest,max(revision) AS max_revision FROM "MarketCandle" WHERE "tokenAddress"=${token} GROUP BY resolution`,
    backfill: await db.tokenTradeBackfill.findMany({ where: { tokenAddress: token } }),
    venueRanges: await db.$queryRaw`SELECT ("poolId" IS NOT NULL) AS graduated, count(*),min("sourceHeight")::text AS first_block, max("sourceHeight")::text AS last_block,min("sourceTimestamp") AS earliest,max("sourceTimestamp") AS latest FROM "ChainTrade" WHERE "tokenAddress"=${token} AND "canonicalStatus"='CANONICAL' GROUP BY ("poolId" IS NOT NULL)`,
    priceSamples: await db.$queryRaw`(SELECT 'last_curve' AS sample, "sourceTxHash", "sourceIndex", "sourceHeight"::text, "sourceTimestamp", side, "tokenAmount"::text, "quoteAmount"::text,"priceQuote"::text FROM "ChainTrade" WHERE "tokenAddress"=${token} AND "canonicalStatus"='CANONICAL' AND "poolId" IS NULL ORDER BY "sourceHeight" DESC, "sourceIndex" DESC LIMIT 1) UNION ALL (SELECT 'first_v4', "sourceTxHash", "sourceIndex", "sourceHeight"::text, "sourceTimestamp", side,"tokenAmount"::text,"quoteAmount"::text,"priceQuote"::text FROM "ChainTrade" WHERE "tokenAddress"=${token} AND "canonicalStatus"='CANONICAL' AND "poolId" IS NOT NULL ORDER BY "sourceHeight", "sourceIndex" LIMIT 1) UNION ALL (SELECT 'latest', "sourceTxHash", "sourceIndex", "sourceHeight"::text, "sourceTimestamp", side,"tokenAmount"::text,"quoteAmount"::text,"priceQuote"::text FROM "ChainTrade" WHERE "tokenAddress"=${token} AND "canonicalStatus"='CANONICAL' ORDER BY "sourceHeight" DESC,"sourceIndex" DESC LIMIT 1)`,
    checkpoint: await db.candleAggregationCheckpoint.findMany({ where: { tokenAddress: token } }),
    v4Normalization: await db.$queryRaw`SELECT "normalizationVersion", count(*) FROM "ChainTrade" WHERE chain='robinhood' AND venue='pons_v2' AND "poolId" IS NOT NULL GROUP BY "normalizationVersion"`,
    recentLatency: await db.$queryRaw`SELECT count(*) AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM ("observedAt"-"sourceTimestamp"))*1000) AS p50_ms, percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM ("observedAt"-"sourceTimestamp"))*1000) AS p95_ms, max(extract(epoch FROM ("observedAt"-"sourceTimestamp"))*1000) AS max_ms FROM "ChainTrade" WHERE "tokenAddress"=${token} AND "canonicalStatus"='CANONICAL' AND "sourceTimestamp">NOW()-interval '5 minutes'`,
  };
  if (process.env.RAW_RECEIPTS === 'true') {
    require('ts-node/register');
    const { createPublicClient, http } = require('viem');
    const { resolveHttpEndpoints } = require('../src/pons/rpcEndpoints');
    const rpc = createPublicClient({ transport: http(resolveHttpEndpoints(process.env)[0].url) });
    report.rawReceipts = [];
    for (const sample of report.priceSamples) report.rawReceipts.push(await rpc.getTransactionReceipt({ hash: sample.sourceTxHash }));
  }
  report.marketCoverage = await fetch(`http://localhost:8787/api/v1/tokens/robinhood/${token}/market`).then(r=>r.json()).then(r=>r.market?.coverage ?? r.coverage);
  require('node:fs').writeFileSync('/root/only-pump-me/docs/phase-7d6/evidence/7d6.4/rbd-history-final.json',JSON.stringify(report, (_,v)=>typeof v==='bigint'?v.toString():v,2));
  console.log(JSON.stringify(report, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2));
})().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => db.$disconnect());
