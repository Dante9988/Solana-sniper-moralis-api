import { describe, expect, it } from "vitest";
import { NullQuoteUsdRateProvider } from "../usdPricing";

describe("NullQuoteUsdRateProvider", () => {
  it("always reports UNAVAILABLE, never a fabricated rate", async () => {
    const provider = new NullQuoteUsdRateProvider();
    const result = await provider.getHistoricalRate({ chain: "robinhood", quoteAddress: "0xabc", at: new Date() });
    expect(result.status).toBe("UNAVAILABLE");
    if (result.status === "UNAVAILABLE") {
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it("exposes a stable, non-secret provider name", () => {
    const provider = new NullQuoteUsdRateProvider();
    expect(provider.name).not.toMatch(/https?:\/\//);
  });
});
