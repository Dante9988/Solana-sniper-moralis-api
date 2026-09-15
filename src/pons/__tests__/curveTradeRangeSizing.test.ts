import { describe, expect, it } from "vitest";

import { isSizeFailure } from "../curveTradeListener";

describe("curve-trade log window sizing (Phase 7D.4)", () => {
  it("shrinks for size problems, not for rate limits or cooled-down endpoints", () => {
    expect(isSizeFailure("query returned more than 10000 results")).toBe(true);
    expect(isSizeFailure("eth_getLogs requests with up to a 10 block range")).toBe(true);
    expect(isSizeFailure("RPC Request failed.")).toBe(true);
    expect(isSizeFailure("request deadline of 20000ms exceeded across providers")).toBe(true);
    expect(isSizeFailure("rate limit exceeded")).toBe(false);
    expect(isSizeFailure("HTTP 429 Too Many Requests")).toBe(false);
    expect(isSizeFailure("no usable RPC endpoint is configured")).toBe(false);
  });
});
