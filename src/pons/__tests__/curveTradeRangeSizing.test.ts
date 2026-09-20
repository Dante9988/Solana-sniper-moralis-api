import { describe, expect, it } from "vitest";

import { classifyWindowFailure } from "../curveTradeListener";

/**
 * Phase 7D.5. The original classifier answered a single yes/no and counted viem's generic
 * "Request failed" — its wording for *any* non-2xx — as proof the window was too wide.
 * Measured on 2026-09-19 against the live chain, the window collapsed 1875 → 10 blocks and
 * stayed pinned there: curve-trade ingestion advanced ~35 blocks/s against a 6.3M-block
 * backlog while the provider was serving 10,000-block windows at ~3,000 blocks/s.
 *
 * So the question is now three-way, and only a provider actually naming a range or result
 * cap is allowed to narrow the window permanently.
 */
describe("curve-trade log window sizing", () => {
  it("treats an explicit provider range or result cap as hard evidence", () => {
    expect(classifyWindowFailure("query returned more than 10000 results")).toBe("RANGE");
    expect(classifyWindowFailure("Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range")).toBe("RANGE");
    // The wide-range provider's own wording, captured live on 2026-09-19.
    expect(classifyWindowFailure("block range exceeds maximum allowed (max=10000, requested=50001)")).toBe("RANGE");
    expect(classifyWindowFailure("log response size exceeded")).toBe("RANGE");
    // viem's client-side cap, hit live on 2026-09-19 at a 10,000-block curve-trade window.
    expect(classifyWindowFailure("HTTP response body exceeded the size limit.\n\nMax: 10485760 bytes")).toBe("RANGE");
  });

  it("treats a timeout as a soft signal — narrow to make progress, but remember nothing", () => {
    expect(classifyWindowFailure("request deadline of 20000ms exceeded across providers")).toBe("SOFT");
    expect(classifyWindowFailure("the request timed out")).toBe("SOFT");
  });

  it("never narrows for throttling, cooldowns or a missing endpoint", () => {
    expect(classifyWindowFailure("rate limit exceeded")).toBe("NONE");
    expect(classifyWindowFailure("HTTP 429 Too Many Requests")).toBe("NONE");
    expect(classifyWindowFailure("no usable RPC endpoint is configured")).toBe("NONE");
    expect(classifyWindowFailure("every endpoint is in cooldown")).toBe("NONE");
  });

  it("narrows without remembering when the capable endpoint is transiently cooled down", () => {
    // FailoverChainClient's wording when a range cap came only from endpoints narrower than
    // the one that sat out. Treating it as hard evidence pinned the window at the floor;
    // treating it as nothing at all stalled ingestion completely for 11 minutes. SOFT makes
    // progress at a smaller width and springs back on the first clean tick.
    const reason =
      "no usable RPC endpoint for this request right now: 3 of 4 endpoint(s) in cooldown, " +
      "and every endpoint tried caps eth_getLogs to a narrower window than asked";
    expect(classifyWindowFailure(reason)).toBe("SOFT");
  });

  it("still does nothing when no endpoint is configured at all — that is not a width problem", () => {
    expect(classifyWindowFailure("no usable RPC endpoint is configured")).toBe("NONE");
  });

  it("no longer narrows for a bare transport failure — the bug that pinned the window", () => {
    // viem says this for a 403, a 500, a socket reset: nothing to do with width.
    expect(classifyWindowFailure("RPC Request failed.")).toBe("NONE");
    expect(classifyWindowFailure("HTTP request failed.")).toBe("NONE");
  });
});
