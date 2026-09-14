import { configDefaults, defineConfig } from "vitest/config";

/**
 * Vitest previously ran with no config, so it collected every *.test.* file under the
 * working tree — including the Solidity toolchain's vendored JS tests once
 * evm-verification/scripts/install-deps.sh had populated evm-verification/lib, local
 * scratch clones under .run/, and agent worktrees under .claude/. None of those are this
 * project's tests.
 */
export default defineConfig({
  test: {
    // Refuses DB-integration suites on a non-disposable database (see the file for why).
    globalSetup: ["./src/testSupport/disposableDatabaseGuard.ts"],
    exclude: [...configDefaults.exclude, "evm-verification/**", ".run/**", ".claude/**", "dist/**"],
  },
});
