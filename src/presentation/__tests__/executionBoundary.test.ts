import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOTS = ["src/presentation", "src/api"];

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__") continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) files.push(...collectSourceFiles(full));
    else if (entry.endsWith(".ts")) files.push(full);
  }
  return files;
}

describe("Phase 6 presentation-layer execution boundary (phase6.txt §1.1)", () => {
  const files = ROOTS.flatMap((root) => collectSourceFiles(root));
  const source = files.map((file) => readFileSync(file, "utf8")).join("\n");

  it("scanned at least one file per surface", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("has no reachability into execution, wallet, tracker, or live-login modules", () => {
    for (const prohibited of [
      /from ["'][^"']*\/transactions["']/,
      /from ["'][^"']*tradingService["']/,
      /from ["'][^"']*sniperooService["']/,
      /from ["'][^"']*pumputils\//,
      /from ["'][^"']*tracker\//,
      /from ["'][^"']*discord\/discord["']/,
      /jito-ts/,
      /\bJitoJsonRpc|sendBundle\b/,
      /PRIV_KEY_WALLET/,
      /\bKeypair\.fromSecretKey\b/,
      /sendTransaction|signTransaction/,
      /create(?:Buy|Sell|Swap)Transaction|buyToken|sellToken|swapToken/,
      /client\.login\(/,
    ]) {
      expect(source).not.toMatch(prohibited);
    }
  });
});
