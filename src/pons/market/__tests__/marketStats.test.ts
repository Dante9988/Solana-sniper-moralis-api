import { describe, expect, it } from "vitest";

import { computeWindows, coverageFor, formatUnits, priceScaled, type StatTrade } from "../marketStats";

const NOW = new Date("2026-09-15T12:00:00Z");
const ago = (s: number) => new Date(NOW.getTime() - s * 1000);
const ETH = 10n ** 18n;
const TOK = 10n ** 18n;
const full = { from: ago(10 * 86_400), to: NOW };

function trade(secondsAgo: number, side: "buy" | "sell", quote: bigint, tokens: bigint, usd: string | null = null): StatTrade {
  return { side, quoteAmount: quote, tokenAmount: tokens, timestamp: ago(secondsAgo), usd };
}

describe("marketStats", () => {
  it("formats units exactly", () => {
    expect(formatUnits(1_500_000n, 6)).toBe("1.5");
    expect(formatUnits(123n, 18)).toBe("0.000000000000000123");
    expect(formatUnits(0n, 6)).toBe("0");
  });

  it("normalizes price by both decimals", () => {
    // 1 USDG (6dp) for 1,000 tokens (18dp) -> 0.001 USDG per token
    expect(formatUnits(priceScaled({ quoteAmount: 1_000_000n, tokenAmount: 1_000n * TOK }, 18, 6)!, 18)).toBe("0.001");
  });

  it("counts each trade once in quote units, splits buys and sells, per window", () => {
    const trades = [trade(4_000, "buy", ETH, 1_000n * TOK), trade(600, "sell", ETH / 2n, 400n * TOK), trade(60, "buy", ETH / 4n, 100n * TOK)];
    const w = computeWindows({ trades, baseline: null, now: NOW, coverage: full, tokenDecimals: 18, quoteDecimals: 18 });
    const byId = Object.fromEntries(w.map((x) => [x.window, x]));
    expect(byId["5m"]).toMatchObject({ coverage: "COMPLETE", trades: 1, buys: 1, sells: 0, volumeQuote: "0.25" });
    expect(byId["15m"]).toMatchObject({ trades: 2, buys: 1, sells: 1, volumeQuote: "0.75" });
    expect(byId["24h"]).toMatchObject({ trades: 3, volumeQuote: "1.75" });
  });

  it("reports zero only when coverage proves it; partial coverage is labelled; no coverage reports nothing", () => {
    const complete = computeWindows({ trades: [], baseline: null, now: NOW, coverage: full, tokenDecimals: 18, quoteDecimals: 18 });
    expect(complete[0]).toMatchObject({ coverage: "COMPLETE", trades: 0, volumeQuote: "0" });

    const lagging = computeWindows({ trades: [], baseline: null, now: NOW, coverage: { from: full.from, to: ago(1_200) }, tokenDecimals: 18, quoteDecimals: 18 });
    expect(lagging.find((x) => x.window === "5m")).toMatchObject({ coverage: "NONE", trades: null, volumeQuote: null });
    expect(lagging.find((x) => x.window === "1h")).toMatchObject({ coverage: "PARTIAL", trades: 0 });

    const newHistory = computeWindows({ trades: [], baseline: null, now: NOW, coverage: { from: ago(1_000), to: NOW }, tokenDecimals: 18, quoteDecimals: 18 });
    expect(newHistory.find((x) => x.window === "24h")?.coverage).toBe("PARTIAL");
    expect(coverageFor(ago(300), NOW, { from: null, to: NOW }, 120)).toBe("PARTIAL");
  });

  it("gives USD volume only when every trade in the window was valued", () => {
    const trades = [trade(100, "buy", ETH, TOK, "2500"), trade(50, "sell", ETH, TOK, null)];
    const [w5] = computeWindows({ trades, baseline: null, now: NOW, coverage: full, tokenDecimals: 18, quoteDecimals: 18 });
    expect(w5.volumeUsd).toBeNull();
    expect(w5.tradesValuedUsd).toBe(1);
    const [ok] = computeWindows({ trades: [trade(100, "buy", ETH, TOK, "2500.5"), trade(50, "sell", ETH, TOK, "2499.25")], baseline: null, now: NOW, coverage: full, tokenDecimals: 18, quoteDecimals: 18 });
    expect(ok.volumeUsd).toBe("4999.75");
  });

  it("computes price change against the last price at or before the window start, else none", () => {
    const baseline = trade(90_000, "buy", ETH, 1_000n * TOK); // 0.001
    const trades = [trade(200, "buy", 2n * ETH, 1_000n * TOK)]; // 0.002
    const w = computeWindows({ trades, baseline, now: NOW, coverage: full, tokenDecimals: 18, quoteDecimals: 18 });
    expect(w.find((x) => x.window === "24h")?.priceChangePct).toBe("100");
    expect(w.find((x) => x.window === "5m")?.priceChangePct).toBe("100"); // baseline is still the last trade before 5m ago
    const noBase = computeWindows({ trades, baseline: null, now: NOW, coverage: full, tokenDecimals: 18, quoteDecimals: 18 });
    expect(noBase.find((x) => x.window === "5m")?.priceChangePct).toBeNull();
  });
});
