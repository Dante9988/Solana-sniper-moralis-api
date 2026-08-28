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
