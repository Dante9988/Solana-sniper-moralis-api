# Phase 7D.5.1 — reconciling two claims in the previous handoff

Both were raised as inconsistencies. One was a genuine error of mine; the other was a
reporting ambiguity. Neither is a regression.

## 1. "The legacy Jupiter service is custodial" — **wrong, retracted**

I claimed `src/services/jupiterService.ts` signs with a stored key. It does not. Re-read at
commit `9d3588e`:

| Check | Result |
|---|---|
| `grep -cin "keypair\|secretkey\|privatekey\|mnemonic\|seed"` over all 470 lines | **0** |
| `buildBuySwapTransaction` (line ~161) | returns `{ transactionBase64, quote }` — unsigned |
| Sibling method's own comment | *"Does not sign or send anything."* |
| `connectWallet(userId, publicAddress)` (line 60) | validates a `PublicKey`, upserts `{ userId, walletAddress }` — a **public address only** |
| Callers | `src/telegram/scenes.ts`, `showWalletMenu.ts`, `showSellMenu.ts`, `callbackHandlers.ts`, `src/discord/**` — wallet registration, config and menus |

So both the old service and the new adapter return unsigned transactions. I conflated "used
by the legacy bot surface" with "custodial"; only the first is true.

**The reason for a separate adapter stands without that argument:** `jupiterService.ts`
targets `https://quote-api.jup.ag/v6/quote`, probed 2026-09-20 and **unreachable (HTTP 000)**,
and it predates the shared buying contract. Corrected in `jupiterProvider.ts`,
`gap-assessment.md` and `source-matrix.md`.

## 2. "1,367 passed / 1 skipped" became "1,282 passed / 125 skipped"

Two different suites, reported without saying which. Run back to back on 2026-09-20:

| Run | Command | Files | Tests |
|---|---|---|---|
| **Default** | `npx vitest run` | 113 passed, 24 skipped | **1,282 passed, 125 skipped** |
| **DB integration** | all `*_RUN_DB_TESTS=true`, `DATABASE_URL=…/ci_7d4_test`, `--no-file-parallelism` | 136 passed, 1 skipped | **1,406 passed, 1 skipped** |

**Total tests collected is 1,407 in both.** Nothing is missing; the 125 are the same tests,
gated rather than deleted.

- The 24 skipped files gate themselves: `const RUN_DB_TESTS = process.env.PONS_RUN_DB_TESTS === "true"` with `describe.skipIf(!RUN_DB_TESTS)`. That gate exists because these suites delete checkpoints and run reorg recovery against a fake chain — the mechanism that damaged the dev database on 2026-09-14 (ARCHITECTURE §26.4). They must only run against a verified disposable database.
- The 1 remaining skip in the full run is the Anvil fork reorg test, which needs a local anvil node.

**No new skips were introduced.** The default run has reported exactly 125 skipped across
this phase (1,229/125 → 1,243/125 → 1,282/125); only the passing count moved, upward, as
tests were added. The earlier "1,367 / 1" was the DB run at that point; it is now **1,406 / 1**
because 37 buying tests and others have since been added.

**Reporting fix going forward:** both numbers get stated with the command that produced them.
