import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Regression coverage for phase7B.txt (Phase 7A.1): the historical
 * `20250324020906_init` baseline migration and `migration_lock.toml` were
 * restored byte-for-byte from `origin/main` after being found missing from
 * `master`'s migration chain (see ARCHITECTURE.md §3/§5.6). Without it,
 * `prisma migrate deploy` against a genuinely fresh database fails: nothing
 * in the chain ever creates the `Wallet`/`UserConfig`/`PumpFunToken`/
 * `TokenAlert`/`WalletTransaction`/`WalletBalance` tables that every later
 * migration (and the Phase 7A `wallet_pk_optional` migration specifically)
 * assumes already exist.
 */

const INIT_MIGRATION_PATH = 'prisma/migrations/20250324020906_init/migration.sql';
const LOCK_FILE_PATH = 'prisma/migrations/migration_lock.toml';

// Captured from `origin/main`'s blob at the time this was restored (verified
// byte-for-byte via `git diff --no-index` and `git hash-object` against the
// origin/main blob during Phase 7A.1 — see the commit message for the exact
// git blob SHAs). A change to either hash means the historical migration
// file was edited, which must never happen to an already-applied migration.
const EXPECTED_INIT_SHA256 = 'c59422e979f6d4c74110398990a6740aadc463c0d82036c90913ccced9575af1';
const EXPECTED_LOCK_SHA256 = '0b31557132059fe8acfa113635faaf57221a983fcc90ef2221bc35ca5308fa70';

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('the historical init migration chain is present and unmodified (phase7B.txt)', () => {
  it('20250324020906_init/migration.sql exists', () => {
    expect(existsSync(INIT_MIGRATION_PATH)).toBe(true);
  });

  it('migration_lock.toml exists', () => {
    expect(existsSync(LOCK_FILE_PATH)).toBe(true);
  });

  it('the init migration content matches the historical blob restored from origin/main byte-for-byte', () => {
    expect(sha256(INIT_MIGRATION_PATH)).toBe(EXPECTED_INIT_SHA256);
  });

  it('migration_lock.toml matches the historical blob restored from origin/main byte-for-byte', () => {
    expect(sha256(LOCK_FILE_PATH)).toBe(EXPECTED_LOCK_SHA256);
  });

  it('the init migration creates the base tables every later migration depends on', () => {
    const sql = readFileSync(INIT_MIGRATION_PATH, 'utf8');
    for (const table of ['Wallet', 'UserConfig', 'PumpFunToken', 'TokenAlert', 'WalletTransaction', 'WalletBalance']) {
      expect(sql, table).toMatch(new RegExp(`CREATE TABLE "${table}"`));
    }
  });

  it('20250324020906_init sorts before every other migration (Prisma applies migrations in folder-name order)', () => {
    const migrationDirs = readdirSync('prisma/migrations', { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(migrationDirs[0]).toBe('20250324020906_init');
    expect(migrationDirs.length).toBeGreaterThan(1);
  });

  it('the Phase 7A wallet_pk_optional migration (which ALTERs a column init creates) exists and runs after init', () => {
    const migrationDirs = readdirSync('prisma/migrations', { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const initIndex = migrationDirs.indexOf('20250324020906_init');
    const walletPkIndex = migrationDirs.indexOf('20260827010000_wallet_pk_optional');
    expect(walletPkIndex).toBeGreaterThan(initIndex);

    const initSql = readFileSync(INIT_MIGRATION_PATH, 'utf8');
    expect(initSql).toMatch(/"walletPk" TEXT NOT NULL/);
    const walletPkSql = readFileSync('prisma/migrations/20260827010000_wallet_pk_optional/migration.sql', 'utf8');
    expect(walletPkSql).toMatch(/DROP NOT NULL/);
  });
});

describe('the UserPreference table has a migration matching schema.prisma (phase7b1.txt §3)', () => {
  const USER_PREF_MIGRATION_PATH = 'prisma/migrations/20260828071721_add_user_preference/migration.sql';

  it('the migration file exists and creates the table schema.prisma declares', () => {
    expect(existsSync(USER_PREF_MIGRATION_PATH)).toBe(true);
    const sql = readFileSync(USER_PREF_MIGRATION_PATH, 'utf8');
    expect(sql).toMatch(/CREATE TABLE "UserPreference"/);
    expect(sql).toMatch(/"userId" TEXT NOT NULL/);
    expect(sql).toMatch(/"pumpSwapEnabled" BOOLEAN NOT NULL DEFAULT true/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX "UserPreference_userId_key"/);
  });

  it('is purely additive (no ALTER/DROP of any other table)', () => {
    const sql = readFileSync(USER_PREF_MIGRATION_PATH, 'utf8');
    expect(sql).not.toMatch(/ALTER TABLE/);
    expect(sql).not.toMatch(/DROP TABLE/);
    expect(sql).not.toMatch(/DROP COLUMN/);
  });

  it('sorts after init and the wallet_pk_optional migration (later phases may add more migrations after this one)', () => {
    const migrationDirs = readdirSync('prisma/migrations', { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const userPrefIndex = migrationDirs.indexOf('20260828071721_add_user_preference');
    expect(userPrefIndex).toBeGreaterThan(migrationDirs.indexOf('20250324020906_init'));
    expect(userPrefIndex).toBeGreaterThan(migrationDirs.indexOf('20260827010000_wallet_pk_optional'));
  });
});

describe('wallet-verification and scan-ownership migration matches schema.prisma (phase7b2.txt §2/§3)', () => {
  const MIGRATION_PATH = 'prisma/migrations/20260828082913_add_wallet_verification_and_scan_ownership/migration.sql';

  it('the migration file exists and creates all three new tables', () => {
    expect(existsSync(MIGRATION_PATH)).toBe(true);
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    expect(sql).toMatch(/CREATE TABLE "WalletChallenge"/);
    expect(sql).toMatch(/CREATE TABLE "VerifiedWallet"/);
    expect(sql).toMatch(/CREATE TABLE "UserScanRequest"/);
  });

  it('WalletChallenge stores a challengeHash, never a raw reusable challenge id column', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    expect(sql).toMatch(/"challengeHash" TEXT NOT NULL/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX "WalletChallenge_challengeHash_key"/);
    expect(sql).not.toMatch(/"challengeId"/);
  });

  it('VerifiedWallet enforces one verified owner per (network, address) — prevents cross-account claims at the DB level too', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    expect(sql).toMatch(/CREATE UNIQUE INDEX "VerifiedWallet_network_address_key" ON "VerifiedWallet"\("network", "address"\)/);
  });

  it('VerifiedWallet has no secret-key-shaped column of any kind', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    const verifiedWalletBlock = sql.slice(sql.indexOf('CREATE TABLE "VerifiedWallet"'), sql.indexOf('CREATE TABLE "UserScanRequest"'));
    expect(verifiedWalletBlock).not.toMatch(/privateKey|secretKey|walletPk|seedPhrase|mnemonic/i);
  });

  it('UserScanRequest is unique per (userId, jobKey) — idempotent re-requests, not duplicate rows', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    expect(sql).toMatch(/CREATE UNIQUE INDEX "UserScanRequest_userId_jobKey_key" ON "UserScanRequest"\("userId", "jobKey"\)/);
  });

  it('is purely additive (no ALTER/DROP of any other table)', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    expect(sql).not.toMatch(/ALTER TABLE/);
    expect(sql).not.toMatch(/DROP TABLE/);
    expect(sql).not.toMatch(/DROP COLUMN/);
  });

  it('sorts after the UserPreference migration', () => {
    const migrationDirs = readdirSync('prisma/migrations', { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(migrationDirs.indexOf('20260828082913_add_wallet_verification_and_scan_ownership')).toBeGreaterThan(
      migrationDirs.indexOf('20260828071721_add_user_preference')
    );
  });
});

describe('pumpSwapEnabled is a notification preference only — never an execution gate (phase7b1.txt §3)', () => {
  // Despite the name, this flag must never be read by anything that builds,
  // signs, or submits a trade. It is read in exactly two places today:
  // src/telegram/commands/togglePumpSwap.ts (the toggle command itself) and
  // src/telegram/alerts.ts (deciding whether to DM a Pump.fun alert). If a
  // future change makes a trading/execution surface read this field, that
  // would silently reintroduce the "PumpSwap is enabled by default" implication
  // phase7b1.txt explicitly warned against — so this is pinned as a regression.
  const EXECUTION_SURFACE_FILES = [
    'src/services/jupiterService.ts',
    'src/services/pumpswapService.ts',
    'src/services/solanaPayService.ts',
    'src/api/index.ts',
  ];

  it('no execution-surface file reads pumpSwapEnabled', () => {
    for (const file of EXECUTION_SURFACE_FILES) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/pumpSwapEnabled/);
    }
  });
});

describe('CI runs a real PostgreSQL migration deployment, not a placeholder (phase7B.txt)', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');

  it('declares a postgres service container', () => {
    expect(workflow).toMatch(/services:\s*\n\s*postgres:/);
    expect(workflow).toMatch(/image:\s*postgres:16/);
  });

  it('waits for PostgreSQL readiness before migrating', () => {
    expect(workflow).toMatch(/pg_isready/);
  });

  it('runs prisma validate and prisma migrate deploy against the service container, not a placeholder string', () => {
    expect(workflow).toMatch(/prisma validate/);
    expect(workflow).toMatch(/prisma migrate deploy/);
    expect(workflow).not.toMatch(/ci_placeholder/);
  });

  it('runs type-check, tests, and build after the migration step', () => {
    const migrateIdx = workflow.indexOf('prisma migrate deploy');
    const tscIdx = workflow.indexOf('tsc --noEmit');
    const vitestIdx = workflow.indexOf('vitest run');
    const buildIdx = workflow.indexOf('npm run build');
    expect(migrateIdx).toBeGreaterThan(-1);
    expect(tscIdx).toBeGreaterThan(migrateIdx);
    expect(vitestIdx).toBeGreaterThan(migrateIdx);
    expect(buildIdx).toBeGreaterThan(migrateIdx);
  });
});
