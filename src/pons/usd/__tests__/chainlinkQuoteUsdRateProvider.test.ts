import { describe, expect, it } from "vitest";

import type { ChainClientResult, ChainReader } from "../../chainClient";
import { ChainlinkQuoteUsdRateProvider, lookupQuoteAsset, scaleAnswer } from "../chainlinkQuoteUsdRateProvider";

/** Phase 7D.4 §3 — Chainlink USD valuation, against a simulated aggregator. */

const ETH_FEED = lookupQuoteAsset("0x0000000000000000000000000000000000000000")!.feed!;
const NOW = 1_800_000_000;
const PHASE = 1n << 64n;

const ok = <T>(data: T): ChainClientResult<T> => ({ status: "AVAILABLE", data, source: "fake", fetchedAt: new Date(), attempts: 1 });
const fail = <T>(reason: string): ChainClientResult<T> => ({ status: "UNAVAILABLE", source: "fake", fetchedAt: new Date(), code: "RPC_ERROR", reason, attempts: 1 });

function fakeFeed(opts: { rounds: Array<{ id: bigint; answer: bigint; updatedAt: number }>; description?: string; decimals?: number; headAge?: number }) {
  const calls = { getRoundData: 0 };
  const byId = new Map(opts.rounds.map((r) => [r.id, r]));
  const latest = opts.rounds[opts.rounds.length - 1];
  const tuple = (r: { id: bigint; answer: bigint; updatedAt: number }) => [r.id, r.answer, BigInt(r.updatedAt), BigInt(r.updatedAt), r.id] as const;
  const reader: ChainReader = {
    getBlockNumber: async () => ok(100n),
    getBlockRef: async () => ok({ number: 100n, hash: "0xh", timestamp: BigInt(NOW - (opts.headAge ?? 2)) }),
    getTransaction: async () => fail("n/a"),
    getLogs: async () => fail("n/a"),
    readContract: (async (p: { functionName: string; args: readonly unknown[] }) => {
      switch (p.functionName) {
        case "description": return ok(opts.description ?? "ETH / USD");
        case "decimals": return ok(opts.decimals ?? 8);
        case "latestRoundData": return ok(tuple(latest));
        case "getRoundData": {
          calls.getRoundData += 1;
          const r = byId.get(p.args[0] as bigint);
          return r ? ok(tuple(r)) : fail("no round");
        }
        default: return fail("unexpected");
      }
    }) as ChainReader["readContract"],
  };
  return { reader, calls };
}

const rounds = [
  { id: PHASE + 10n, answer: 200_000_000_000n, updatedAt: NOW - 30_000 },
  { id: PHASE + 11n, answer: 210_000_000_000n, updatedAt: NOW - 20_000 },
  { id: PHASE + 12n, answer: 250_715_297_917n, updatedAt: NOW - 1_000 },
];
const ETH = { chain: "robinhood", quoteAddress: "0x0000000000000000000000000000000000000000" };

describe("ChainlinkQuoteUsdRateProvider", () => {
  it("scales answers exactly", () => {
    expect(scaleAnswer(250_715_297_917n, 8)).toBe("2507.15297917");
    expect(scaleAnswer(99_997_035n, 8)).toBe("0.99997035");
    expect(scaleAnswer(100_000_000n, 8)).toBe("1");
  });

  it("values a trade with the round in force at the trade's time, not today's price", async () => {
    const { reader } = fakeFeed({ rounds });
    const provider = new ChainlinkQuoteUsdRateProvider({ chainClient: reader, now: () => NOW });
    const past = await provider.getHistoricalRate({ ...ETH, at: new Date((NOW - 15_000) * 1000) });
    expect(past.status).toBe("AVAILABLE");
    if (past.status === "AVAILABLE") {
      expect(past.rate.rateUsdPerQuote).toBe("2100");
      expect(past.rate.source).toContain(ETH_FEED.proxy);
    }
    const recent = await provider.getHistoricalRate({ ...ETH, at: new Date((NOW - 10) * 1000) });
    expect(recent.status === "AVAILABLE" && recent.rate.rateUsdPerQuote).toBe("2507.15297917");
  });

  it("refuses a price older than the heartbeat at that time", async () => {
    const { reader } = fakeFeed({ rounds: [{ id: PHASE + 5n, answer: 1n * 10n ** 11n, updatedAt: NOW - 200_000 }] });
    const result = await new ChainlinkQuoteUsdRateProvider({ chainClient: reader, now: () => NOW }).getHistoricalRate({ ...ETH, at: new Date(NOW * 1000) });
    expect(result.status).toBe("UNAVAILABLE");
    if (result.status === "UNAVAILABLE") expect(result.reason).toMatch(/stale/);
  });

  it("refuses when the feed's on-chain identity differs from the registry", async () => {
    const { reader } = fakeFeed({ rounds, description: "BTC / USD" });
    const result = await new ChainlinkQuoteUsdRateProvider({ chainClient: reader, now: () => NOW }).getHistoricalRate({ ...ETH, at: new Date(NOW * 1000) });
    expect(result.status).toBe("UNAVAILABLE");
  });

  it("withholds USD while the chain is not producing blocks", async () => {
    const { reader } = fakeFeed({ rounds, headAge: 3_600 });
    const result = await new ChainlinkQuoteUsdRateProvider({ chainClient: reader, now: () => NOW }).getHistoricalRate({ ...ETH, at: new Date(NOW * 1000) });
    expect(result.status === "UNAVAILABLE" && result.reason).toMatch(/sequencer/);
  });

  it("does not identify a quote asset by anything but a registered address", async () => {
    const { reader } = fakeFeed({ rounds });
    const result = await new ChainlinkQuoteUsdRateProvider({ chainClient: reader, now: () => NOW }).getHistoricalRate({ chain: "robinhood", quoteAddress: "0x1111111111111111111111111111111111111111", at: new Date(NOW * 1000) });
    expect(result.status).toBe("UNAVAILABLE");
  });

  it("reports history before the current aggregator phase as unreachable instead of guessing", async () => {
    const { reader } = fakeFeed({ rounds: [{ id: PHASE + 1n, answer: 2n * 10n ** 11n, updatedAt: NOW - 100 }] });
    const result = await new ChainlinkQuoteUsdRateProvider({ chainClient: reader, now: () => NOW }).getHistoricalRate({ ...ETH, at: new Date((NOW - 5_000) * 1000) });
    expect(result.status === "UNAVAILABLE" && result.reason).toMatch(/not reachable/);
  });

  it("caches settled rounds so repeated lookups do not re-read the chain", async () => {
    const { reader, calls } = fakeFeed({ rounds });
    const provider = new ChainlinkQuoteUsdRateProvider({ chainClient: reader, now: () => NOW });
    await provider.getHistoricalRate({ ...ETH, at: new Date((NOW - 25_000) * 1000) });
    const first = calls.getRoundData;
    await provider.getHistoricalRate({ ...ETH, at: new Date((NOW - 25_000) * 1000) });
    expect(calls.getRoundData).toBe(first);
  });
});
