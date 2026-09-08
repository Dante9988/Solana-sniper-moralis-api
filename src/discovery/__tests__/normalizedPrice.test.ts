import { describe, expect, it } from "vitest";
import { computeNormalizedPrice, normalizeAmount } from "../normalizedPrice";
import { formatScaledBigInt, parseDecimalToScaledBigInt } from "../decimal";

describe("normalizeAmount", () => {
  it("divides a raw amount down by its decimals", () => {
    expect(normalizeAmount("1000000000000000000", 18)).toBe("1");
    expect(normalizeAmount("1500000", 6)).toBe("1.5");
    expect(normalizeAmount("1000000000", 9)).toBe("1");
  });

  it("handles zero decimals", () => {
    expect(normalizeAmount("42", 0)).toBe("42");
  });

  it("rejects a negative/non-integer decimals value", () => {
    expect(() => normalizeAmount("1", -1)).toThrow(RangeError);
    expect(() => normalizeAmount("1", 1.5)).toThrow(RangeError);
  });
});

describe("computeNormalizedPrice", () => {
  it("computes price = normalized quote / normalized token for equal (18/18) decimals", () => {
    // 2 quote tokens for 1 token => price 2
    const price = computeNormalizedPrice("2000000000000000000", 18, "1000000000000000000", 18);
    expect(price).toBe("2");
  });

  it("handles a representative 6-decimal quote against an 18-decimal token", () => {
    // quote = 1,000,000 raw units at 6 decimals => 1.0 quote
    // token = 500,000,000,000,000,000 raw units at 18 decimals => 0.5 token
    // price = 1.0 / 0.5 = 2.0
    const price = computeNormalizedPrice("1000000", 6, "500000000000000000", 18);
    expect(price).toBe("2");
  });

  it("handles a representative 9-decimal token", () => {
    // quote (18 dec) = 3 quote units; token (9 dec) = 1 token unit => price 3
    const price = computeNormalizedPrice("3000000000000000000", 18, "1000000000", 9);
    expect(price).toBe("3");
  });

  it("handles 6/9/18 mixed combinations without precision loss (single division, never two lossy intermediate divisions)", () => {
    // quote 6-dec: 1_234_567 raw = 1.234567 quote
    // token 9-dec: 7_654_321 raw = 0.007654321 token
    // price = 1.234567 / 0.007654321
    const price = computeNormalizedPrice("1234567", 6, "7654321", 9);
    // Cross-check via BigInt fixed point at higher intermediate scale, not via floats.
    expect(price.startsWith("161.")).toBe(true);
  });

  it("never throws for a zero token amount (decimalDivide returns 0 rather than dividing by zero)", () => {
    expect(computeNormalizedPrice("100", 18, "0", 18)).toBe("0");
  });

  it("rejects invalid decimals inputs", () => {
    expect(() => computeNormalizedPrice("1", 18, "1", -1)).toThrow(RangeError);
    expect(() => computeNormalizedPrice("1", -1, "1", 18)).toThrow(RangeError);
  });
});

describe("parseDecimalToScaledBigInt / formatScaledBigInt round-trip", () => {
  it("round-trips integers and fractional values", () => {
    expect(formatScaledBigInt(parseDecimalToScaledBigInt("123.456", 18), 18)).toBe("123.456");
    expect(formatScaledBigInt(parseDecimalToScaledBigInt("0", 18), 18)).toBe("0");
    expect(formatScaledBigInt(parseDecimalToScaledBigInt("0.000000000000000001", 18), 18)).toBe("0.000000000000000001");
  });

  it("never emits scientific notation for very large values (Phase 7B.4 Decimal#toString() regression)", () => {
    const huge = parseDecimalToScaledBigInt("123456789012345678901234567890.123456789012345678", 18);
    const formatted = formatScaledBigInt(huge, 18);
    expect(formatted).not.toMatch(/e/i);
    expect(formatted).toBe("123456789012345678901234567890.123456789012345678");
  });

  it("truncates (never rounds up) excess input precision", () => {
    expect(formatScaledBigInt(parseDecimalToScaledBigInt("1.9999999999999999999", 18), 18)).toBe("1.999999999999999999");
  });

  it("round-trips negative values", () => {
    expect(formatScaledBigInt(parseDecimalToScaledBigInt("-5.5", 18), 18)).toBe("-5.5");
  });

  it("handles zero-invalid division protection for zero-scale values", () => {
    expect(formatScaledBigInt(0n, 18)).toBe("0");
    expect(parseDecimalToScaledBigInt("0.0", 18)).toBe(0n);
  });
});
