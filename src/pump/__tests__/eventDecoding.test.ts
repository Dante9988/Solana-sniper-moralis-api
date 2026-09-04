import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { findEvents, RawTransactionLike } from '../eventWalker';
import { eventIdentityOf, eventIdentityKey } from '../eventIdentity';
import { normalizeTradeEvent } from '../normalizeTrade';
import {
  decodePumpCreateEvent,
  decodePumpTradeEvent,
  decodePumpCompleteEvent,
  decodeCompletePumpAmmMigrationEvent,
} from '../eventDecoder';

const FIXTURES_DIR = path.join(__dirname, 'fixtures/mainnet');

function loadFixture(name: string): RawTransactionLike {
  const raw = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8'));
  return raw.result as RawTransactionLike;
}

describe('findEvents — real mainnet fixtures (Phase 7B.3A1)', () => {
  it('decodes CreateEvent + TradeEvent + CompleteEvent from one transaction, each with a unique identity', () => {
    const tx = loadFixture('pump_create_and_dev_buy_with_completion.json');
    const events = findEvents(tx);
    const names = events.map((e) => e.eventName).sort();
    expect(names).toEqual(['CompleteEvent', 'CreateEvent', 'TradeEvent']);

    const ids = events.map((e) => eventIdentityKey(eventIdentityOf(e)));
    expect(new Set(ids).size).toBe(ids.length); // all unique

    const trade = events.find((e) => e.eventName === 'TradeEvent')!;
    const decoded = decodePumpTradeEvent(trade.payload);
    expect(decoded.mint).toBe('bKU4TGmXxaMmcjL2htnSKfRT9Voig9KmPvo8Scupump');
    expect(decoded.isBuy).toBe(true);
    expect(decoded.realTokenReserves).toBe('0'); // the curve-exhausting buy

    const complete = events.find((e) => e.eventName === 'CompleteEvent')!;
    const decodedComplete = decodePumpCompleteEvent(complete.payload);
    expect(decodedComplete.mint).toBe('bKU4TGmXxaMmcjL2htnSKfRT9Voig9KmPvo8Scupump');

    const create = events.find((e) => e.eventName === 'CreateEvent')!;
    const decodedCreate = decodePumpCreateEvent(create.payload);
    expect(decodedCreate.symbol).toBe('WOFI');
    expect(decodedCreate.tokenTotalSupply).toBe('1000000000000000');
  });

  it('decodes 3 events from 2 different programs in one MigrateV2 transaction, each with a distinct identity', () => {
    const tx = loadFixture('pump_migrate_v2_atomic_pool_creation.json');
    const events = findEvents(tx);
    const names = events.map((e) => e.eventName).sort();
    expect(names).toEqual(['CompletePumpAmmMigrationEvent', 'CreatePoolEvent', 'InitBoostEvent']);

    const programs = new Set(events.map((e) => e.emittingProgram));
    expect(programs.size).toBe(2); // Pump.fun AND PumpSwap both emit in this one tx

    const ids = events.map((e) => eventIdentityKey(eventIdentityOf(e)));
    expect(new Set(ids).size).toBe(3);

    const migration = events.find((e) => e.eventName === 'CompletePumpAmmMigrationEvent')!;
    const decoded = decodeCompletePumpAmmMigrationEvent(migration.payload);
    expect(decoded.mint).toBe('bKU4TGmXxaMmcjL2htnSKfRT9Voig9KmPvo8Scupump');
    expect(decoded.pool).toBe('D3XknHGytS2yLQNxAJ5EcMjEAT11JKRY6EM5E4jNwFPF'); // canonical PumpSwap pool, named directly by the event
  });

  it('attributes a routed Pump.fun sell to Pump.fun as emittingProgram, not the router', () => {
    const tx = loadFixture('pump_sell_via_router.json');
    const events = findEvents(tx);
    expect(events.length).toBe(1);
    expect(events[0].eventName).toBe('TradeEvent');
    expect(events[0].emittingProgram).toBe('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

    const trade = normalizeTradeEvent(events[0], tx, '2026-09-04T00:00:00.000Z');
    expect(trade?.side).toBe('sell');
    expect(trade?.venue).toBe('pump');
  });

  it('produces zero events for a failed transaction, even though "Instruction: Sell" appears in its logs', () => {
    const tx = loadFixture('pumpswap_sell_FAILED_slippage.json');
    expect(tx.meta.err).not.toBeNull();
    const events = findEvents(tx);
    expect(events).toEqual([]);
  });

  it('normalizes a direct PumpSwap Buy with the correct fee-adjusted quoteAmount and mint resolved from the call accounts', () => {
    const tx = loadFixture('pumpswap_buy.json');
    const events = findEvents(tx);
    expect(events.length).toBe(1);
    expect(events[0].eventName).toBe('BuyEvent');

    const trade = normalizeTradeEvent(events[0], tx, '2026-09-04T00:00:00.000Z');
    expect(trade).not.toBeNull();
    expect(trade!.mint).toBe('bKU4TGmXxaMmcjL2htnSKfRT9Voig9KmPvo8Scupump');
    expect(trade!.quoteMint).toBe('So11111111111111111111111111111111111111112');
    expect(trade!.tokenAmount).toBe('41527'); // matches the real on-chain token-account balance delta
    // VERIFIED against the real fixture: quote_amount_in (259656) does NOT match
    // the user's real SOL debit; userQuoteAmountIn (260436) does, net of the
    // 20000-lamport tx fee. This assertion is the regression test for that
    // correction (7B.3A0 round 2, item 1).
    expect(trade!.quoteAmount).toBe('260436');
  });

  it('resolves mint for a PumpSwap Sell routed through another program (not the outer instruction)', () => {
    const tx = loadFixture('pumpswap_sell_via_arb_route.json');
    const events = findEvents(tx);
    const sell = events.find((e) => e.eventName === 'SellEvent');
    expect(sell).toBeDefined();

    const trade = normalizeTradeEvent(sell!, tx, '2026-09-04T00:00:00.000Z');
    expect(trade).not.toBeNull();
    expect(trade!.side).toBe('sell');
    // Resolved via the nested PumpSwap Sell call's own accounts (stack-based
    // resolution), not the outer router instruction's accounts.
    expect(trade!.mint).toBe('6qdzMx4c9rL2X3Ns3SwZ8uEo4zReDPjdXpAEmpo7pump');
    expect(trade!.quoteMint).toBe('So11111111111111111111111111111111111111112');
  });
});
