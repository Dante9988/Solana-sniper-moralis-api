import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const productionFiles = [
  "src/assets/types.ts", "src/assets/chainRegistry.ts", "src/assets/assetResolver.ts",
  "src/assets/marketObservation.ts", "src/assets/assetStore.ts", "src/assets/tokenDiscoveryAssetAdapter.ts",
];

describe("asset foundation execution boundary", () => {
  it("has no network, scheduler, SQLite, Discord, wallet, trading, or execution reachability", () => {
    const source = productionFiles.map((file) => readFileSync(file, "utf8")).join("\n");
    for (const prohibited of [
      /from ["'][^"']*transactions/, /tradingService/, /sniperooService/, /tracker\//, /discord\//,
      /wallet|private.?key/i, /jupiter/i, /\bKeypair\b/, /sendTransaction|signTransaction/,
      /create(?:Buy|Sell|Swap)Transaction|buyToken|sellToken|swapToken/, /axios|fetch\(/,
      /setInterval|setTimeout/, /sqlite/i,
    ]) expect(source).not.toMatch(prohibited);
  });
});
