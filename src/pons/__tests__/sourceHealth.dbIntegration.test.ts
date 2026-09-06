/**
 * Phase 7B.5A §5/§10 — source-health projection tests: LIVE / LAGGING /
 * DEGRADED / REORG_RECOVERY / UNAVAILABLE, derived only from persisted
 * checkpoint metadata (never a live RPC call per computation).
 *
 * Run:
 *   PONS_RUN_DB_TESTS=true DATABASE_URL=postgresql://... npx vitest run src/pons/__tests__/sourceHealth.dbIntegration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { computeIngestionHealth } from "../sourceHealth";
import { DISCOVERY_CHECKPOINT_SOURCE } from "../discoveryListener";
import { TRADE_CHECKPOINT_SOURCE } from "../tradeListener";

const RUN_DB_TESTS = process.env.PONS_RUN_DB_TESTS === "true";

const THRESHOLDS = { healthLaggingBlocks: 50, healthStaleMs: 120_000, healthErrorWindowMs: 60_000 };

describe.skipIf(!RUN_DB_TESTS)("source-health projection — real Postgres integration", () => {
  const prisma = new PrismaClient();

  async function cleanup() {
    await prisma.chainIngestionCheckpoint.deleteMany({ where: { source: { in: [DISCOVERY_CHECKPOINT_SOURCE, TRADE_CHECKPOINT_SOURCE] } } });
  }

  beforeAll(cleanup);
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });
  beforeEach(cleanup);

  it("reports UNAVAILABLE for a source with no checkpoint row at all (never polled)", async () => {
    const health = await computeIngestionHealth(prisma, THRESHOLDS);
    expect(health.discovery.status).toBe("UNAVAILABLE");
    expect(health.trades.status).toBe("UNAVAILABLE");
    expect(health.status).toBe("UNAVAILABLE");
  });

  it("reports LIVE when recently polled, recently successful, and caught up to the observed tip", async () => {
    const now = new Date();
    await prisma.chainIngestionCheckpoint.createMany({
      data: [
        { source: DISCOVERY_CHECKPOINT_SOURCE, lastHeight: 100n, lastHash: "0xh", lastObservedChainHeight: 100n, lastPollAt: now, lastSuccessAt: now },
        { source: TRADE_CHECKPOINT_SOURCE, lastHeight: 100n, lastHash: "0xh", lastObservedChainHeight: 100n, lastPollAt: now, lastSuccessAt: now },
      ],
    });
    const health = await computeIngestionHealth(prisma, THRESHOLDS, now);
    expect(health.status).toBe("LIVE");
    expect(health.discovery.blocksBehind).toBe("0");
  });

  it("reports LAGGING when blocks-behind exceeds the configured threshold", async () => {
    const now = new Date();
    await prisma.chainIngestionCheckpoint.createMany({
      data: [
        { source: DISCOVERY_CHECKPOINT_SOURCE, lastHeight: 100n, lastHash: "0xh", lastObservedChainHeight: 200n, lastPollAt: now, lastSuccessAt: now },
        { source: TRADE_CHECKPOINT_SOURCE, lastHeight: 100n, lastHash: "0xh", lastObservedChainHeight: 100n, lastPollAt: now, lastSuccessAt: now },
      ],
    });
    const health = await computeIngestionHealth(prisma, THRESHOLDS, now);
    expect(health.discovery.status).toBe("LAGGING");
    expect(health.discovery.blocksBehind).toBe("100");
    expect(health.status).toBe("LAGGING"); // worst-of across sources
  });

  it("reports DEGRADED when a recent error was recorded more recently than the last success", async () => {
    const now = new Date();
    const recentError = new Date(now.getTime() - 5_000);
    await prisma.chainIngestionCheckpoint.createMany({
      data: [
        { source: DISCOVERY_CHECKPOINT_SOURCE, lastHeight: 100n, lastHash: "0xh", lastObservedChainHeight: 100n, lastPollAt: now, lastSuccessAt: new Date(now.getTime() - 30_000), lastError: "getLogs: simulated RPC error", lastErrorAt: recentError },
        { source: TRADE_CHECKPOINT_SOURCE, lastHeight: 100n, lastHash: "0xh", lastObservedChainHeight: 100n, lastPollAt: now, lastSuccessAt: now },
      ],
    });
    const health = await computeIngestionHealth(prisma, THRESHOLDS, now);
    expect(health.discovery.status).toBe("DEGRADED");
    expect(health.discovery.lastError).toBe("getLogs: simulated RPC error");
    expect(health.status).toBe("DEGRADED");
  });

  it("reports UNAVAILABLE once the loop has gone stale (no poll within the configured window), even if it once succeeded", async () => {
    const now = new Date();
    const staleTime = new Date(now.getTime() - THRESHOLDS.healthStaleMs - 1_000);
    await prisma.chainIngestionCheckpoint.createMany({
      data: [{ source: DISCOVERY_CHECKPOINT_SOURCE, lastHeight: 100n, lastHash: "0xh", lastObservedChainHeight: 100n, lastPollAt: staleTime, lastSuccessAt: staleTime }],
    });
    const health = await computeIngestionHealth(prisma, THRESHOLDS, now);
    expect(health.discovery.status).toBe("UNAVAILABLE");
  });

  it("reports REORG_RECOVERY (highest severity) when a source has an unresolved reorg, even if otherwise caught up", async () => {
    const now = new Date();
    await prisma.chainIngestionCheckpoint.createMany({
      data: [
        { source: DISCOVERY_CHECKPOINT_SOURCE, lastHeight: 100n, lastHash: "0xh", lastObservedChainHeight: 100n, lastPollAt: now, lastSuccessAt: now, reorgUnresolvedAt: now, reorgUnresolvedReason: "no common ancestor found" },
        { source: TRADE_CHECKPOINT_SOURCE, lastHeight: 100n, lastHash: "0xh", lastObservedChainHeight: 100n, lastPollAt: now, lastSuccessAt: now },
      ],
    });
    const health = await computeIngestionHealth(prisma, THRESHOLDS, now);
    expect(health.discovery.status).toBe("REORG_RECOVERY");
    expect(health.discovery.unresolvedReorg).toBe(true);
    expect(health.status).toBe("REORG_RECOVERY"); // worst-of beats the otherwise-healthy trade source
  });

  it("never exposes a raw provider URL, stack trace, or credential-shaped string — only the redacted operational reason string a listener recorded", async () => {
    const now = new Date();
    await prisma.chainIngestionCheckpoint.createMany({
      data: [{ source: DISCOVERY_CHECKPOINT_SOURCE, lastHeight: 100n, lastHash: "0xh", lastPollAt: now, lastError: "getBlockNumber: TIMEOUT", lastErrorAt: now }],
    });
    const health = await computeIngestionHealth(prisma, THRESHOLDS, now);
    const serialized = JSON.stringify(health);
    expect(serialized).not.toMatch(/https?:\/\//);
    expect(serialized).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/); // a stack-trace line shape
  });
});
