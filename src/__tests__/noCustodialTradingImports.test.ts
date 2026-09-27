/**
 * One global guard: no production module may import the legacy custodial trading path.
 *
 * Several suites already assert this for their own directory (forensics, x, pons,
 * presentation, assets, candles, intelligence). Each protects one module, so a NEW module
 * added tomorrow is covered by none of them. This walks the whole of `src` instead, so the
 * guarantee does not depend on remembering to add another per-directory test.
 *
 * `tradingService` signs with a `Keypair` server-side, defaults to 50% slippage and sends
 * with `skipPreflight`. OnlyPump's model is that the backend builds an unsigned transaction
 * and the user's wallet signs it — see `jupiterService`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");
/** The module itself, and the tests whose job is to name it. */
const ALLOWED = [join("services", "tradingService.ts"), "__tests__"];

const FORBIDDEN: { pattern: RegExp; why: string }[] = [
  { pattern: /from\s+["'][^"']*\/?tradingService["']/, why: "custodial Keypair signing" },
  { pattern: /require\(\s*["'][^"']*\/?tradingService["']\s*\)/, why: "custodial Keypair signing" },
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

describe("no production module imports the legacy custodial trading path", () => {
  const files = sourceFiles(SRC).filter((f) => !ALLOWED.some((a) => f.includes(a)));

  it("walks a meaningful number of files, so a passing result means something", () => {
    // Guards against the test silently passing because the walk found nothing.
    expect(files.length).toBeGreaterThan(100);
  });

  it("finds no import of tradingService anywhere in production code", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const { pattern, why } of FORBIDDEN) {
        if (pattern.test(source)) offenders.push(`${file.replace(SRC, "src")} (${why})`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
