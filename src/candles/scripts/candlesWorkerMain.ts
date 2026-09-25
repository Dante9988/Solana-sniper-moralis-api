/**
 * Phase 7B.5B §8 — `npm run candles:worker` entrypoint.
 *
 * A separate, independently runnable process from `pons:worker` and `api`
 * (phase7b5b.txt's target pipeline: "Pons worker -> PostgreSQL ChainTrade ->
 * market/candle worker -> PostgreSQL MarketCandle -> API"). Restart-safe and
 * idempotent (every write path in src/candles/** is upsert/full-recompute,
 * never additive-only arithmetic); bounded work batches per tick (never an
 * unbounded in-memory trade history); graceful SIGINT/SIGTERM (awaits the
 * in-flight tick before disconnecting, same pattern as ponsWorkerMain.ts).
 *
 * **Single-replica only.** Like `pons:worker` (ARCHITECTURE.md §19.4/§19.9),
 * this process has no lease/partitioning mechanism — two replicas racing
 * the same chain's tokens would double-process (harmlessly idempotent
 * writes, but wasted RPC calls for decimals resolution and duplicate
 * transactions) and could interleave a token's recompute+checkpoint-advance
 * non-atomically across replicas. Do not run more than one instance per
 * chain/database. Kubernetes-readiness (a real lease) is explicitly
 * deferred, matching phase7b5b.txt §8's "the process boundary merely needs
 * to be Kubernetes-ready later."
 *
 * Needs read-only Robinhood RPC access (loadRobinhoodChainConfig(), the
 * same env as pons:worker) — not to ingest facts (it never writes
 * DiscoveredToken/ChainTrade), but because src/candles/decimalsResolver.ts
 * resolves each token's verified ERC-20 decimals() lazily. The `/api/v1`
 * process itself still never calls RPC to serve a candle request
 * (phase7b5b.txt §12) — only this worker does, and only for decimals.
 */

import { listenForTradeCommits } from "../tradeWakeup";
import { PrismaClient } from "@prisma/client";
import { loadRobinhoodChainConfig } from "../../pons/config";
import { FailoverChainClient } from "../../pons/failoverChainClient";
import { ROBINHOOD_CHAIN } from "../../pons/discoveryListener";
import { ponsComponentLogger } from "../../pons/logger";
import { loadApiConfig } from "../../researchApi/config";
import { createEventBus } from "../../researchApi/realtime/eventBus";
import { publishCandleEvent } from "../../researchApi/realtime/eventPublisher";
import { loadCandleWorkerConfig } from "../config";
import { ChainlinkQuoteUsdRateProvider } from "../../pons/usd/chainlinkQuoteUsdRateProvider";
import { runCandleAggregationTick } from "../candleAggregationService";
import { recordCandleWorkerFailure, recordCandleWorkerRunState } from "../health";

const VENUE = "pons";
const logger = ponsComponentLogger("candles:worker");

/** How recently the API must have seen a subscriber for a token to count as watched. */
const WATCH_FRESHNESS_MS = 5 * 60_000;
/** The watched loop's cadence — fast, because it is meant to keep pace with an open chart. */
const WATCHED_POLL_INTERVAL_MS = 2_000;
/** A ceiling so an unusual number of simultaneous watchers cannot turn the fast loop into a second fleet tick. */
const MAX_WATCHED_TOKENS_PER_TICK = 50;

