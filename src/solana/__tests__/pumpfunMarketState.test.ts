/**
 * Phase 7E.4.4 — the Pump.fun market state is derived from real mainnet events only. Every
 * expectation below was computed from, and is pinned to, a fixture in
 * src/pump/__tests__/fixtures/mainnet; nothing here is a hand-built transaction.
 */

import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import { findEvents } from "../../pump/eventWalker";
import type { RawTransactionLike } from "../../pump/eventWalker";
import { decodePumpfunTransaction } from "../pumpfunDecode";
import { curveProgressBps, marketCapQuote, observeCurveTrade, observePoolTrade, priceQuoteX36 } from "../pumpfunMarketState";

const FIXTURES = path.join(__dirname, "../../pump/__tests__/fixtures/mainnet");
const load = (name: string) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8")).result as RawTransactionLike;

/** The Global account read on mainnet, 2026-09-27 (see pumpfunMarketState.ts). */
const GLOBAL_INITIAL_REAL_TOKEN_RESERVES = 793_100_000_000_000n;

describe("Pump.fun bonding progress (per-token, from the event's own reserves)", () => {
  it("reads 100% at the trade that completes the curve, recovering the Global's initial real reserves to within rounding", () => {
    const tx = load("pump_create_and_dev_buy_with_completion.json");
    const trade = findEvents(tx).find((e) => e.eventName === "TradeEvent")!;
    const observation = observeCurveTrade(trade)!;
    expect(observation.progressBps).toBe(10_000);
    expect(observation.curveComplete).toBe(true);
    expect(observation.venue).toBe("PUMPFUN_BONDING_CURVE");

    // The cross-check: initialVirtualToken − unsellable recovers the Global value for this token, to
    // 1,810 base units (0.0018 tokens of 793.1M) — Pump rounds each curve trade, so k drifts slightly.
    const vq = 115_005_359_057n, vt = 279_900_000_000_000n, rq = 85_005_359_057n, rt = 0n;
    const initialVirtualToken = (vq * vt) / (vq - rq);
    expect(initialVirtualToken - (vt - rt) - GLOBAL_INITIAL_REAL_TOKEN_RESERVES).toBe(1_810n);
  });

  it("reads ~0% for a token created under DIFFERENT curve parameters, where the Global value would go negative", () => {
    const tx = load("pump_sell_via_router.json");
    const trade = findEvents(tx).find((e) => e.eventName === "TradeEvent")!;
    const observation = observeCurveTrade(trade)!;
    // realTokenReserves 794,005,723,745,124 > the Global's 793.1M: a Global-based formula is wrong here.
    expect(observation.progressBps).toBe(0);
    expect(observation.curveComplete).toBe(false);
  });

  it("fails closed on reserves no constant-product curve can have", () => {
    expect(curveProgressBps({ virtualQuote: 0n, virtualToken: 1n, realQuote: 0n, realToken: 0n })).toBeNull();
    expect(curveProgressBps({ virtualQuote: 10n, virtualToken: 10n, realQuote: 11n, realToken: 0n })).toBeNull();
    expect(curveProgressBps({ virtualQuote: 10n, virtualToken: 10n, realQuote: 10n, realToken: 0n })).toBeNull();
    expect(curveProgressBps({ virtualQuote: 10n, virtualToken: 10n, realQuote: 0n, realToken: 11n })).toBeNull();
  });
});

describe("Pump.fun curves quoted in a non-SOL mint", () => {
  it("reads the curve from the quote reserves — the SOL reserves are zero there", () => {
    const tx = load("pump_trade_non_sol_quote.json");
    const observation = observeCurveTrade(findEvents(tx).find((e) => e.eventName === "TradeEvent")!)!;
    expect(observation.quoteReserve).toBe(892_043_238_102n);
    expect(observation.realQuote).toBe(3_611_082_819n);
    expect(priceQuoteX36(observation)).toBeGreaterThan(0n);
    // (888,432,155,283 initial virtual quote) — a small, real, non-zero progress.
    expect(observation.progressBps).toBeGreaterThan(0);
    expect(observation.progressBps).toBeLessThan(100);
  });

  it("gives the same answer for a SOL curve, where the two reserve pairs are equal", () => {
    const tx = load("pump_create_and_dev_buy_with_completion.json");
    const observation = observeCurveTrade(findEvents(tx).find((e) => e.eventName === "TradeEvent")!)!;
    expect(observation.quoteReserve).toBe(115_005_359_057n);
    expect(observation.realQuote).toBe(85_005_359_057n);
  });
});

describe("Pump.fun price and market cap", () => {
  it("prices the curve at virtualQuote / virtualToken and values total supply at that price", () => {
    const tx = load("pump_create_and_dev_buy_with_completion.json");
    const observation = observeCurveTrade(findEvents(tx).find((e) => e.eventName === "TradeEvent")!)!;
    expect(priceQuoteX36(observation)).toBe((115_005_359_057n * 10n ** 36n) / 279_900_000_000_000n);
    // 1B tokens (6 dp) at that price, in lamports: ≈ 410.88 SOL.
    expect(marketCapQuote(observation, 1_000_000_000_000_000n)).toBe(410_880_168_120n);
  });
});

describe("PumpSwap pool state", () => {
  it("uses the pool vaults' POST-trade balances, not the event's pre-trade reserves", () => {
    const tx = load("pumpswap_buy.json");
    const envelope = findEvents(tx).find((e) => e.eventName === "BuyEvent")!;
    const observation = observePoolTrade(
      envelope,
      "bKU4TGmXxaMmcjL2htnSKfRT9Voig9KmPvo8Scupump",
      "So11111111111111111111111111111111111111112",
      tx.meta.postTokenBalances
    )!;
    expect(observation.venue).toBe("PUMPSWAP_POOL");
    // Post: base 1,679,228,363,498 / quote 10,482,126,905,280 (event said pre: …405,025 / …645,104).
    expect(observation.tokenReserve).toBe(1_679_228_363_498n);
    expect(observation.quoteReserve).toBe(10_482_126_905_280n);
    expect(observation.progressBps).toBeNull();
  });

  it("refuses to guess when the named quote mint has no vault in the transaction", () => {
    const tx = load("pumpswap_buy.json");
    const envelope = findEvents(tx).find((e) => e.eventName === "BuyEvent")!;
    expect(observePoolTrade(envelope, "bKU4TGmXxaMmcjL2htnSKfRT9Voig9KmPvo8Scupump", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", tx.meta.postTokenBalances)).toBeNull();
  });
});

describe("decode attaches each trade's market state to that trade", () => {
  it("keys the observation by the trade's canonical sourceIndex", () => {
    const tx = load("pump_create_and_dev_buy_with_completion.json");
    const batch = decodePumpfunTransaction({
      tx,
      block: { slot: tx.slot, blockhash: "fixture", blockTime: tx.blockTime },
      observedAt: "2026-09-27T00:00:00.000Z",
      confidence: "final",
      decimals: new Map([
        ["bKU4TGmXxaMmcjL2htnSKfRT9Voig9KmPvo8Scupump", 6],
        ["11111111111111111111111111111111", 9],
      ]),
    });
    expect(batch.trades.length).toBe(1);
    const observation = batch.marketObservations?.get(batch.trades[0].provenance.sourceIndex);
    expect(observation?.mint).toBe(batch.trades[0].tokenAddress);
    expect(observation?.progressBps).toBe(10_000);
  });
});
