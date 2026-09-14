import { describe, expect, it } from "vitest";

import { checkDisposableDatabase, looksDisposable } from "../disposableDatabaseGuard";

const url = (db: string) => `postgresql://u:p@localhost:5432/${db}`;

describe("disposable database guard", () => {
  it("does nothing when no DB suite is enabled", () => {
    expect(checkDisposableDatabase({ DATABASE_URL: url("solana_bot") } as NodeJS.ProcessEnv).ok).toBe(true);
  });

  it("refuses the development database that DB suites damaged on 2026-09-14", () => {
    const r = checkDisposableDatabase({ PONS_RUN_DB_TESTS: "true", DATABASE_URL: url("solana_bot") } as NodeJS.ProcessEnv);
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toMatch(/"solana_bot"/);
  });

  it("accepts CI's database and other clearly disposable names", () => {
    for (const name of ["ci_migrate_test", "ci_7d32_verify", "onlypump_test", "tmp-db", "test"]) {
      expect(checkDisposableDatabase({ PAPER_RUN_DB_TESTS: "true", DATABASE_URL: url(name) } as NodeJS.ProcessEnv).ok).toBe(true);
    }
  });

  it("does not mistake names that merely contain the letters", () => {
    expect(looksDisposable("latest_prod")).toBe(false);
    expect(looksDisposable("contest")).toBe(false);
    expect(looksDisposable("circle")).toBe(false);
  });

  it("allows a named database only by explicit, exact acknowledgement", () => {
    const env = { CANDLES_RUN_DB_TESTS: "true", DATABASE_URL: url("scratch_pg"), ALLOW_DB_TESTS_ON_NAMED_DATABASE: "scratch_pg" } as NodeJS.ProcessEnv;
    expect(checkDisposableDatabase(env).ok).toBe(true);
    expect(checkDisposableDatabase({ ...env, ALLOW_DB_TESTS_ON_NAMED_DATABASE: "other" }).ok).toBe(false);
  });
});
