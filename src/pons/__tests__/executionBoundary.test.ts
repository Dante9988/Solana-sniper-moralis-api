/**
 * Phase 7B.5A §8 — execution-boundary coverage for src/pons/**, matching
 * src/forensics/__tests__/executionBoundary.test.ts's pattern. Pons is a
 * read-only ingestion pipeline: no transaction execution, no signing, no
 * wallet material, and no reach into the legacy trading/Telegram/Discord
 * trading surfaces this repo already isolates elsewhere.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ALL_PONS_SOURCE_FILES = [
  "src/pons/abi.ts",
  "src/pons/chainClient.ts",
  "src/pons/checkpointStore.ts",
  "src/pons/concurrency.ts",
  "src/pons/config.ts",
  "src/pons/discoveryListener.ts",
  "src/pons/graduationPoller.ts",
  "src/pons/logger.ts",
  "src/pons/ponsAdapter.ts",
  "src/pons/reorgRecovery.ts",
  "src/pons/sourceHealth.ts",
  "src/pons/tradeListener.ts",
  "src/pons/scripts/ponsWorkerMain.ts",
];

const EXECUTION_PATTERNS = [
  /from ["'][^"']*transactions/,
  /tradingService/,
  /sniperooService/,
  /tracker\//,
  /discord\//,
  /telegram\//i,
  /PRIV_KEY_WALLET|RUGCHECK_PRIVATE_KEY|privateKey|secretKey/i,
  /jupiter/i,
  /\bKeypair\b/,
  /sendTransaction|signTransaction|signMessage/,
  /create(?:Buy|Sell|Swap)Transaction|buyToken|sellToken|swapToken/,
  /\bsqlite\b/i,
  /jito/i,
  /helius[-_ ]?sender/i,
  /wallet[-_ ]?as[-_ ]?a[-_ ]?service/i,
];

describe("Pons ingestion execution boundary", () => {
  it("has no transaction-submission, signing, trading, wallet, or tracker/Discord/Telegram reachability", () => {
    // logger.ts is checked separately below: its REDACTED_PATHS list
    // legitimately names "privateKey"/"secretKey" as strings to censor if
    // they ever appear in a logged object (defensive redaction, same
    // convention as src/researchApi/lib/logger.ts) — that is not wallet
    // reachability.
    const source = ALL_PONS_SOURCE_FILES.filter((f) => f !== "src/pons/logger.ts")
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    for (const prohibited of EXECUTION_PATTERNS) {
      expect(source).not.toMatch(prohibited);
    }
  });

  it("never imports from src/api, src/services trading modules, src/telegram, or src/discord", () => {
    const importLines = ALL_PONS_SOURCE_FILES.flatMap((file) => readFileSync(file, "utf8").match(/^import .+$/gm) ?? []);
    for (const line of importLines) {
      expect(line).not.toMatch(/from ["']\.\.?\/.*\/(telegram|discord|api)\//);
      expect(line).not.toMatch(/tradingService|sniperooService|jupiterService/i);
    }
  });

  it("chainClient.ts only ever performs read-only viem calls — no wallet/transport signing methods", () => {
    const source = readFileSync("src/pons/chainClient.ts", "utf8");
    expect(source).not.toMatch(/sendTransaction|signTransaction|writeContract|walletClient|createWalletClient/i);
  });

  it("discoveryListener.ts and tradeListener.ts never start themselves — construction/instantiation only happens outside these modules", () => {
    for (const file of ["src/pons/discoveryListener.ts", "src/pons/tradeListener.ts", "src/pons/graduationPoller.ts"]) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/^\s*new (DiscoveryListener|TradeListener|GraduationPoller)\(/m);
    }
  });

  it("the worker entrypoint only starts the loops inside main(), never at bare module scope", () => {
    const source = readFileSync("src/pons/scripts/ponsWorkerMain.ts", "utf8");
    const topLevelCalls = source.match(/^[a-zA-Z].*\(.*\);?\s*$/gm) ?? [];
    for (const line of topLevelCalls) {
      if (!/^main\(\)/.test(line.trim())) {
        expect(line).not.toMatch(/\.start\(\)/);
      }
    }
  });

  it("logger.ts redacts RPC URLs and secret-shaped fields, and never imports researchApi's logger (architecture boundary: src/pons/** stays independent of src/researchApi/**)", () => {
    const source = readFileSync("src/pons/logger.ts", "utf8");
    expect(source).toMatch(/rpcHttpUrl/);
    expect(source).toMatch(/rpcWsUrl/);
    expect(source).not.toMatch(/from ["'].*researchApi/);
  });

  it("reorgRecovery.ts never deletes a DiscoveredToken/ChainTrade row outright — reconciliation only marks canonicalStatus, matching the audit requirement (never blindly delete checkpoints/facts)", () => {
    const source = readFileSync("src/pons/reorgRecovery.ts", "utf8");
    expect(source).not.toMatch(/discoveredToken\.delete/);
    expect(source).not.toMatch(/chainTrade\.delete/);
  });

  it("never blindly deletes a ChainIngestionCheckpoint row — recovery only ever rewinds lastHeight/lastHash via update, matching phase7b5a.txt §2's 'do not blindly delete checkpoints'", () => {
    const source = [readFileSync("src/pons/reorgRecovery.ts", "utf8"), readFileSync("src/pons/checkpointStore.ts", "utf8")].join("\n");
    expect(source).not.toMatch(/chainIngestionCheckpoint\.delete/);
  });
});
