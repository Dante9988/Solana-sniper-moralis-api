import { PrismaClient } from "@prisma/client";
import axios from "axios";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiServer } from "../server";
import { loadApiConfig } from "../config";
import { CALLOUT_MIN_PNL_PERCENTAGE, parseLimit, toMultiple } from "../routes/callouts";

/**
 * Integration coverage for `/api/v1/callouts`.
 *
 * This suite deliberately avoids a mocked Prisma client and hand-written fixtures.
 * It runs against the real Postgres named by DATABASE_URL and seeds rows from live
 * DexScreener market data for real Solana mints, because the bugs worth catching here
 * — Float/Decimal coercion, ordering under ties, real market caps overflowing the
 * multiple calculation — only appear with a real driver and real magnitudes.
 *
 * If Postgres or DexScreener is unreachable the suite fails loudly rather than
 * silently degrading to mocks: a green run must mean the real path was exercised.
 */

/** Real Solana mints with deep, long-lived liquidity, so DexScreener always has a pair. */
const REAL_MINTS = [
  { symbol: "WIF", name: "dogwifhat", mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm" },
  { symbol: "JUP", name: "Jupiter", mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN" },
  { symbol: "POPCAT", name: "Popcat", mint: "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr" },
];

const TEST_RUN_TAG = `callouts-it-${Date.now()}`;

interface LiveMarket {
  symbol: string;
  name: string;
  mint: string;
  priceUsd: number;
  fdv: number;
}

async function fetchLiveMarket(entry: (typeof REAL_MINTS)[number]): Promise<LiveMarket> {
  const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${entry.mint}`, {
    timeout: 20_000,
  });
  const pairs: any[] = res.data?.pairs ?? [];
  const deepest = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  if (!deepest?.priceUsd || !deepest?.fdv) {
    throw new Error(`DexScreener returned no usable pair for ${entry.symbol} (${entry.mint})`);
  }
  return {
    ...entry,
    priceUsd: Number(deepest.priceUsd),
    fdv: Number(deepest.fdv),
  };
}

const db = new PrismaClient();
let app: ReturnType<typeof createApiServer>;
let live: LiveMarket[];
/** mint -> the seeded row's true pnlPercentage, so assertions compare against real values. */
const seededPnl = new Map<string, number>();

beforeAll(async () => {
  await db.$connect();

  live = await Promise.all(REAL_MINTS.map(fetchLiveMarket));

  // Seed one verified callout per real token. `currentMarketCap` is the live FDV;
  // `initialMarketCap` is derived from it so the recorded PnL is internally consistent
  // with real magnitudes rather than invented round numbers.
  for (const [i, market] of live.entries()) {
    const multiple = 2 + i * 3.5; // 2x, 5.5x, 9x — all above the 50% share threshold
    const initialMarketCap = market.fdv / multiple;
    const pnlPercentage = (multiple - 1) * 100;
    seededPnl.set(market.mint, pnlPercentage);

    await db.tokenAlert.create({
      data: {
        tokenAddress: market.mint,
        tokenSymbol: market.symbol,
        tokenName: `${market.name} [${TEST_RUN_TAG}]`,
        initialMarketCap,
        initialPrice: market.priceUsd / multiple,
        currentMarketCap: market.fdv,
        currentPrice: market.priceUsd,
        pnlPercentage,
        checked: true,
        pnlAlerted: true,
        checkTimestamp: new Date(),
      },
    });
  }

  // A checked-but-flat call, which must never surface as a callout.
  await db.tokenAlert.create({
    data: {
      tokenAddress: `FLAT${TEST_RUN_TAG}`,
      tokenSymbol: "FLAT",
      tokenName: `flat [${TEST_RUN_TAG}]`,
      initialMarketCap: 25_000,
      initialPrice: 0.000025,
      currentMarketCap: 26_000,
      currentPrice: 0.000026,
      pnlPercentage: 4,
      checked: true,
      pnlAlerted: false,
      checkTimestamp: new Date(),
    },
  });

  // An unchecked call: the tracker has not verified it, so it is not yet a callout.
  await db.tokenAlert.create({
    data: {
      tokenAddress: `UNCHECKED${TEST_RUN_TAG}`,
      tokenSymbol: "UNCH",
      tokenName: `unchecked [${TEST_RUN_TAG}]`,
      initialMarketCap: 30_000,
      initialPrice: 0.00003,
      pnlPercentage: 900,
      checked: false,
    },
  });

  process.env.API_PUBLIC_READS = "true";
  // Raise the read limiter for the throughput test below; the limiter itself is
  // covered separately with its own app instance and its own low limit.
  process.env.PRESENTATION_RATE_LIMIT_PER_MIN = "500";
  app = createApiServer(db, loadApiConfig());
}, 120_000);

afterAll(async () => {
  await db.tokenAlert.deleteMany({ where: { tokenName: { contains: TEST_RUN_TAG } } });
  await db.$disconnect();
});

describe("GET /api/v1/callouts (real Postgres + live DexScreener market data)", () => {
  it("returns the seeded real-token callouts, ordered best first", async () => {
    const res = await request(app).get("/api/v1/callouts").expect(200);

    expect(res.body.apiVersion).toBe(1);
    const mine = res.body.callouts.filter((c: any) =>
      live.some((m) => m.mint === c.tokenAddress)
    );
    expect(mine).toHaveLength(live.length);

    const percentages = mine.map((c: any) => c.pnlPercentage);
    expect(percentages).toEqual([...percentages].sort((a, b) => b - a));
  }, 60_000);

  it("reports the real live market cap and a multiple consistent with it", async () => {
    const res = await request(app).get("/api/v1/callouts?limit=100").expect(200);

    for (const market of live) {
      const row = res.body.callouts.find((c: any) => c.tokenAddress === market.mint);
      expect(row, `${market.symbol} missing from callouts`).toBeDefined();

      // Round-trips the live FDV through Postgres Float without precision loss.
      expect(row.currentMarketCap).toBeCloseTo(market.fdv, 0);
      expect(row.pnlPercentage).toBeCloseTo(seededPnl.get(market.mint)!, 6);
      // multiple and pnlPercentage are two views of the same number.
      expect(row.multiple).toBeCloseTo(row.pnlPercentage / 100 + 1, 6);
      expect(row.shared).toBe(true);
      expect(row.verifiedAt).not.toBeNull();
    }
  }, 60_000);

  it("excludes flat calls below the share threshold and unverified calls", async () => {
    const res = await request(app).get("/api/v1/callouts?limit=100").expect(200);

    const addresses = res.body.callouts.map((c: any) => c.tokenAddress);
    expect(addresses).not.toContain(`FLAT${TEST_RUN_TAG}`);
    expect(addresses).not.toContain(`UNCHECKED${TEST_RUN_TAG}`);
    for (const c of res.body.callouts) {
      expect(c.pnlPercentage).toBeGreaterThanOrEqual(CALLOUT_MIN_PNL_PERCENTAGE);
    }
  }, 60_000);

  it("honours ?limit and rejects nonsense values instead of silently defaulting", async () => {
    const limited = await request(app).get("/api/v1/callouts?limit=2").expect(200);
    expect(limited.body.callouts.length).toBeLessThanOrEqual(2);

    for (const bad of ["0", "-5", "abc", "1.5"]) {
      await request(app).get(`/api/v1/callouts?limit=${bad}`).expect(400);
    }
  }, 60_000);

  it("returns per-token history, and 404s for a token with no verified callouts", async () => {
    const wif = live.find((m) => m.symbol === "WIF")!;
    const ok = await request(app).get(`/api/v1/callouts/${wif.mint}`).expect(200);
    expect(ok.body.callouts.length).toBeGreaterThan(0);
    expect(ok.body.callouts[0].tokenAddress).toBe(wif.mint);

    await request(app).get(`/api/v1/callouts/UNCHECKED${TEST_RUN_TAG}`).expect(404);
  }, 60_000);
});

describe("GET /api/v1/callouts — stress against real Postgres", () => {
  const BULK = 250;
  const bulkTag = `${TEST_RUN_TAG}-bulk`;

  beforeAll(async () => {
    // A realistic backlog: a few hundred verified calls accumulated by the tracker.
    await db.tokenAlert.createMany({
      data: Array.from({ length: BULK }, (_, i) => ({
        tokenAddress: `BULK${i}-${bulkTag}`,
        tokenSymbol: `BLK${i}`,
        tokenName: `bulk ${i} [${bulkTag}]`,
        initialMarketCap: 20_000 + i,
        initialPrice: 0.00002,
        currentMarketCap: (20_000 + i) * (1 + i / 10),
        currentPrice: 0.0002,
        pnlPercentage: 50 + i,
        checked: true,
        pnlAlerted: true,
        checkTimestamp: new Date(),
      })),
    });
  }, 120_000);

  afterAll(async () => {
    await db.tokenAlert.deleteMany({ where: { tokenName: { contains: bulkTag } } });
  });

  it("never returns more than the 100-row cap, however large ?limit is", async () => {
    const res = await request(app).get("/api/v1/callouts?limit=100000").expect(200);
    expect(res.body.callouts.length).toBeLessThanOrEqual(100);
  }, 60_000);

  it("serves 40 concurrent reads over a few hundred rows within budget", async () => {
    const startedAt = performance.now();
    const responses = await Promise.all(
      Array.from({ length: 40 }, () => request(app).get("/api/v1/callouts?limit=100"))
    );
    const elapsed = performance.now() - startedAt;

    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.body.callouts.length).toBeLessThanOrEqual(100);
    }
    // Indexed reads of a few hundred rows; generous, but catches a table scan or an
    // N+1 creeping into the handler.
    expect(elapsed).toBeLessThan(20_000);
  }, 120_000);

  it("sheds load with 429 once the configured per-minute read limit is exceeded", async () => {
    // A separate app with a deliberately low limit: bursts must be rejected cleanly
    // rather than being queued or taking the process down.
    const previous = process.env.PRESENTATION_RATE_LIMIT_PER_MIN;
    process.env.PRESENTATION_RATE_LIMIT_PER_MIN = "5";
    const limitedApp = createApiServer(db, loadApiConfig());
    process.env.PRESENTATION_RATE_LIMIT_PER_MIN = previous;

    const responses = await Promise.all(
      Array.from({ length: 25 }, () => request(limitedApp).get("/api/v1/callouts"))
    );
    const statuses = responses.map((r) => r.status);

    expect(statuses).toContain(200);
    expect(statuses).toContain(429);
    // Nothing should fall through to a 500 under burst.
    expect(statuses.every((s) => s === 200 || s === 429)).toBe(true);
  }, 120_000);

  it("keeps ordering stable and correct across the full backlog", async () => {
    const res = await request(app).get("/api/v1/callouts?limit=100").expect(200);
    const percentages = res.body.callouts.map((c: any) => c.pnlPercentage);
    expect(percentages).toEqual([...percentages].sort((a, b) => b - a));
    expect(percentages[0]).toBeGreaterThanOrEqual(percentages[percentages.length - 1]);
  }, 60_000);
});

describe("callouts pure helpers", () => {
  it("parseLimit clamps, defaults, and rejects non-positive integers", () => {
    expect(parseLimit(undefined)).toBe(25);
    expect(parseLimit("10")).toBe(10);
    expect(parseLimit("100000")).toBe(100);
    expect(parseLimit("0")).toBeNull();
    expect(parseLimit("-1")).toBeNull();
    expect(parseLimit("abc")).toBeNull();
    expect(parseLimit("2.5")).toBeNull();
  });

  it("toMultiple returns null rather than Infinity/NaN for unusable inputs", () => {
    expect(toMultiple(10_000, 75_000)).toBeCloseTo(7.5, 6);
    expect(toMultiple(0, 75_000)).toBeNull();
    expect(toMultiple(-1, 75_000)).toBeNull();
    expect(toMultiple(10_000, null)).toBeNull();
    expect(toMultiple(10_000, Number.NaN)).toBeNull();
  });
});
