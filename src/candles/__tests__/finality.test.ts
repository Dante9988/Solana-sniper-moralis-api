import { describe, expect, it } from "vitest";
import { determineCandleStatus } from "../finality";

describe("determineCandleStatus", () => {
  const bucketStart = 1_700_000_000; // arbitrary unix seconds, 1m resolution => bucket ends at +60

  it("is provisional when there is no trade-checkpoint evidence at all", () => {
    expect(determineCandleStatus(bucketStart, "1m", { tradeLastHeightTimestamp: null, unresolvedReorg: false })).toBe("provisional");
  });

  it("is provisional while confirmed ingestion progress has not reached the bucket's end", () => {
    const notYet = new Date((bucketStart + 30) * 1000); // inside the bucket, not past its end
    expect(determineCandleStatus(bucketStart, "1m", { tradeLastHeightTimestamp: notYet, unresolvedReorg: false })).toBe("provisional");
  });

  it("becomes final once confirmed ingestion progress is at or past the bucket's end", () => {
    const exactlyAtEnd = new Date((bucketStart + 60) * 1000);
    expect(determineCandleStatus(bucketStart, "1m", { tradeLastHeightTimestamp: exactlyAtEnd, unresolvedReorg: false })).toBe("final");

    const wellPast = new Date((bucketStart + 600) * 1000);
    expect(determineCandleStatus(bucketStart, "1m", { tradeLastHeightTimestamp: wellPast, unresolvedReorg: false })).toBe("final");
  });

  it("never becomes final while a reorg is unresolved, even with confirmed progress far past the bucket", () => {
    const wellPast = new Date((bucketStart + 600) * 1000);
    expect(determineCandleStatus(bucketStart, "1m", { tradeLastHeightTimestamp: wellPast, unresolvedReorg: true })).toBe("provisional");
  });

  it("is never merely wall-clock derived: a bucket far in the past with no checkpoint evidence still reports provisional, not final", () => {
    const longAgoBucket = 0; // 1970-01-01
    expect(determineCandleStatus(longAgoBucket, "1s", { tradeLastHeightTimestamp: null, unresolvedReorg: false })).toBe("provisional");
  });

  it("resolution width changes the bucket-end threshold", () => {
    const justPast1s = new Date((bucketStart + 1) * 1000);
    expect(determineCandleStatus(bucketStart, "1s", { tradeLastHeightTimestamp: justPast1s, unresolvedReorg: false })).toBe("final");
    expect(determineCandleStatus(bucketStart, "1h", { tradeLastHeightTimestamp: justPast1s, unresolvedReorg: false })).toBe("provisional");
  });
});
