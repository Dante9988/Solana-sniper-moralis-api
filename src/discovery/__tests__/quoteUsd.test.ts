/**
 * Phase 7E.4.3 §10 — the pinned USD conversion regression.
 *
 *   raw quote amount -> quote decimals -> normalized quote amount -> trusted rate -> USD notional
 *
 * Three cases the brief names explicitly (A: SOL quote, B: USDC quote at 6 decimals, C: a
 * deliberately huge raw amount that would be absurd if decimals were skipped), plus the rule that
 * matters more than any of them: when the rate cannot be trusted, USD volume is UNAVAILABLE. There
 * is no fallback price in this codebase, and the last test in this file is what keeps it that way.
 *
 * Decimals verified on mainnet 2026-09-26 through the configured endpoint, not recalled:
 *   native SOL sentinel 11111111111111111111111111111111 -> 9 (LAMPORTS_PER_SOL, @solana/web3.js 1.98.0)
 *   So11111111111111111111111111111111111111112          -> 9 (read from the mint)
 *   EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v         -> 6 (read from the mint)
 */

import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import { quoteRawToUsd, quoteRawToUsdNumber, rawToWholeUnits } from "../quoteUsd";
import { NATIVE_SOL_DECIMALS, NATIVE_SOL_QUOTE_SENTINEL, WRAPPED_SOL_MINT } from "../../solana/solanaDecimals";

const SOL_DECIMALS = 9;
const USDC_DECIMALS = 6;

describe("A. SOL quote", () => {
  it("converts lamports to USD through whole SOL", () => {
    // 1.5 SOL at $200 = $300. The intermediate step is 1.5 whole SOL, not 1_500_000_000 of anything.
    expect(rawToWholeUnits("1500000000", SOL_DECIMALS)).toBe("1.5");
    expect(quoteRawToUsd("1500000000", SOL_DECIMALS, "200")).toBe("300");
  });

  it("handles a real captured trade amount exactly", () => {
    // From the live capture on 2026-09-26: a pump.fun sell with quoteAmount 15528867 lamports.
    expect(rawToWholeUnits("15528867", SOL_DECIMALS)).toBe("0.015528867");
    expect(quoteRawToUsd("15528867", SOL_DECIMALS, "213.47")).toBe("3.31494723849");
  });

  it("agrees with the verified native-SOL decimals constant", () => {
    expect(NATIVE_SOL_DECIMALS).toBe(SOL_DECIMALS);
    expect(NATIVE_SOL_QUOTE_SENTINEL).toBe("11111111111111111111111111111111");
    expect(WRAPPED_SOL_MINT).toBe("So11111111111111111111111111111111111111112");
  });

  it("does not round a sub-cent amount to zero", () => {
    // A memecoin trade of 1000 lamports is genuinely worth a fraction of a cent; reporting $0.00
    // would erase it from volume entirely.
    expect(quoteRawToUsd("1000", SOL_DECIMALS, "200")).toBe("0.0002");
  });
});

describe("B. USDC quote (6 decimals)", () => {
  it("uses 6, not 9 — the bug a single hardcoded decimals value would cause", () => {
    // 1 USDC = 1_000_000 base units. At $1 it is $1.
    expect(rawToWholeUnits("1000000", USDC_DECIMALS)).toBe("1");
    expect(quoteRawToUsd("1000000", USDC_DECIMALS, "1")).toBe("1");
    // The same raw amount read as 9 decimals would report a thousandth of the real value.
    expect(quoteRawToUsd("1000000", 9, "1")).toBe("0.001");
  });

  it("values a large USDC amount correctly", () => {
    expect(quoteRawToUsd("2500750000", USDC_DECIMALS, "0.9998")).toBe("2500.24985");
  });
});

