/**
 * Vitest global setup: refuse to run database-integration suites against a database that is
 * not clearly disposable.
 *
 * Why this exists: the *.dbIntegration suites are written for CI's empty, throwaway Postgres.
 * Several of them delete chain-wide checkpoints and run reorg recovery against a fake chain,
 * which orphans every real fact above a tiny ancestor height. On 2026-09-14 they were run
 * against the local development database and marked 11,977 real Pons V2 launches ORPHANED,
 * wiping their graduation data. Nothing stopped it, because the only gate was an opt-in flag.
 *
 * The rule: if any *_RUN_DB_TESTS flag is on, the database name in DATABASE_URL must look
 * disposable (contains "test", "ci" or "tmp" as a word), unless ALLOW_DB_TESTS_ON_NAMED_DATABASE
 * names that exact database — a deliberate, per-database acknowledgement, not a blanket switch.
 */

const DB_TEST_FLAGS = [
  "RUN_DB_TESTS",
  "PONS_RUN_DB_TESTS",
  "PUMP_RUN_DB_TESTS",
  "FORENSICS_RUN_DB_TESTS",
  "WALLET_RUN_DB_TESTS",
  "CANDLES_RUN_DB_TESTS",
  "PAPER_RUN_DB_TESTS",
] as const;

export function databaseNameOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, "")) || null;
  } catch {
    return null;
  }
}

export function looksDisposable(name: string): boolean {
  return /(^|[_\-.])(test|tests|ci|tmp|temp)([_\-.]|$)/i.test(name);
}

export function checkDisposableDatabase(env: NodeJS.ProcessEnv): { ok: true } | { ok: false; message: string } {
  const enabled = DB_TEST_FLAGS.filter((flag) => env[flag] === "true");
  if (enabled.length === 0) return { ok: true };

  const name = databaseNameOf(env.DATABASE_URL);
  if (!name) {
    return { ok: false, message: `${enabled.join(", ")} set but DATABASE_URL has no database name — refusing to run DB integration suites.` };
  }
  if (looksDisposable(name) || env.ALLOW_DB_TESTS_ON_NAMED_DATABASE === name) return { ok: true };

  return {
    ok: false,
    message:
      `Refusing to run DB integration suites (${enabled.join(", ")}) against database "${name}". ` +
      `These suites delete checkpoints and orphan chain facts. Point DATABASE_URL at a throwaway ` +
      `database whose name contains test/ci/tmp (e.g. create one and run prisma migrate deploy), or set ` +
      `ALLOW_DB_TESTS_ON_NAMED_DATABASE=${name} if that database really is disposable.`,
  };
}

export default function setup(): void {
  // Prisma falls back to .env for DATABASE_URL, so the guard must too — but it only READS the
  // file. Loading it into process.env would leak real settings into every test worker.
  let env: NodeJS.ProcessEnv = process.env;
  if (!process.env.DATABASE_URL) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const parsed = require("dotenv").parse(require("node:fs").readFileSync(".env"));
      env = { ...process.env, DATABASE_URL: parsed.DATABASE_URL };
    } catch {
      /* no .env — the check below reports the missing name */
    }
  }
  const result = checkDisposableDatabase(env);
  if (!result.ok) throw new Error(result.message);
}
