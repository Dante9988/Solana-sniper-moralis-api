import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const productionFiles = [
  "src/forensics/types.ts",
  "src/forensics/thresholds.ts",
  "src/forensics/percentageCalculations.ts",
  "src/forensics/tokenEligibilityPolicy.ts",
];

describe("forensics execution boundary (Phase 5A)", () => {
  // Phase 5A is data contracts + pure policy only, so this test bans actual
  // network/execution reachability. It intentionally does not ban the literal
  // word "helius" or "wallet" — `ForensicEvidenceSource`/`WalletCluster` name
  // Helius and wallets descriptively as future evidence sources/domain
  // concepts. Phase 5B adds a real read-only client and must extend this list
  // to cover actual `fetch`/RPC reachability in that new file.
  it("has no network, scheduler, SQLite, Discord, private-key, trading, or execution reachability", () => {
    const source = productionFiles.map((file) => readFileSync(file, "utf8")).join("\n");
    for (const prohibited of [
      /from ["'][^"']*transactions/,
      /tradingService/,
      /sniperooService/,
      /tracker\//,
      /discord\//,
      /PRIV_KEY_WALLET|RUGCHECK_PRIVATE_KEY|privateKey|secretKey/i,
      /jupiter/i,
      /\bKeypair\b/,
      /sendTransaction|signTransaction/,
      /create(?:Buy|Sell|Swap)Transaction|buyToken|sellToken|swapToken/,
      /axios|fetch\(/,
      /setInterval|setTimeout/,
      /sqlite/i,
      /jito/i,
      /@solana\/web3\.js/,
      /Connection\(/,
    ]) {
      expect(source).not.toMatch(prohibited);
    }
  });

  it("evaluateTokenEligibility imports nothing from the AI/Anthropic layer", () => {
    const source = readFileSync("src/forensics/tokenEligibilityPolicy.ts", "utf8");
    expect(source).not.toMatch(/from ["'][^"']*anthropic/i);
    expect(source).not.toMatch(/from ["'][^"']*aiSynthesis/i);
    expect(source).not.toMatch(/@anthropic-ai/i);
  });
});
