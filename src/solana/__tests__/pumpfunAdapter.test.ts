/**
 * Phase 7E.4.3 §18 (unit) — CreateEvent, TradeEvent and lifecycle mapping, plus event identity.
 *
 * Every case runs against a REAL mainnet transaction already pinned in
 * src/pump/__tests__/fixtures/mainnet (see its SOURCE.md for provenance). No transaction is
 * hand-constructed here: a synthetic fixture would pass while proving nothing about the chain, and
 * the layouts these mappings depend on are exactly what a synthetic fixture would get to invent.
 */

import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import { findEvents } from "../../pump/eventWalker";
import type { RawTransactionLike } from "../../pump/eventWalker";
import { eventIdentityKey, eventIdentityOf } from "../../pump/eventIdentity";
import { decodeSolanaSourceIndex, encodeSolanaSourceIndex, pumpfunAdapter } from "../pumpfunAdapter";
import type { RawPumpfunEvent } from "../pumpfunAdapter";
import { decodePumpfunTransaction, mintsNeedingDecimals } from "../pumpfunDecode";

const FIXTURES = path.join(__dirname, "../../pump/__tests__/fixtures/mainnet");

function loadFixture(name: string): RawTransactionLike {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8")).result as RawTransactionLike;
}

/** The create/dev-buy/completion transaction: one tx carrying three different Pump.fun events. */
const CREATE_FIXTURE = "pump_create_and_dev_buy_with_completion.json";
const MIGRATE_FIXTURE = "pump_migrate_v2_atomic_pool_creation.json";
const FAILED_FIXTURE = "pumpswap_sell_FAILED_slippage.json";

const MINT = "bKU4TGmXxaMmcjL2htnSKfRT9Voig9KmPvo8Scupump";
const BLOCK = { slot: 444127554, blockhash: "FixtureBlockhash11111111111111111111111111111", blockTime: 1788487825 };
const OBSERVED_AT = "2026-09-26T00:00:00.000Z";

function rawEventsFor(fixture: string, decimals: Map<string, number | null> = new Map()): RawPumpfunEvent[] {
  const tx = loadFixture(fixture);
  const envelopes = findEvents(tx);
  return envelopes.map((envelope) => ({
    envelope,
    tx,
    siblings: envelopes,
    block: BLOCK,
    observedAt: OBSERVED_AT,
    confidence: "provisional" as const,
    tokenDecimals: decimals.get(MINT) ?? null,
    quoteDecimals: null,
  }));
}

describe("source index packing", () => {
  it("round-trips, including the -1 inner-position sentinel", () => {
    for (const [outer, inner] of [
      [0, -1],
      [0, 0],
      [2, 22],
      [4, 8],
      [381, 4094],
    ] as const) {
      expect(decodeSolanaSourceIndex(encodeSolanaSourceIndex(outer, inner))).toEqual({
        outerInstructionIndex: outer,
        innerPosition: inner,
      });
    }
  });

  it("gives two events in one transaction two different indexes", () => {
    // The whole reason the pair is packed rather than truncated to the outer index: this fixture's
    // buy emits a TradeEvent and a CompleteEvent under the SAME outer instruction. Collapsing them
    // would make one silently overwrite the other through ChainTrade's unique constraint.
    const events = rawEventsFor(CREATE_FIXTURE).filter((r) => r.envelope.eventName !== "CreateEvent");
    const indexes = events.map((r) => encodeSolanaSourceIndex(r.envelope.outerInstructionIndex, r.envelope.innerPosition));
    expect(indexes.length).toBeGreaterThan(1);
    expect(new Set(indexes).size).toBe(indexes.length);
  });

  it("refuses an out-of-range position rather than colliding", () => {
    expect(() => encodeSolanaSourceIndex(-1, 0)).toThrow(/non-negative/);
    expect(() => encodeSolanaSourceIndex(0, -2)).toThrow(/innerPosition/);
    expect(() => encodeSolanaSourceIndex(0, 4095)).toThrow(/innerPosition/);
    expect(() => encodeSolanaSourceIndex(600_000, 0)).toThrow(/32-bit/);
  });
});

