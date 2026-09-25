// Idempotent and resumable. V1 and curve trades are outside this repair's scope.
require('dotenv').config({ quiet: true });
const { Client } = require('pg');
const db = new Client({ connectionString: process.env.DATABASE_URL });
(async () => {
  await db.connect();
  let total = 0;
  for (;;) {
    const r = await db.query(`WITH batch AS (
      SELECT id FROM "ChainTrade" WHERE chain='robinhood' AND venue='pons_v2'
      AND "poolId" IS NOT NULL AND "normalizationVersion"=1
      ORDER BY id LIMIT 5000 FOR UPDATE SKIP LOCKED
    ) UPDATE "ChainTrade" t SET side=CASE WHEN side='buy' THEN 'sell' ELSE 'buy' END,
      "normalizationVersion"=2 FROM batch WHERE t.id=batch.id`);
    total += r.rowCount;
    console.log(JSON.stringify({ batch: r.rowCount, total }));
    if (!r.rowCount) break;
    await new Promise(r => setTimeout(r, 100));
  }
})().catch(e=>{ console.error(e.message); process.exitCode=1; }).finally(()=>db.end());
