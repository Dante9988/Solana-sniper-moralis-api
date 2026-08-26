import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pureFiles = [
  "src/forensics/types.ts",
  "src/forensics/thresholds.ts",
  "src/forensics/percentageCalculations.ts",
  "src/forensics/tokenEligibilityPolicy.ts",
];

const clientFiles = [
  "src/forensics/forensicsConfig.ts",
  "src/forensics/rpcSchemas.ts",
  "src/forensics/requestBudget.ts",
  "src/forensics/solanaForensicsClient.ts",
];

const EXECUTION_PATTERNS = [
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
  /setInterval/,
  /sqlite/i,
  /jito/i,
  /helius[-_ ]?sender/i,
  /wallet[-_ ]?as[-_ ]?a[-_ ]?service/i,
];

describe("forensics execution boundary — Phase 5A pure files", () => {
  // Phase 5A is data contracts + pure policy only, so this additionally bans
  // ALL network reachability. It intentionally does not ban the literal word
  // "helius" or "wallet" generically — `ForensicEvidenceSource`/`WalletCluster`
  // name Helius and wallets descriptively as domain concepts, not calls.
  it("has zero network, scheduler, SQLite, Discord, private-key, trading, or execution reachability", () => {
    const source = pureFiles.map((file) => readFileSync(file, "utf8")).join("\n");
    for (const prohibited of [...EXECUTION_PATTERNS, /axios|fetch\(/, /@solana\/web3\.js/, /Connection\(/, /setTimeout/]) {
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

describe("forensics execution boundary — Phase 5B read-only client", () => {
  // The Phase 5B client legitimately uses `fetch`/`AbortController`/timers to
  // talk to Helius/Solana RPC read-only endpoints, so those are NOT banned
  // here. What's banned is any path toward transaction submission, signing,
  // trading, or wallet/private-key material — read-only RPC only.
  it("has no transaction-submission, signing, trading, wallet, or tracker/Discord reachability", () => {
    const source = clientFiles.map((file) => readFileSync(file, "utf8")).join("\n");
    for (const prohibited of EXECUTION_PATTERNS) {
      expect(source).not.toMatch(prohibited);
    }
  });

  it("only calls read-only RPC methods (no *Transaction submission or signing methods)", () => {
    const source = readFileSync("src/forensics/solanaForensicsClient.ts", "utf8");
    expect(source).not.toMatch(/method:\s*["']send/i);
    expect(source).not.toMatch(/method:\s*["']sign/i);
    expect(source).not.toMatch(/simulateTransaction/i);
  });
});
