import { describe, expect, it } from "vitest";

import { bondingProgressBps, curveSnapshot, formatScaled, nextRefreshDelayMs, parseDecimal, poolSnapshot, toUsd } from "../marketSnapshot";

/**
 * Values are real Robinhood Chain mainnet reads taken 2026-09-15 through Multicall3:
 *   curve 0x3fbb…28cf (token 0x7d9a…4554, native ETH quote) and graduated pool
 *   0x87c6…26a5 (token 0x6cde…d6f3, currency1; native ETH currency0).
 */
const CURVE = {
  quoteReserve: 1744286899831547514n,
  tokenReserve: 963144308520716522580550845n,
  realQuoteReserve: 64286899831547514n,
  reservedTokens: 285714285714285714285714285n,
  launchSupply: 10n ** 27n,
  sellableTokens: 677430022806430808294836560n,
  graduated: false,
  readyToGraduate: false,
  graduationThreshold: 4200000000000000000n,
  totalSupply: 10n ** 27n,
};

describe("market snapshot maths (Phase 7D.4)", () => {
  it("prices a bonding curve from its reserves and measures progress on the token side, as the contract triggers graduation", () => {
    const s = curveSnapshot(CURVE);
    // 1.744 ETH virtual+real over 963M tokens ≈ 1.811e-9 ETH per token.
    expect(Number(s.priceQuoteX36) / 1e36).toBeCloseTo(1.8110e-9, 12);
    expect(Number(s.marketCapQuote) / 1e18).toBeCloseTo(1.811, 3);
    expect(s.liquidityQuote).toBe(CURVE.realQuoteReserve);
    // sold = 714,285,714 − 677,430,022 tokens of the initial sellable allocation → 5.16 %.
    expect(s.bondingProgressBps).toBe(515);
    expect(s.quoteRaised).toBe(64286899831547514n);
  });

  it("reports 100 % once the sellable allocation is gone or the curve graduated, and never below 0", () => {
    expect(bondingProgressBps({ ...CURVE, sellableTokens: 0n, readyToGraduate: true })).toBe(10_000);
    expect(bondingProgressBps({ ...CURVE, graduated: true })).toBe(10_000);
    expect(bondingProgressBps({ ...CURVE, sellableTokens: CURVE.launchSupply })).toBe(0);
  });

  it("prices a graduated V4 pool from sqrtPriceX96 in either currency order, with a full-range liquidity equivalent", () => {
    const pool = { sqrtPriceX96: 2383382949210321874271083906747709n, liquidity: 29277002188455995824267n, tokenIsCurrency0: false, totalSupply: 10n ** 27n };
    const s = poolSnapshot(pool);
    const tokensPerEth = (Number(pool.sqrtPriceX96) / 2 ** 96) ** 2;
    expect(Number(s.priceQuoteX36) / 1e36).toBeCloseTo(1 / tokensPerEth, 15);
    // ETH side ≈ L / sqrtP = 0.973 ETH, doubled for both sides.
    expect(Number(s.liquidityQuote) / 1e18).toBeCloseTo(2 * 0.97321, 3);
    const flipped = poolSnapshot({ ...pool, tokenIsCurrency0: true });
    expect(Number(flipped.priceQuoteX36) / 1e36).toBeCloseTo(tokensPerEth, -2);
    expect(() => poolSnapshot({ ...pool, sqrtPriceX96: 0n })).toThrow();
  });

  it("converts to USD with integer maths", () => {
    const snap = curveSnapshot(CURVE);
    const usd = toUsd(snap, { token: 18, quote: 18 }, "4500.12345678");
    expect(Number(usd.priceUsd) / ((Number(snap.priceQuoteX36) / 1e36) * 4500.12345678)).toBeCloseTo(1, 9);
    expect(Number(usd.marketCapUsd)).toBeCloseTo(1.8110 * 4500.12, -1);
    expect(Number(usd.liquidityUsd)).toBeCloseTo(0.0642869 * 4500.12, 1);
    const stock = toUsd({ priceQuoteX36: 10n ** 24n, marketCapQuote: 5n * 10n ** 6n, liquidityQuote: 10n ** 6n }, { token: 18, quote: 6 }, "1");
    expect(stock).toEqual({ priceUsd: "1", marketCapUsd: "5", liquidityUsd: "1" });
  });

  it("parses and formats decimals exactly", () => {
    expect(parseDecimal("12.5", 3)).toBe(12500n);
    expect(parseDecimal("0.000000019", 9)).toBe(19n);
    expect(() => parseDecimal("-1", 2)).toThrow();
    expect(formatScaled(123450n, 4)).toBe("12.345");
    expect(formatScaled(-5n, 2)).toBe("-0.05");
  });

  it("refreshes active tokens every minute and backs dead ones off to six hours", () => {
    expect(nextRefreshDelayMs({ changed: true, unchangedReads: 0, graduated: false, progressBps: 100, launchedAgeMs: null })).toBe(60_000);
    expect(nextRefreshDelayMs({ changed: false, unchangedReads: 0, graduated: false, progressBps: 0, launchedAgeMs: 3_600_000 })).toBe(120_000);
    expect(nextRefreshDelayMs({ changed: false, unchangedReads: 1, graduated: false, progressBps: 0, launchedAgeMs: 10 ** 9 })).toBe(600_000);
    expect(nextRefreshDelayMs({ changed: false, unchangedReads: 30, graduated: false, progressBps: 0, launchedAgeMs: 10 ** 9 })).toBe(6 * 3_600_000);
  });
});
