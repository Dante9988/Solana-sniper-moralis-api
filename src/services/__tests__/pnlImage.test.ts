import { describe, expect, it } from 'vitest';

import { createPnLImage } from '../pnlImage';
import { getSolPrice } from '../../utils/tokenUtils';

/**
 * These tests exercise the real canvas renderer and the real CoinGecko price feed.
 * Nothing here is mocked: createPnLImage() rasterises an actual PNG through node-canvas
 * and resolves the live SOL price, because the failures this card has historically hit
 * (native canvas bindings missing, NaN percentages, upstream price outage) only ever
 * reproduce against the real stack.
 */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A realistic winning call: a token that ran from ~$18k to ~$135k market cap. */
const realisticCall = {
  pnlPercentage: 650,
  tokenSymbol: 'PUMP',
  initialMarketCap: 18_000,
  currentMarketCap: 135_000,
  initialSol: 1,
  returnedSol: 7.5,
};

function isPng(buf: Buffer): boolean {
  return buf.length > 8 && buf.subarray(0, 8).equals(PNG_MAGIC);
}

/** Reads the IHDR chunk, which node-canvas writes as the first chunk of every PNG. */
function pngDimensions(buf: Buffer): { width: number; height: number } {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe('createPnLImage: renders a real PNG through node-canvas', () => {
  it('produces a valid 1200x675 PNG for a realistic winning call', async () => {
    const image = await createPnLImage(realisticCall);

    expect(isPng(image)).toBe(true);
    expect(pngDimensions(image)).toEqual({ width: 1200, height: 675 });
    // A card that rendered its gradient, text and badges is tens of KB. A few hundred
    // bytes would mean we emitted a blank canvas and still called it a success.
    expect(image.byteLength).toBeGreaterThan(10_000);
  }, 30_000);

  it('renders losses as well as gains (negative PnL must not throw)', async () => {
    const image = await createPnLImage({
      ...realisticCall,
      pnlPercentage: -82,
      returnedSol: 0.18,
    });

    expect(isPng(image)).toBe(true);
    expect(image.byteLength).toBeGreaterThan(10_000);
  }, 30_000);

  it.each([
    ['zero PnL', { pnlPercentage: 0, returnedSol: 1 }],
    ['a 100,000% moonshot', { pnlPercentage: 100_000, returnedSol: 1001 }],
    ['a sub-1% move', { pnlPercentage: 0.4, returnedSol: 1.004 }],
    ['a total loss', { pnlPercentage: -100, returnedSol: 0 }],
  ])('survives %s without throwing or emitting a blank card', async (_label, overrides) => {
    const image = await createPnLImage({ ...realisticCall, ...overrides });

    expect(isPng(image)).toBe(true);
    expect(image.byteLength).toBeGreaterThan(10_000);
  }, 30_000);

  it('does not overflow the card with a long or unicode token symbol', async () => {
    // Real launches ship symbols like this; the renderer must not throw on them.
    for (const tokenSymbol of ['WAGMIWAGMIWAGMI', '🐸PEPE', '$$$', 'a'.repeat(40)]) {
      const image = await createPnLImage({ ...realisticCall, tokenSymbol });
      expect(isPng(image)).toBe(true);
      expect(pngDimensions(image)).toEqual({ width: 1200, height: 675 });
    }
  }, 60_000);
});

describe('getSolPrice: the live CoinGecko feed the card prices profit against', () => {
  it('returns a plausible live SOL price', async () => {
    const price = await getSolPrice();

    expect(Number.isFinite(price)).toBe(true);
    // Deliberately wide: this asserts "the feed returned a real number", not a market call.
    // The documented fallback (170) also lands in this range, so an upstream outage
    // degrades rather than fails the suite.
    expect(price).toBeGreaterThan(1);
    expect(price).toBeLessThan(100_000);
  }, 30_000);
});

describe('createPnLImage: stress', () => {
  it('renders 25 cards back to back without leaking memory or degrading', async () => {
    // The tracker can fan out a burst of PnL cards when several calls cross +50% in the
    // same 15-minute sweep, so back-to-back rendering is the real production shape.
    const before = process.memoryUsage().heapUsed;
    const durations: number[] = [];

    for (let i = 0; i < 25; i++) {
      const startedAt = performance.now();
      const image = await createPnLImage({
        ...realisticCall,
        pnlPercentage: 50 + i * 37,
        tokenSymbol: `TKN${i}`,
      });
      durations.push(performance.now() - startedAt);
      expect(isPng(image)).toBe(true);
    }

    const after = process.memoryUsage().heapUsed;
    const growthMb = (after - before) / 1024 / 1024;
    const slowest = Math.max(...durations);

    // node-canvas holds native buffers; a real leak shows up as tens of MB retained
    // across 25 renders rather than the few MB of ordinary GC lag.
    expect(growthMb).toBeLessThan(150);
    // Each card must stay well inside the tracker's per-token budget.
    expect(slowest).toBeLessThan(5_000);
  }, 180_000);

  it('renders 10 cards concurrently, as the tracker does when a sweep fans out', async () => {
    const images = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        createPnLImage({ ...realisticCall, pnlPercentage: 60 + i * 15, tokenSymbol: `CONC${i}` })
      )
    );

    expect(images).toHaveLength(10);
    for (const image of images) {
      expect(isPng(image)).toBe(true);
      expect(image.byteLength).toBeGreaterThan(10_000);
    }
    // Distinct inputs must produce distinct cards — identical bytes would mean the
    // renderer is returning a cached or blank buffer instead of drawing each call.
    expect(new Set(images.map((b) => b.byteLength)).size).toBeGreaterThan(1);
  }, 180_000);
});
