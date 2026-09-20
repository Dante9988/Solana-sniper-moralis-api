import { describe, expect, it } from "vitest";

import {
  QuoteExpiredError,
  QuoteMismatchError,
  assertExecutable,
  isQuoteFresh,
  makeAmount,
  toDecimalString,
  type BuyQuote,
  type QuoteRequest,
} from "../contract";
import { WBTC_ETHEREUM } from "../assetIdentity";

/**
 * Phase 7D.5.1 — the rules that stop someone approving one trade and signing another.
 */

const ETH = { network: "ethereum", kind: "native", address: null, decimals: 18, symbol: "ETH", name: "Ether" } as const;

const request: QuoteRequest = {
  input: ETH,
  output: WBTC_ETHEREUM,
  amountRaw: "1000000000000000000",
  slippageBps: 50,
  account: "0xaaaa000000000000000000000000000000000001",
};

function quote(over: Partial<BuyQuote> = {}): BuyQuote {
  return {
    quoteId: "q1",
    provider: "uniswap_v4",
    input: { asset: ETH, amount: makeAmount(request.amountRaw, ETH) },
    output: { asset: WBTC_ETHEREUM, expected: makeAmount("3000000", WBTC_ETHEREUM), minimumReceived: makeAmount("2985000", WBTC_ETHEREUM) },
    fees: [],
    slippageBps: 50,
    expiresAt: 10_000,
    requirements: [],
    disclosures: [],
    boundTo: {
      account: request.account,
      network: "ethereum",
      inputAsset: "ethereum:native",
      outputAsset: `ethereum:${WBTC_ETHEREUM.address}`,
      inputRaw: request.amountRaw,
      slippageBps: 50,
    },
    providerData: {},
    ...over,
  };
}

describe("amounts are decimal-safe", () => {
  it("converts base units without going through a float", () => {
    // 2^53 is ~9.007e15; an 18-decimal amount passes it routinely, and Number() would
    // silently round the figure the user is approving.
    expect(toDecimalString("1000000000000000000", 18)).toBe("1");
    expect(toDecimalString("1234567890123456789", 18)).toBe("1.234567890123456789");
    expect(toDecimalString("1", 18)).toBe("0.000000000000000001");
  });

  it("keeps BTC's 8 decimals exact", () => {
    expect(toDecimalString("2985000", 8)).toBe("0.02985");
    expect(toDecimalString("100000000", 8)).toBe("1");
  });

  it("handles zero-decimal assets and trims only trailing zeros", () => {
    expect(toDecimalString("42", 0)).toBe("42");
    expect(toDecimalString("1500000", 6)).toBe("1.5");
    expect(toDecimalString("0", 6)).toBe("0");
  });

  it("refuses anything that is not a base-unit integer", () => {
    expect(() => toDecimalString("1.5", 6)).toThrow();
    expect(() => toDecimalString("-1", 6)).toThrow();
    expect(() => toDecimalString("1e18", 18)).toThrow();
  });

  it("carries both forms so no caller has to re-derive one", () => {
    const amount = makeAmount("2985000", WBTC_ETHEREUM);
    expect(amount).toMatchObject({ raw: "2985000", decimal: "0.02985", decimals: 8, symbol: "WBTC" });
  });
});

describe("quotes bind to the trade they were made for", () => {
  it("expires, and an expired quote is refused rather than refreshed silently", () => {
    expect(isQuoteFresh(quote(), 9_999)).toBe(true);
    expect(isQuoteFresh(quote(), 10_001)).toBe(false);
    expect(() => assertExecutable(quote(), request, 10_001)).toThrow(QuoteExpiredError);
  });

  it("refuses when the signing account changed", () => {
    // A quote built for one wallet must never be signed by another: the output would land
    // somewhere the user never reviewed.
    const other = { ...request, account: "0xbbbb000000000000000000000000000000000002" };
    expect(() => assertExecutable(quote(), other, 0)).toThrow(QuoteMismatchError);
  });

  it.each([
    ["amount", { amountRaw: "2000000000000000000" }],
    ["slippage", { slippageBps: 100 }],
    ["output asset", { output: { ...WBTC_ETHEREUM, address: "0x1111111111111111111111111111111111111111" } }],
  ])("refuses when the %s changed", (_label, change) => {
    expect(() => assertExecutable(quote(), { ...request, ...(change as object) }, 0)).toThrow(QuoteMismatchError);
  });

  it("names what changed, because the user has to be told which number moved", () => {
    try {
      assertExecutable(quote(), { ...request, amountRaw: "5", slippageBps: 999 }, 0);
      throw new Error("should have refused");
    } catch (err) {
      expect((err as Error).message).toMatch(/amount/);
      expect((err as Error).message).toMatch(/slippage/);
    }
  });

  it("passes when nothing changed and the quote is fresh", () => {
    expect(() => assertExecutable(quote(), request, 0)).not.toThrow();
  });

  it("always carries a minimum received — the number that actually binds", () => {
    const q = quote();
    expect(q.output.minimumReceived.raw).toBeDefined();
    expect(BigInt(q.output.minimumReceived.raw)).toBeLessThanOrEqual(BigInt(q.output.expected.raw));
  });
});