describe("C. huge raw amount", () => {
  // An hour of summed lamport volume. Above Number.MAX_SAFE_INTEGER (9.007e15) on purpose: this is
  // the value a float-based conversion silently corrupts.
  const HUGE_LAMPORTS = "12345678901234567890";

  it("stays exact past the double-precision limit", () => {
    expect(Number(HUGE_LAMPORTS) > Number.MAX_SAFE_INTEGER).toBe(true);
    expect(rawToWholeUnits(HUGE_LAMPORTS, SOL_DECIMALS)).toBe("12345678901.23456789");
    // Exact to the last digit — a double would have lost the trailing ...890 before the multiply.
    expect(quoteRawToUsd(HUGE_LAMPORTS, SOL_DECIMALS, "200")).toBe("2469135780246.913578");
  });

  it("produces an absurd figure ONLY if decimals are skipped, by exactly 10^decimals", () => {
    const correct = quoteRawToUsd(HUGE_LAMPORTS, SOL_DECIMALS, "200")!;
    const decimalsSkipped = quoteRawToUsd(HUGE_LAMPORTS, 0, "200")!;
    expect(Number(correct)).toBeLessThan(1e13);
    // ~$2.5 quintillion: the signature of a skipped decimals step.
    expect(Number(decimalsSkipped)).toBeGreaterThan(1e18);
    expect(BigInt(decimalsSkipped.split(".")[0]) / BigInt(correct.split(".")[0])).toBe(10n ** BigInt(SOL_DECIMALS));
  });

  it("refuses an amount that has already been scaled once", () => {
    // Scaling twice is how a volume figure ends up a billion times off; it fails loudly instead.
    expect(() => rawToWholeUnits("1.5", SOL_DECIMALS)).toThrow(/integer string/);
    expect(() => quoteRawToUsd("12345678901.234", SOL_DECIMALS, "200")).toThrow(/integer string/);
  });
});

describe("no trusted rate means no number", () => {
  it("returns null rather than an estimate", () => {
    expect(quoteRawToUsd("1500000000", SOL_DECIMALS, null)).toBeNull();
    expect(quoteRawToUsdNumber("1500000000", SOL_DECIMALS, null)).toBeNull();
  });

  it("treats a non-finite rate as unavailable", () => {
    expect(quoteRawToUsdNumber("1500000000", SOL_DECIMALS, Number.NaN)).toBeNull();
    expect(quoteRawToUsdNumber("1500000000", SOL_DECIMALS, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("rejects an invalid decimals value instead of picking one", () => {
    expect(() => quoteRawToUsd("1", -1, "200")).toThrow(/invalid decimals/);
    expect(() => quoteRawToUsd("1", 1.5, "200")).toThrow(/invalid decimals/);
  });
});

describe("the same conversion serves every volume window", () => {
  it("5m, 1h and baseline all route through one function in trendingVolume.ts", () => {
    // Asserted structurally rather than by result, because §10's requirement is that the three
    // windows cannot drift apart. Three separate expressions could agree today and diverge in one
    // edit; one shared helper cannot.
    const source = fs.readFileSync(path.join(__dirname, "../../pons/market/trendingVolume.ts"), "utf8");
    expect(source).toMatch(/volume5mUsd: usdOf\(r\.v5m, asset\.decimals, rate\)/);
    expect(source).toMatch(/volume1hUsd: usdOf\(r\.v1h, asset\.decimals, rate\)/);
    expect(source).toMatch(/baselineHourlyUsd: .*usdOf\(r\.vPrev, asset\.decimals, rate\)/);
    expect(source).toMatch(/quoteRawToUsdNumber/);
  });

  it("candle volume uses the same function", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../pons/candleFeed.ts"), "utf8");
    expect(source).toMatch(/quoteRawToUsd\(quoteAmountRaw, decimals\.quoteDecimals/);
  });

  it("has no hardcoded SOL or ETH price anywhere in src/", () => {
    // §10: "Absolutely no fallback: SOL = 170, SOL = 240, etc." A price constant is exactly how a
    // chart quietly starts lying, so its absence is pinned rather than assumed.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === "__tests__" || entry.name === "fixtures") continue;
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        const text = fs.readFileSync(full, "utf8");
        for (const line of text.split("\n")) {
          const stripped = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
          // A named price/rate constant assigned a bare number is the shape being ruled out.
          if (/\b(?:SOL|ETH)_?(?:USD|PRICE|RATE)\b\s*[:=]\s*[0-9]/i.test(stripped)) offenders.push(`${full}: ${line.trim()}`);
          if (/\b(?:fallback|default)(?:Sol|Eth)?(?:Price|Usd|Rate)\b\s*[:=]\s*[0-9]/i.test(stripped)) offenders.push(`${full}: ${line.trim()}`);
          // The shape that slipped past the two patterns above on the first run of this test:
          // a USD value derived by multiplying a balance/amount by a bare numeric literal.
          if (/\b\w*(?:usd|Usd|USD)\w*\s*[:=][^=]*\*\s*[0-9]+(?:\.[0-9]+)?\s*[;,)]/.test(stripped)) offenders.push(`${full}: ${line.trim()}`);
        }
      }
    };
    walk(path.join(__dirname, "../.."));
    expect(offenders).toEqual([]);
  });
});
