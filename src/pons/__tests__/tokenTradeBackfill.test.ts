import { describe, expect, it, vi } from "vitest";

import { backfillTokenTrades } from "../backfill/tokenTradeBackfill";
import { TEST_CONFIG } from "./testSupport";

/**
 * Phase 7D.5 — per-token history is the difference between "we need an indexer" and "open
 * the chart".
 *
 * Chain-wide curve ingestion is a topic-only getLogs across every token: an indexer
 * workload that spent days crawling. One token's history is an address-filtered query the
 * node answers from an index — measured live on 2026-09-20, a token launched 5,147,728
 * blocks earlier returned all 9,784 of its trades in 11 requests.
 *
 * The property these tests protect is that filter. Drop the address and this silently
 * becomes the chain-wide scan again, still correct but thousands of times more expensive.
 */

/** getLogsByEvents call arguments, typed — vi.fn() infers an empty tuple otherwise. */
type LogQuery = { address?: string; fromBlock: bigint; toBlock: bigint };
const calls = (fn: { mock: { calls: unknown[][] } }): LogQuery[] => fn.mock.calls.map((c) => c[0] as LogQuery);

const TOKEN = "0xaaaa000000000000000000000000000000000001";
const CURVE = "0xcccc000000000000000000000000000000000002";
const QUOTE = "0x0000000000000000000000000000000000000000";

function deps(
  overrides: { logs?: unknown; head?: bigint; existing?: unknown; graduated?: boolean; poolId?: string; isToken0?: boolean; graduationSourceHeight?: bigint } = {}
) {
  const getLogsByEvents = vi.fn(async () => ({ status: "AVAILABLE", data: (overrides.logs as never[]) ?? [], source: "t", fetchedAt: new Date(), attempts: 1 }));
  const tokenRow = {
    tokenAddress: TOKEN,
    curveAddress: CURVE,
    quoteAddress: QUOTE,
    sourceHeight: 1_000_000n,
    graduated: overrides.graduated ?? false,
    canonicalStatus: "CANONICAL",
    poolId: overrides.poolId ?? null,
    isToken0: overrides.isToken0 ?? null,
    graduationSourceHeight: overrides.graduationSourceHeight ?? null,
  };
  const backfillRows = new Map<string, Record<string, unknown>>();
  if (overrides.existing) backfillRows.set(TOKEN, overrides.existing as Record<string, unknown>);

  const db = {
    discoveredToken: { findUnique: vi.fn(async () => tokenRow) },
    tokenTradeBackfill: {
      findUnique: vi.fn(async () => backfillRows.get(TOKEN) ?? null),
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => {
        backfillRows.set(TOKEN, { ...(backfillRows.get(TOKEN) ?? {}), ...create });
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        backfillRows.set(TOKEN, { ...(backfillRows.get(TOKEN) ?? {}), ...data });
      }),
    },
    candleInvalidation: { create: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<void>) => fn({ chainTrade: { upsert: vi.fn(async () => ({})) } })),
  };

  const getLogs = vi.fn(async () => ({ status: "AVAILABLE", data: [] as never[], source: "t", fetchedAt: new Date(), attempts: 1 }));
  const chainClient = {
    getBlockNumber: vi.fn(async () => ({ status: "AVAILABLE", data: overrides.head ?? 1_400_000n, source: "t", fetchedAt: new Date(), attempts: 1 })),
    getBlockRef: vi.fn(async () => ({ status: "AVAILABLE", data: { hash: "0xblock", timestamp: 1_789_000_000n }, source: "t", fetchedAt: new Date(), attempts: 1 })),
    getLogsByEvents,
    getLogs,
    readContract: vi.fn(async () => ({ status: "AVAILABLE", data: "0xpoolmanager", source: "t", fetchedAt: new Date(), attempts: 1 })),
  };

  return { db, chainClient, getLogsByEvents, getLogs, backfillRows, base: { db: db as never, chainClient: chainClient as never, config: TEST_CONFIG, v2FactoryAddress: "0xfactory" } };
}

