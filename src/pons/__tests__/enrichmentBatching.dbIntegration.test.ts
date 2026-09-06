/**
 * Phase 7B.5A §4/§10 — batch discovery enrichment tests: bounded
 * concurrency under a launch burst, and partial-enrichment-failure
 * handling that never discards a good discovery just because a different
 * token's getLaunchedToken() call failed.
 *
 * Run:
 *   PONS_RUN_DB_TESTS=true DATABASE_URL=postgresql://... npx vitest run src/pons/__tests__/enrichmentBatching.dbIntegration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { DiscoveryListener, DISCOVERY_CHECKPOINT_SOURCE, ROBINHOOD_CHAIN } from "../discoveryListener";
import { TEST_CONFIG, FakeChainReader, makeTokenLaunchedLog, nextTestAddress, withReadContractConcurrencyTracking } from "./testSupport";

const RUN_DB_TESTS = process.env.PONS_RUN_DB_TESTS === "true";
const CHAIN = ROBINHOOD_CHAIN;

describe.skipIf(!RUN_DB_TESTS)("batch discovery enrichment — real Postgres integration", () => {
  const prisma = new PrismaClient();
  const seededTokens = new Set<string>();

  async function cleanup() {
    const tokens = [...seededTokens];
    if (tokens.length > 0) {
      await prisma.chainTrade.deleteMany({ where: { chain: CHAIN, tokenAddress: { in: tokens } } });
      await prisma.discoveredToken.deleteMany({ where: { chain: CHAIN, tokenAddress: { in: tokens } } });
    }
    await prisma.chainIngestionCheckpoint.deleteMany({ where: { source: DISCOVERY_CHECKPOINT_SOURCE } });
    await prisma.chainBlockCheckpoint.deleteMany({ where: { chain: CHAIN } });
    seededTokens.clear();
  }

  beforeAll(cleanup);
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });
  beforeEach(cleanup);

  it("a launch burst enriches with bounded concurrency and persists every token", async () => {
    const BURST_SIZE = 12;
    const logs = Array.from({ length: BURST_SIZE }, (_, i) => {
      const token = nextTestAddress();
      const pool = nextTestAddress();
      seededTokens.add(token);
      return makeTokenLaunchedLog({ token, pool, blockNumber: 10n + BigInt(i), txHash: `0xburst-${i}`, logIndex: 0 });
    });

    const fakeChain = new FakeChainReader(50n);
    fakeChain.logsByRange = logs;

    let observedPeak = 0;
    const trackedChain = withReadContractConcurrencyTracking(fakeChain, (peak) => {
      observedPeak = Math.max(observedPeak, peak);
    });

    const listener = new DiscoveryListener({ chainClient: trackedChain, db: prisma, config: TEST_CONFIG });
    const result = await listener.runOnce();

    expect(result.status).toBe("PROCESSED");
    if (result.status !== "PROCESSED") throw new Error("expected PROCESSED");
    expect(result.tokensDiscovered).toBe(BURST_SIZE);
    expect(result.tokensPendingEnrichment).toBe(0);

    // Never unbounded: peak concurrent getLaunchedToken() calls stayed at
    // or below the configured limit, but more than 1 — proving it actually
    // fanned out rather than degrading to fully serial.
    expect(observedPeak).toBeLessThanOrEqual(TEST_CONFIG.enrichmentConcurrency);
    expect(observedPeak).toBeGreaterThan(1);

    const rows = await prisma.discoveredToken.findMany({ where: { chain: CHAIN, tokenAddress: { in: [...seededTokens] } } });
    expect(rows).toHaveLength(BURST_SIZE);
    for (const row of rows) {
      expect(row.enrichmentStatus).toBe("COMPLETE");
      expect(row.canonicalStatus).toBe("CANONICAL");
      expect(row.supply?.toFixed()).toBe("1000000000000000000000000000");
    }
  });

  it("one bad token's enrichment failure does not discard the other good discoveries in the same tick", async () => {
    const good1 = nextTestAddress();
    const bad1 = nextTestAddress();
    const good2 = nextTestAddress();
    const bad2 = nextTestAddress();
    const good3 = nextTestAddress();
    for (const t of [good1, bad1, good2, bad2, good3]) seededTokens.add(t);

    const fakeChain = new FakeChainReader(50n);
    fakeChain.logsByRange = [good1, bad1, good2, bad2, good3].map((token, i) => makeTokenLaunchedLog({ token, pool: nextTestAddress(), blockNumber: 10n + BigInt(i), txHash: `0xpartial-${i}`, logIndex: 0 }));
    fakeChain.enrichmentByAddress.set(bad1, "FAIL");
    fakeChain.enrichmentByAddress.set(bad2, "FAIL");

    const listener = new DiscoveryListener({ chainClient: fakeChain, db: prisma, config: TEST_CONFIG });
    const result = await listener.runOnce();

    expect(result.status).toBe("PROCESSED");
    if (result.status !== "PROCESSED") throw new Error("expected PROCESSED");
    expect(result.tokensDiscovered).toBe(5); // every log was still decoded and persisted
    expect(result.tokensPendingEnrichment).toBe(2);

    const rows = await prisma.discoveredToken.findMany({ where: { chain: CHAIN, tokenAddress: { in: [good1, bad1, good2, bad2, good3] } } });
    expect(rows).toHaveLength(5); // nothing discarded
    const byAddress = new Map(rows.map((r) => [r.tokenAddress, r]));

    for (const goodAddr of [good1, good2, good3]) {
      const row = byAddress.get(goodAddr);
      expect(row?.enrichmentStatus).toBe("COMPLETE");
      expect(row?.supply).not.toBeNull();
    }
    for (const badAddr of [bad1, bad2]) {
      const row = byAddress.get(badAddr);
      expect(row?.enrichmentStatus).toBe("PENDING");
      // Never a fabricated default — missing enrichment stays missing.
      expect(row?.supply).toBeNull();
      expect(row?.isToken0).toBeNull();
      expect(row?.poolFee).toBeNull();
      expect(row?.lastEnrichmentError).toContain("simulated enrichment failure");
      expect(row?.enrichmentAttempts).toBe(1);
    }

    // The tick still committed its checkpoint — a bad token's enrichment
    // failure does not stall the whole ingestion stream.
    const checkpoint = await prisma.chainIngestionCheckpoint.findUnique({ where: { source: DISCOVERY_CHECKPOINT_SOURCE } });
    expect(checkpoint?.lastHeight.toString()).toBe(result.toBlock.toString());
  });

  it("a later tick retries PENDING rows in a bounded batch and resolves them once the RPC read succeeds", async () => {
    const bad = nextTestAddress();
    const staysBad = nextTestAddress();
    seededTokens.add(bad);
    seededTokens.add(staysBad);

    const fakeChain = new FakeChainReader(50n);
    fakeChain.logsByRange = [
      makeTokenLaunchedLog({ token: bad, pool: nextTestAddress(), blockNumber: 10n, txHash: "0xretry-1", logIndex: 0 }),
      makeTokenLaunchedLog({ token: staysBad, pool: nextTestAddress(), blockNumber: 11n, txHash: "0xretry-2", logIndex: 0 }),
    ];
    fakeChain.enrichmentByAddress.set(bad, "FAIL");
    fakeChain.enrichmentByAddress.set(staysBad, "FAIL");

    const listener = new DiscoveryListener({ chainClient: fakeChain, db: prisma, config: TEST_CONFIG });
    const first = await listener.runOnce();
    expect(first.status).toBe("PROCESSED");
    if (first.status !== "PROCESSED") throw new Error("expected PROCESSED");
    expect(first.tokensPendingEnrichment).toBe(2);

    // Fix one of the two ahead of the retry tick; leave the other failing.
    fakeChain.enrichmentByAddress.set(bad, { supply: 42n, isToken0: false, poolFee: 500 });
    // No new blocks since the last tick — the retry-pending pass still
    // runs even though there is nothing new to scan.
    const retryTick = await listener.runOnce();
    expect(retryTick.status).toBe("UP_TO_DATE");

    const fixed = await prisma.discoveredToken.findUnique({ where: { chain_tokenAddress: { chain: CHAIN, tokenAddress: bad } } });
    expect(fixed?.enrichmentStatus).toBe("COMPLETE");
    expect(fixed?.supply?.toFixed()).toBe("42");
    expect(fixed?.isToken0).toBe(false);
    expect(fixed?.poolFee).toBe(500);

    const stillPending = await prisma.discoveredToken.findUnique({ where: { chain_tokenAddress: { chain: CHAIN, tokenAddress: staysBad } } });
    expect(stillPending?.enrichmentStatus).toBe("PENDING");
    expect(stillPending?.enrichmentAttempts).toBe(2); // one at discovery time, one at retry
  });
});