async function main(): Promise<void> {
  const chainConfig = loadRobinhoodChainConfig();
  const workerConfig = loadCandleWorkerConfig();
  const chainClient = new FailoverChainClient({ config: chainConfig });
  const db = new PrismaClient();
  // Phase 7D.4 — Chainlink feeds on Robinhood Chain, valued at each trade's own time; UNAVAILABLE when unverifiable.
  const usdRateProvider = new ChainlinkQuoteUsdRateProvider({ chainClient });

  const realtimeConfig = loadApiConfig().realtime;
  // Phase 7D.6 — refuse to run as a separate process publishing into a process-local bus.
  // That configuration is not "degraded", it is inert: every `token.candle.updated` this
  // worker emits would be delivered to subscribers inside this same process, of which there
  // are none, while the API kept telling browsers the chart was LIVE. It went unnoticed for a
  // whole phase precisely because nothing failed (docs/phase-7d6/root-cause.md). If you really
  // are embedding this worker in the API process, say so explicitly.
  if (realtimeConfig.backend === "memory" && process.env.CANDLES_ALLOW_INERT_EVENT_BUS !== "true") {
    throw new Error(
      "REALTIME_BACKEND=memory cannot deliver candle events from this worker process to the API's WebSocket clients — " +
        "every published update would be silently discarded. Use REALTIME_BACKEND=postgres (the default) or redis, " +
        "or set CANDLES_ALLOW_INERT_EVENT_BUS=true if this worker genuinely runs inside the API process.",
    );
  }
  const eventBus = createEventBus(realtimeConfig);

  let stopping = false;
  let currentTick: Promise<void> = Promise.resolve();

  const tick = async () => {
    const summary = await runCandleAggregationTick({
      db,
      chainClient,
      chain: ROBINHOOD_CHAIN,
      venue: VENUE,
      usdRateProvider,
      maxInvalidationTokensPerTick: workerConfig.maxInvalidationTokensPerTick,
      maxForwardTokensPerTick: workerConfig.maxForwardTokensPerTick,
      tradePageCap: workerConfig.tradePageCap,
      logger,
      onCandleUpdated: async (event) => {
        await publishCandleEvent(eventBus, event);
      },
    });
    await recordCandleWorkerRunState(db, ROBINHOOD_CHAIN, summary);
    logger.info(
      `candle tick: ${summary.tokensProcessed} token(s) forward-processed, ${summary.invalidationsProcessed} invalidation(s) recomputed, ${summary.candlesWritten} candle(s) written, ${summary.bucketsRecomputed} bucket(s) recomputed in ${summary.durationMs}ms${summary.errors.length ? `, ${summary.errors.length} error(s)` : ""}`
    );
    for (const err of summary.errors) logger.warn(err);
  };

  /**
   * Phase 7D.6 — the watched-token loop.
   *
   * The fleet tick is fair and slow: ~100 tokens a pass, 70–120s with first-time backfills in
   * the queue. A token open in someone's terminal cannot wait for its turn in that queue, so
   * this loop does forward progress for just the handful of tokens the API says are being
   * watched right now. It recovers at most one watched token's invalidation per
   * pass, so a recent backfill cannot block its live tail behind fleet work.
   * Fleet-wide finalisation stays in the slower reconciliation loop.
   */
  const watchedTick = async () => {
    const since = new Date(Date.now() - WATCH_FRESHNESS_MS);
    const watched = await db.candleWatch.findMany({
      where: { chain: ROBINHOOD_CHAIN, lastSeenAt: { gte: since } },
      select: { tokenAddress: true },
      take: MAX_WATCHED_TOKENS_PER_TICK,
      orderBy: { lastSeenAt: "desc" },
    });
    if (watched.length === 0) return;
    const summary = await runCandleAggregationTick({
      db,
      chainClient,
      chain: ROBINHOOD_CHAIN,
      venue: VENUE,
      usdRateProvider,
      maxInvalidationTokensPerTick: 1,
      maxForwardTokensPerTick: MAX_WATCHED_TOKENS_PER_TICK,
      tradePageCap: workerConfig.tradePageCap,
      logger,
      restrictToTokens: watched.map((w) => w.tokenAddress),
      onCandleUpdated: async (event) => {
        await publishCandleEvent(eventBus, event);
      },
    });
    if (summary.candlesWritten > 0) {
      logger.info(`watched tick: ${summary.tokensProcessed} watched token(s), ${summary.candlesWritten} candle(s) written in ${summary.durationMs}ms`);
    }
    for (const err of summary.errors) logger.warn(err);
  };

  const loop = async () => {
    if (stopping) return;
    currentTick = (async () => {
      try {
        await tick();
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logger.error(`candle tick threw unexpectedly: ${reason}`);
        await recordCandleWorkerFailure(db, ROBINHOOD_CHAIN, reason).catch(() => undefined);
      }
    })();
    await currentTick;
    if (!stopping) setTimeout(() => void loop(), workerConfig.pollIntervalMs);
  };

  // Notifications arriving during a pass coalesce into one follow-up. No
  // parallel recomputes or unbounded event queue; a 2s sweep repairs missed hints.
  let watchedPromise: Promise<void> = Promise.resolve();
  let watchedRunning = false;
  let watchedPending = false;
  let wakeTimer: ReturnType<typeof setTimeout> | null = null;
  const wake = () => {
    if (stopping) return;
    watchedPending = true;
    if (watchedRunning || wakeTimer) return;
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      watchedPending = false;
      watchedRunning = true;
      watchedPromise = watchedTick().catch(err => logger.warn(`watched tick failed: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => { watchedRunning = false; if (watchedPending) wake(); });
    }, 100);
  };
  const reconciliationTimer = setInterval(wake, WATCHED_POLL_INTERVAL_MS);
  const stopWakeup = process.env.DATABASE_URL
    ? listenForTradeCommits(process.env.DATABASE_URL, wake, message => logger.warn(message))
    : async () => undefined;
  void loop();
  wake();
  logger.info("candles:worker started");

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`received ${signal}, stopping`);
    stopping = true;
    clearInterval(reconciliationTimer);
    if (wakeTimer) clearTimeout(wakeTimer);
    await stopWakeup();
    await Promise.all([currentTick, watchedPromise]);
    await eventBus.close().catch(() => undefined);
    await db.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (require.main === module) {
  main().catch((err) => {
    logger.error(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
