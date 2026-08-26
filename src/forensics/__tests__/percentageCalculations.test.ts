import { describe, expect, it } from "vitest";
import {
  calculateAdjustedConcentration,
  calculateBundledAcquisitionPct,
  calculateCurrentHoldingsPct,
  calculateLargestHolderPct,
  calculatePercentage,
  sumAmounts,
} from "../percentageCalculations";

describe("sumAmounts", () => {
  it("sums bigint amounts across wallets", () => {
    expect(
      sumAmounts([
        { wallet: "A", amount: 100n },
        { wallet: "B", amount: 250n },
      ])
    ).toBe(350n);
  });

  it("returns 0n for an empty list", () => {
    expect(sumAmounts([])).toBe(0n);
  });
});

describe("calculatePercentage", () => {
  it("computes numerator/denominator * 100 with 4 decimal precision", () => {
    expect(calculatePercentage(400n, 1000n)).toBeCloseTo(40, 4);
    expect(calculatePercentage(1n, 3n)).toBeCloseTo(33.3333, 3);
  });

  it("returns undefined when the denominator is missing, never 0", () => {
    expect(calculatePercentage(100n, undefined)).toBeUndefined();
  });

  it("returns undefined for a zero or negative denominator", () => {
    expect(calculatePercentage(100n, 0n)).toBeUndefined();
    expect(calculatePercentage(100n, -5n)).toBeUndefined();
  });

  it("returns undefined for a negative numerator", () => {
    expect(calculatePercentage(-1n, 100n)).toBeUndefined();
  });
});

describe("calculateBundledAcquisitionPct / calculateCurrentHoldingsPct", () => {
  const wallets = [
    { wallet: "bundle1", amount: 300n },
    { wallet: "bundle2", amount: 100n },
  ];

  it("computes the percentage against a known denominator", () => {
    expect(calculateBundledAcquisitionPct(wallets, 1000n)).toBeCloseTo(40, 4);
    expect(calculateCurrentHoldingsPct(wallets, 2000n)).toBeCloseTo(20, 4);
  });

  it("returns undefined when the launch/current supply is unknown", () => {
    expect(calculateBundledAcquisitionPct(wallets, undefined)).toBeUndefined();
    expect(calculateCurrentHoldingsPct(wallets, undefined)).toBeUndefined();
  });
});

describe("calculateAdjustedConcentration", () => {
  const holders = [
    { wallet: "pool-vault", amount: 500n },
    { wallet: "holder1", amount: 200n },
    { wallet: "holder2", amount: 100n },
  ];

  it("excludes only positively-identified addresses", () => {
    const excluded = new Set(["pool-vault"]);
    expect(calculateAdjustedConcentration(holders, excluded, 1000n)).toBeCloseTo(30, 4);
  });

  it("does not exclude a large holder absent explicit evidence", () => {
    const excluded = new Set<string>();
    expect(calculateAdjustedConcentration(holders, excluded, 1000n)).toBeCloseTo(80, 4);
  });
});

describe("calculateLargestHolderPct", () => {
  it("finds the largest non-excluded holder", () => {
    const holders = [
      { wallet: "pool-vault", amount: 900n },
      { wallet: "whale", amount: 150n },
      { wallet: "small", amount: 10n },
    ];
    const excluded = new Set(["pool-vault"]);
    expect(calculateLargestHolderPct(holders, excluded, 1000n)).toBeCloseTo(15, 4);
  });

  it("returns undefined when every holder is excluded", () => {
    const holders = [{ wallet: "pool-vault", amount: 900n }];
    expect(calculateLargestHolderPct(holders, new Set(["pool-vault"]), 1000n)).toBeUndefined();
  });
});
