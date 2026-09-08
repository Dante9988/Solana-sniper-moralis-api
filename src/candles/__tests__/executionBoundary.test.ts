/**
 * Phase 7B.5B §18 — execution-boundary coverage for src/candles/**,
 * matching src/pons/__tests__/executionBoundary.test.ts's pattern. The
 * candle/market domain is read-derive-persist only: no transaction
 * execution, no signing, no wallet material, and no trading/Telegram/
 * Discord reachability.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ALL_CANDLE_SOURCE_FILES = [
  "src/candles/aggregate.ts",
  "src/candles/candleAggregationService.ts",
  "src/candles/config.ts",
  "src/candles/decimalsResolver.ts",
  "src/candles/finality.ts",
  "src/candles/health.ts",
  "src/candles/persistCandles.ts",
  "src/candles/recompute.ts",
  "src/candles/resolutions.ts",
  "src/candles/types.ts",
  "src/candles/usdPricing.ts",
  "src/candles/scripts/candlesWorkerMain.ts",
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
  /writeContract|walletClient|createWalletClient/i,
];

describe("Candle domain execution boundary", () => {
  it("has no transaction-submission, signing, trading, wallet, or tracker/Discord/Telegram reachability", () => {
    const source = ALL_CANDLE_SOURCE_FILES.map((file) => readFileSync(file, "utf8")).join("\n");
    for (const prohibited of EXECUTION_PATTERNS) {
      expect(source).not.toMatch(prohibited);
    }
  });

  it("never imports from src/api, src/telegram, src/discord, or trading services", () => {
    const importLines = ALL_CANDLE_SOURCE_FILES.flatMap((file) => readFileSync(file, "utf8").match(/^import .+$/gm) ?? []);
    for (const line of importLines) {
      expect(line).not.toMatch(/from ["']\.\.?\/.*\/(telegram|discord|api)\//);
      expect(line).not.toMatch(/tradingService|sniperooService|jupiterService/i);
    }
  });

  it("aggregate.ts is pure — no Prisma/viem/network imports, only the candle domain's own types", () => {
    const source = readFileSync("src/candles/aggregate.ts", "utf8");
    expect(source).not.toMatch(/@prisma\/client/);
    expect(source).not.toMatch(/from ["']viem["']/);
    expect(source).not.toMatch(/\bfetch\(/);
  });

  it("aggregate.ts and types.ts never import anything Pons/EVM-specific — the chain-neutral core knows nothing about a specific venue", () => {
    for (const file of ["src/candles/aggregate.ts", "src/candles/types.ts", "src/candles/resolutions.ts"]) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/from ["']\.\.?\/.*pons/i);
    }
  });

  it("never deletes ChainTrade/DiscoveredToken rows — only its own derived MarketCandle/CandleAggregationCheckpoint state", () => {
    const source = ALL_CANDLE_SOURCE_FILES.map((file) => readFileSync(file, "utf8")).join("\n");
    expect(source).not.toMatch(/discoveredToken\.delete/);
    expect(source).not.toMatch(/chainTrade\.delete/);
  });

  it("the worker entrypoint only starts the loop inside main(), never at bare module scope", () => {
    const source = readFileSync("src/candles/scripts/candlesWorkerMain.ts", "utf8");
    const topLevelCalls = source.match(/^[a-zA-Z].*\(.*\);?\s*$/gm) ?? [];
    for (const line of topLevelCalls) {
      if (!/^main\(\)/.test(line.trim())) {
        expect(line).not.toMatch(/\.start\(\)/);
      }
    }
    // Only main() may be invoked at bare top-level, guarded by require.main === module.
    expect(source).toMatch(/if \(require\.main === module\) \{\s*\n\s*main\(\)/);
  });
});