describe("CreateEvent -> DiscoveredToken", () => {
  const create = rawEventsFor(CREATE_FIXTURE, new Map([[MINT, 6]])).find((r) => r.envelope.eventName === "CreateEvent")!;

  it("maps the token's identity and provenance onto the canonical contract", () => {
    const token = pumpfunAdapter.decodeTokenDiscovered(create)!;
    expect(token.chain).toBe("solana");
    expect(token.venue).toBe("pumpfun");
    expect(token.tokenAddress).toBe(MINT);
    expect(token.provenance.sourceHeight).toBe(String(BLOCK.slot));
    expect(token.provenance.sourceHash).toBe(BLOCK.blockhash);
    expect(token.provenance.sourceTxHash).toBe(create.envelope.signature);
    expect(token.observedAt).toBe(OBSERVED_AT);
  });

  it("carries name, symbol and metadata URI straight off the event, with no fetch", () => {
    const token = pumpfunAdapter.decodeTokenDiscovered(create)!;
    expect(token.metadata?.name).toBeTruthy();
    expect(token.metadata?.symbol).toBeTruthy();
    expect(token.metadata?.metadataUri).toMatch(/^https?:\/\//);
    expect(token.metadata?.curveAddress).toBeTruthy();
    // A bonding curve is not a pool; the pool address must stay null until graduation names one.
    expect(token.poolAddress).toBeNull();
  });

  it("records the dev buy from the same transaction as initialBuyAmount", () => {
    const token = pumpfunAdapter.decodeTokenDiscovered(create)!;
    // This fixture's create is followed by a Buy in the same transaction; the amount must be that
    // buy's token amount, matched by mint and side rather than by position.
    const trades = rawEventsFor(CREATE_FIXTURE).filter((r) => r.envelope.eventName === "TradeEvent");
    const devBuy = pumpfunAdapter.decodeTrade(trades[0])!;
    expect(token.initialBuyAmount).toBe(devBuy.tokenAmount);
    expect(BigInt(token.initialBuyAmount)).toBeGreaterThan(0n);
  });

  it("reports unknown decimals as null rather than defaulting to 6", () => {
    const withoutDecimals = { ...create, tokenDecimals: null, quoteDecimals: null };
    const token = pumpfunAdapter.decodeTokenDiscovered(withoutDecimals)!;
    expect(token.metadata?.tokenDecimals).toBeNull();
    expect(token.metadata?.quoteDecimals).toBeNull();
    // Missing metadata must not block discovery — the token is still returned.
    expect(token.tokenAddress).toBe(MINT);
  });

  it("names the mints whose decimals must be read before decoding", () => {
    const needed = mintsNeedingDecimals(loadFixture(CREATE_FIXTURE));
    expect(needed.tokenMints).toContain(MINT);
    expect(needed.quoteMints.length).toBeGreaterThan(0);
  });
});

describe("TradeEvent -> ChainTrade", () => {
  it("copies normalizeTrade's units without reinterpreting them", () => {
    const tradeEvent = rawEventsFor(CREATE_FIXTURE).find((r) => r.envelope.eventName === "TradeEvent")!;
    const trade = pumpfunAdapter.decodeTrade(tradeEvent)!;
    expect(trade.chain).toBe("solana");
    expect(trade.venue).toBe("pump");
    expect(trade.tokenAddress).toBe(MINT);
    expect(trade.side).toBe("buy");
    // Exact integers, as the chain reported them — never scaled here.
    expect(trade.tokenAmount).toMatch(/^\d+$/);
    expect(trade.quoteAmount).toMatch(/^\d+$/);
    // priceQuote is the raw ratio, the same convention every other venue's adapter uses.
    expect(Number(trade.priceQuote)).toBeGreaterThan(0);
    // USD is never computed at decode time — it needs a dated rate the adapter has no access to.
    expect(trade.priceUsd).toBeNull();
  });

  it("returns null for a non-trade event instead of inventing one", () => {
    const complete = rawEventsFor(CREATE_FIXTURE).find((r) => r.envelope.eventName === "CompleteEvent")!;
    expect(pumpfunAdapter.decodeTrade(complete)).toBeNull();
  });
});

describe("lifecycle mapping", () => {
  it("CreateEvent means bonding, and names no destination", () => {
    const create = rawEventsFor(CREATE_FIXTURE).find((r) => r.envelope.eventName === "CreateEvent")!;
    const transition = pumpfunAdapter.decodeLifecycle(create)!;
    expect(transition.phase).toBe("bonding_curve");
    expect(transition.eventType).toBe("created");
    expect(transition.destinationVenue).toBeNull();
    expect(transition.destinationPool).toBeNull();
  });

  it("CompleteEvent means the curve finished — NOT graduated, and names no pool", () => {
    const complete = rawEventsFor(CREATE_FIXTURE).find((r) => r.envelope.eventName === "CompleteEvent")!;
    const transition = pumpfunAdapter.decodeLifecycle(complete)!;
    expect(transition.phase).toBe("bonding_complete");
    expect(transition.eventType).toBe("completed");
    // The whole point of §12: this event proves nothing about a destination pool, so claiming one
    // would be a fabrication. Both stay null.
    expect(transition.destinationVenue).toBeNull();
    expect(transition.destinationPool).toBeNull();
    expect(transition.phase).not.toBe("pumpswap");
  });

  it("CompletePumpAmmMigrationEvent means graduated, and proves the destination pool", () => {
    const migration = rawEventsFor(MIGRATE_FIXTURE).find((r) => r.envelope.eventName === "CompletePumpAmmMigrationEvent")!;
    const transition = pumpfunAdapter.decodeLifecycle(migration)!;
    expect(transition.phase).toBe("pumpswap");
    expect(transition.eventType).toBe("migrated");
    expect(transition.destinationVenue).toBe("pumpswap");
    expect(transition.destinationPool).toBeTruthy();
    expect(transition.curveAddress).toBeTruthy();
    // §13's migration contract: everything a later social/outbox consumer needs, without RPC.
    expect(transition.payload.pool).toBe(transition.destinationPool);
    expect(transition.payload.mintAmount).toMatch(/^\d+$/);
    expect(transition.payload.solAmount).toMatch(/^\d+$/);
    expect(transition.eventTimestamp).toMatch(/^\d{4}-/);
  });

  it("keeps the event's own timestamp separate from the block's", () => {
    const create = rawEventsFor(CREATE_FIXTURE).find((r) => r.envelope.eventName === "CreateEvent")!;
    const transition = pumpfunAdapter.decodeLifecycle(create)!;
    // Both exist; neither is substituted for the other.
    expect(transition.eventTimestamp).not.toBeNull();
    expect(transition.provenance.sourceHeight).toBe(String(BLOCK.slot));
  });

  it("marks a pre-finalized observation provisional, so nothing irreversible can act on it", () => {
    const create = rawEventsFor(CREATE_FIXTURE).find((r) => r.envelope.eventName === "CreateEvent")!;
    expect(pumpfunAdapter.decodeLifecycle(create)!.confidence).toBe("provisional");
    expect(pumpfunAdapter.decodeLifecycle({ ...create, confidence: "final" })!.confidence).toBe("final");
  });
});

describe("decodePumpfunTransaction", () => {
  it("produces a token, a trade and two lifecycle transitions from one real transaction", () => {
    const batch = decodePumpfunTransaction({
      tx: loadFixture(CREATE_FIXTURE),
      block: BLOCK,
      observedAt: OBSERVED_AT,
      confidence: "provisional",
      decimals: new Map([[MINT, 6]]),
    });
    expect(batch.discovered.map((d) => d.tokenAddress)).toEqual([MINT]);
    expect(batch.trades).toHaveLength(1);
    expect(batch.lifecycle.map((l) => l.phase).sort()).toEqual(["bonding_complete", "bonding_curve"]);
    expect(batch.slot).toBe(BLOCK.slot);
    // Every mapped event has a distinct canonical identity.
    expect(new Set(batch.identities).size).toBe(batch.identities.length);
  });

  it("yields nothing for a FAILED transaction, which still prints instruction logs", () => {
    // The fixture's logs say "Instruction: Sell" but no event ever fired. A listener that trusted
    // the logs would invent a trade out of a transaction the chain rejected.
    const batch = decodePumpfunTransaction({
      tx: loadFixture(FAILED_FIXTURE),
      block: BLOCK,
      observedAt: OBSERVED_AT,
      confidence: "final",
      decimals: new Map(),
    });
    expect(batch.discovered).toHaveLength(0);
    expect(batch.trades).toHaveLength(0);
    expect(batch.lifecycle).toHaveLength(0);
  });

  it("counts PumpSwap's own events as unmapped rather than dropping them unnoticed", () => {
    // The migration transaction also carries PumpSwap's CreatePoolEvent/InitBoostEvent, which this
    // phase does not map (§14 adds them). They must still be visible in the counters.
    const batch = decodePumpfunTransaction({
      tx: loadFixture(MIGRATE_FIXTURE),
      block: BLOCK,
      observedAt: OBSERVED_AT,
      confidence: "final",
      decimals: new Map(),
    });
    expect(batch.unmappedEventNames.length).toBeGreaterThan(0);
    expect(batch.lifecycle.map((l) => l.phase)).toContain("pumpswap");
  });

  it("gives the same answer twice — decode is pure, so replay is safe", () => {
    const params = {
      tx: loadFixture(CREATE_FIXTURE),
      block: BLOCK,
      observedAt: OBSERVED_AT,
      confidence: "provisional" as const,
      decimals: new Map([[MINT, 6]]),
    };
    expect(JSON.stringify(decodePumpfunTransaction(params))).toBe(JSON.stringify(decodePumpfunTransaction(params)));
  });
});

describe("event identity", () => {
  it("is stable across re-decodes of the same transaction", () => {
    const first = findEvents(loadFixture(CREATE_FIXTURE)).map((e) => eventIdentityKey(eventIdentityOf(e)));
    const second = findEvents(loadFixture(CREATE_FIXTURE)).map((e) => eventIdentityKey(eventIdentityOf(e)));
    expect(second).toEqual(first);
  });
});
