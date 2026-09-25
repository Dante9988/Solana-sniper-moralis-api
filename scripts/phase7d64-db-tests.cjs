// All destructive test fixtures are confined to a separate, fixed test database.
require('dotenv').config({ quiet: true });
const { Client } = require('pg');
const { spawnSync } = require('node:child_process');
(async () => {
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = '/postgres';
  const admin = new Client({ connectionString: url.toString() });
  await admin.connect();
  if (!(await admin.query("SELECT 1 FROM pg_database WHERE datname='phase7d64_test'")).rowCount) {
    await admin.query('CREATE DATABASE phase7d64_test');
  }
  await admin.end();
  url.pathname = '/phase7d64_test';
  const env = { ...process.env, DATABASE_URL: url.toString(), CANDLES_RUN_DB_TESTS: 'true', PONS_RUN_DB_TESTS: 'true' };
  for (const args of [['prisma', 'migrate', 'deploy'], ['vitest', 'run', 'src/candles', 'src/pons/__tests__/tokenTradeBackfill.dbIntegration.test.ts', 'src/researchApi/__tests__/robinhoodTokens.dbIntegration.test.ts', 'src/researchApi/__tests__/robinhoodCandles.dbIntegration.test.ts', '--no-file-parallelism', '--reporter=dot']]) {
    const result = spawnSync('npx', args, { env, stdio: 'inherit' });
    if (result.status !== 0) { process.exitCode = result.status || 1; break; }
  }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
