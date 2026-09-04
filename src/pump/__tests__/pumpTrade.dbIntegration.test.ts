/**
 * Real-Postgres integration test for PumpTrade's dedup constraint and
 * restart-recovery idempotency (Phase 7B.3A1, no-mock completion policy —
 * "duplicate delivery test against PostgreSQL" and "process restart and
 * recovery test").
 *
 * Opt-in only: skipped unless `PUMP_RUN_DB_TESTS=true`, following the exact
 * convention already established by
 * src/services/__tests__/walletVerificationService.dbIntegration.test.ts.
 *
 * Run:
 *   PUMP_RUN_DB_TESTS=true DATABASE_URL=postgresql://... npx vitest run src/pump/__tests__/pumpTrade.dbIntegration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import fs from 'fs';
import path from 'path';
import { findEvents, RawTransactionLike } from '../eventWalker';
import { normalizeTradeEvent } from '../normalizeTrade';
import { eventIdentityOf } from '../eventIdentity';

const RUN_DB_TESTS = process.env.PUMP_RUN_DB_TESTS === 'true';

function loadFixture(name: string): RawTransactionLike {
  const raw = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures/mainnet', name), 'utf8'),
  );
  return raw.result as RawTransactionLike;
}

function toRow(trade: ReturnType<typeof normalizeTradeEvent>, identity: ReturnType<typeof eventIdentityOf>) {
  if (!trade) throw new Error('expected a normalized trade');
  return {
    venue: trade.venue,
    source: 'live_stream',
    mint: trade.mint,
    quoteMint: trade.quoteMint,
    signature: identity.signature,
    outerInstructionIndex: identity.outerInstructionIndex,
    innerPosition: identity.innerPosition,
    emittingProgram: identity.emittingProgram,
    slot: BigInt(trade.slot),
    blockTime: new Date(trade.blockTime * 1000),
    side: trade.side,
    tokenAmount: new Prisma.Decimal(trade.tokenAmount),
    quoteAmount: new Prisma.Decimal(trade.quoteAmount),
    trader: trade.trader,
    status: 'provisional',
  };
}

describe.skipIf(!RUN_DB_TESTS)('PumpTrade — real Postgres integration', () => {
  const prisma = new PrismaClient();

  beforeAll(async () => {
    await prisma.pumpTrade.deleteMany({ where: { signature: { in: [
      '4RHJQg6ETxiFHsxofroxeUcWsPLWmQS1epDySGijsk3jWUid6U3zGAUdXMgZsJUxT6w7iLrzgKwKngG9X1dMHF4W',
      'yk3jsbBcpY9rNhgfTaMXYAwKGFp983C1oDJWRgqFEf6qZsr9ThtsAG6Z1abqa7fWr5Rju4vcis6nRR1ZK6WLghJ',
    ] } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('rejects a duplicate delivery of the same trade via the unique identity constraint', async () => {
    const tx = loadFixture('pumpswap_buy.json');
    const events = findEvents(tx);
    const buyEvent = events.find((e) => e.eventName === 'BuyEvent')!;
    const trade = normalizeTradeEvent(buyEvent, tx, new Date().toISOString());
    const identity = eventIdentityOf(buyEvent);
    const row = toRow(trade, identity);

    const first = await prisma.pumpTrade.create({ data: row });
    expect(first.mint).toBe('bKU4TGmXxaMmcjL2htnSKfRT9Voig9KmPvo8Scupump');

    await expect(prisma.pumpTrade.create({ data: row })).rejects.toMatchObject({
      code: 'P2002', // Postgres unique-violation, surfaced by Prisma
    });

    const count = await prisma.pumpTrade.count({ where: { signature: row.signature } });
    expect(count).toBe(1); // exactly one row despite two delivery attempts
  });

  it('is idempotent across a simulated process restart (new PrismaClient instance, same identity)', async () => {
    // Simulates: the ingestion process recorded this trade, crashed before
    // acknowledging it upstream, restarted, and re-delivered the same
    // live-stream event. A fresh PrismaClient instance stands in for the
    // restarted process; the upsert-by-identity below must be a no-op, not
    // a second row.
    const buyTx = loadFixture('pumpswap_buy.json');
    const events = findEvents(buyTx);
    const buyEvent = events.find((e) => e.eventName === 'BuyEvent')!;
    const trade = normalizeTradeEvent(buyEvent, buyTx, new Date().toISOString());
    const identity = eventIdentityOf(buyEvent);
    const row = toRow(trade, identity);

    const restarted = new PrismaClient();
    try {
      await restarted.pumpTrade.upsert({
        where: {
          signature_outerInstructionIndex_innerPosition_emittingProgram: {
            signature: row.signature,
            outerInstructionIndex: row.outerInstructionIndex,
            innerPosition: row.innerPosition,
            emittingProgram: row.emittingProgram,
          },
        },
        create: row,
        update: {}, // already recorded pre-restart; re-delivery is a no-op, not a second row
      });
      const count = await restarted.pumpTrade.count({ where: { signature: row.signature } });
      expect(count).toBe(1);
    } finally {
      await restarted.$disconnect();
    }
  });
});