describe("per-token trade backfill", () => {
  it("asks only for THIS token's curve address — the whole point", async () => {
    const d = deps();
    await backfillTokenTrades(d.base, TOKEN);

    expect(d.getLogsByEvents).toHaveBeenCalled();
    for (const call of calls(d.getLogsByEvents)) {
      expect(call.address, "a missing address filter is the chain-wide indexer scan again").toBe(CURVE);
    }
  });

  it("pages the range rather than asking for it all at once", async () => {
    const d = deps({ head: 3_000_000n });
    await backfillTokenTrades({ ...d.base, maxRange: 100_000n }, TOKEN);

    const widths = calls(d.getLogsByEvents).map((c) => c.toBlock - c.fromBlock + 1n);
    expect(widths.length).toBeGreaterThan(1);
    for (const w of widths) expect(w).toBeLessThanOrEqual(100_000n);
  });

  it("starts at the token's launch block, not at genesis", async () => {
    const d = deps();
    await backfillTokenTrades(d.base, TOKEN);
    expect(calls(d.getLogsByEvents)[0]!.fromBlock).toBe(1_000_000n);
  });

  it("stays behind the confirmation lag so it never fights the live listener for the tip", async () => {
    const d = deps({ head: 1_400_000n });
    const result = await backfillTokenTrades(d.base, TOKEN);
    expect(result.toBlock).toBe(1_400_000n - BigInt(TEST_CONFIG.confirmationLagBlocks));
  });

  it("resumes from the stored cursor instead of rescanning", async () => {
    const d = deps({ existing: { status: "PARTIAL", cursor: 1_200_000n, tradesWritten: 42, logsScanned: 99 } });
    const result = await backfillTokenTrades(d.base, TOKEN);

    expect(calls(d.getLogsByEvents)[0]!.fromBlock).toBe(1_200_001n);
    expect(result.tradesWritten).toBe(42);
  });

  it("does no chain work at all once a token is already covered", async () => {
    const head = 1_400_000n;
    const target = head - BigInt(TEST_CONFIG.confirmationLagBlocks);
    const d = deps({ head, existing: { status: "COMPLETE", cursor: target, tradesWritten: 9784, logsScanned: 9784 } });

    const result = await backfillTokenTrades(d.base, TOKEN);

    expect(result.status).toBe("COMPLETE");
    expect(d.getLogsByEvents, "an already-covered token must not re-scan").not.toHaveBeenCalled();
  });

  it("stops at its deadline and says where to resume, rather than hanging a request", async () => {
    const d = deps({ head: 50_000_000n });
    let t = 0;
    const result = await backfillTokenTrades({ ...d.base, maxRange: 1_000n, deadlineMs: 50, now: () => (t += 30) }, TOKEN);

    expect(result.status).toBe("PARTIAL");
    expect(result.stoppedReason).toMatch(/resume to continue from block/);
    expect(result.cursor).toBeLessThan(result.toBlock);
  });

  it("narrows the window when a provider refuses the range, instead of giving up", async () => {
    const d = deps({ head: 1_400_000n });
    d.getLogsByEvents
      .mockResolvedValueOnce({ status: "UNAVAILABLE", reason: "block range exceeds maximum allowed (max=10000, requested=400000)", code: "RPC_ERROR", source: "t", fetchedAt: new Date(), attempts: 1 } as never)
      .mockResolvedValue({ status: "AVAILABLE", data: [], source: "t", fetchedAt: new Date(), attempts: 1 } as never);

    const result = await backfillTokenTrades(d.base, TOKEN);

    expect(result.status).toBe("COMPLETE");
    const widths = calls(d.getLogsByEvents).map((c) => c.toBlock - c.fromBlock + 1n);
    expect(widths.length).toBeGreaterThan(1);
    expect(widths[1]!).toBeLessThan(widths[0]!);
  });

  it("says plainly when a graduated token's V4 swaps are NOT covered", async () => {
    // Graduated, but its pool identity was never resolved — so there is nothing to query.
    const d = deps({ graduated: true });
    const result = await backfillTokenTrades(d.base, TOKEN);

    expect(result.coveredVenues).toEqual(["PONS_V2_BONDING_CURVE"]);
    expect(result.uncoveredVenues, "a partial history must never look complete").toEqual(["UNISWAP_V4_POOL"]);
  });

  it("covers both venues for a graduated token whose pool is known", async () => {
    // A Pons token trades on its curve before graduation and its V4 pool after, so a
    // complete chart needs both legs. Verified live on 2026-09-18's QED: 80 curve trades
    // ending 17:49:26, then 5,481 pool trades starting 17:49:27.
    const d = deps({ graduated: true, poolId: "0xpool", isToken0: true, graduationSourceHeight: 1_100_000n });
    const result = await backfillTokenTrades(d.base, TOKEN);

    expect(result.coveredVenues).toEqual(["PONS_V2_BONDING_CURVE", "UNISWAP_V4_POOL"]);
    expect(result.uncoveredVenues).toEqual([]);
    // The V4 leg filters on the pool's own id, which is an indexed topic — still not a scan.
    const poolQueries = (d.getLogs.mock.calls as unknown[][]).map((c) => c[0] as { args?: { id?: string[] } });
    expect(poolQueries.length).toBeGreaterThan(0);
    for (const q of poolQueries) expect(q.args?.id).toEqual(["0xpool"]);
  });

  it("reports totals across BOTH venues, not just the curve leg", async () => {
    // First measured run reported 80 trades for a token that had received 5,561.
    const d = deps({ graduated: true, poolId: "0xpool", isToken0: true, graduationSourceHeight: 1_100_000n });
    const before = await backfillTokenTrades(d.base, TOKEN);
    expect(before.requests, "V4 requests must be counted too").toBeGreaterThan(
      d.getLogsByEvents.mock.calls.length - 1
    );
  });

  it("refuses a token with no known curve rather than scanning blindly", async () => {
    const d = deps();
    d.db.discoveredToken.findUnique = vi.fn(async () => ({
      tokenAddress: TOKEN,
      curveAddress: null,
      quoteAddress: QUOTE,
      sourceHeight: 1_000_000n,
      graduated: false,
      canonicalStatus: "CANONICAL",
    })) as never;

    const result = await backfillTokenTrades(d.base, TOKEN);

    expect(result.status).toBe("FAILED");
    expect(result.stoppedReason).toMatch(/no known curve address/);
    expect(d.getLogsByEvents).not.toHaveBeenCalled();
  });
});
