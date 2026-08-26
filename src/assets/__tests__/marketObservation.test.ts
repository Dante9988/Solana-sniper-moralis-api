import { describe, expect, it } from "vitest";
import { createMarketObservation, ObservationValidationError } from "../marketObservation";
import { AssetIdentity } from "../types";

const asset: AssetIdentity = {
  chain: "SOLANA", chainId: "solana-mainnet", address: "So11111111111111111111111111111111111111112",
  normalizedAddress: "So11111111111111111111111111111111111111112",
};

describe("createMarketObservation", () => {
  it("creates a complete provider-neutral observation and preserves raw evidence", () => {
    const rawPayload = { providerRecord: "abc" };
    const result = createMarketObservation({
      asset, observationKey: "swap:signature:1", observedAt: new Date("2026-08-25T00:00:00Z"),
      source: "moralis-swap", provider: "MORALIS", priceUsd: 1, estimatedBuyPriceUsd: 1.01,
      estimatedSellPriceUsd: 0.99, liquidityUsd: 100, marketCapUsd: 1000, fdvUsd: 1200,
      volume24hUsd: 50, rawPayload,
    });
    expect(result).toMatchObject({ type: "MARKET", priceUsd: 1, estimatedBuyPriceUsd: 1.01, estimatedSellPriceUsd: 0.99 });
    expect(result.rawPayload).toBe(rawPayload);
  });

  it("keeps unavailable values undefined rather than manufacturing zeroes", () => {
    const result = createMarketObservation({ asset, observationKey: "discovery:event-1", observedAt: new Date(), source: "listener" });
    expect(result.priceUsd).toBeUndefined();
    expect(result.liquidityUsd).toBeUndefined();
    expect(result.volume24hUsd).toBeUndefined();
  });

  it.each([NaN, Infinity, -1])("rejects invalid numeric value %s", (priceUsd) => {
    expect(() => createMarketObservation({ asset, observationKey: "key", observedAt: new Date(), source: "test", priceUsd })).toThrow(ObservationValidationError);
  });

  it("requires stable source evidence and a valid timestamp", () => {
    expect(() => createMarketObservation({ asset, observationKey: " ", observedAt: new Date(), source: "test" })).toThrow("observationKey");
    expect(() => createMarketObservation({ asset, observationKey: "key", observedAt: new Date("invalid"), source: "test" })).toThrow("observedAt");
  });
});
