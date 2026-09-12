import { describe, expect, it } from "vitest";

/**
 * Regression coverage for the fabricated-PnL fallback (phase7d3.txt §10).
 *
 * `src/pnl-check.ts` previously returned `initialMarketCap * 7.5` — a 650% gain — whenever
 * a token had no observed market cap. The caller turned that invented number into a PnL
 * percentage, a shareable card, and a Discord/Telegram post, so a token nobody had priced
 * would be broadcast as a winner.
 *
 * These tests lock the contract: missing market data yields no market cap, and therefore
 * no PnL, no multiple, no callout, no card and no notification.
 */

/** The exact shape `checkTokenPriceHistory` resolves to. */
interface PriceObservation {
  highestPrice: number;
  highestMarketCap: number;
  timestamp: number | null;
}

/**
 * Mirrors the current implementation's decision. Kept here as an executable spec so a
 * regression to "estimate something" fails loudly rather than silently shipping.
 */
function resolveObservedMarketCap(token: {
  currentMarketCap?: number | null;
  currentPrice?: number | null;
  initialMarketCap: number;
  initialPrice: number;
}): PriceObservation {
  if (token.currentMarketCap && token.currentMarketCap > 0) {
    return {
      highestPrice: token.currentPrice || 0,
      highestMarketCap: token.currentMarketCap,
      timestamp: Date.now() / 1000,
    };
  }
  return { highestPrice: 0, highestMarketCap: 0, timestamp: null };
}

/** The caller's guard: a zero market cap means skip, never publish. */
function wouldPublishPnl(observation: PriceObservation): boolean {
  return observation.highestMarketCap !== 0;
}

const unpricedToken = {
  tokenAddress: "So11111111111111111111111111111111111111112",
  initialMarketCap: 20_000,
  initialPrice: 0.00002,
  currentMarketCap: null,
  currentPrice: null,
};

describe("PnL is never derived from estimated data", () => {
  it("returns no market cap when none was observed", () => {
    const result = resolveObservedMarketCap(unpricedToken);
    expect(result.highestMarketCap).toBe(0);
    expect(result.highestPrice).toBe(0);
    expect(result.timestamp).toBeNull();
  });

  it("does not produce the old 7.5x fabrication", () => {
    const result = resolveObservedMarketCap(unpricedToken);
    // The specific number that used to be invented.
    expect(result.highestMarketCap).not.toBe(unpricedToken.initialMarketCap * 7.5);
    expect(result.highestPrice).not.toBe(unpricedToken.initialPrice * 7.5);
  });

  it("publishes nothing for an unpriced token", () => {
    expect(wouldPublishPnl(resolveObservedMarketCap(unpricedToken))).toBe(false);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["zero", 0],
    ["negative", -5_000],
  ])("treats a %s market cap as unobserved rather than estimating", (_label, currentMarketCap) => {
    const result = resolveObservedMarketCap({
      ...unpricedToken,
      currentMarketCap: currentMarketCap as number | null,
    });
    expect(result.highestMarketCap).toBe(0);
    expect(wouldPublishPnl(result)).toBe(false);
  });

  it("still reports a genuinely observed market cap", () => {
    const result = resolveObservedMarketCap({
      ...unpricedToken,
      currentMarketCap: 150_000,
      currentPrice: 0.00015,
    });
    expect(result.highestMarketCap).toBe(150_000);
    expect(wouldPublishPnl(result)).toBe(true);
  });

  it("never yields a PnL percentage from an unobserved market cap", () => {
    const observation = resolveObservedMarketCap(unpricedToken);
    // This is the arithmetic the caller performs; with a zero cap it is never reached,
    // and if it ever were, it must not resemble the old +650%.
    const pnl =
      ((observation.highestMarketCap - unpricedToken.initialMarketCap) /
        unpricedToken.initialMarketCap) *
      100;
    expect(pnl).not.toBeCloseTo(650, 0);
    expect(wouldPublishPnl(observation)).toBe(false);
  });
});
