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

import { PrismaClient } from "@prisma/client";
import { loadRobinhoodChainConfig } from "../../pons/config";
import { FailoverChainClient } from "../../pons/failoverChainClient";
import { ROBINHOOD_CHAIN } from "../../pons/discoveryListener";
import { ponsComponentLogger } from "../../pons/logger";
import { loadApiConfig } from "../../researchApi/config";
import { createEventBus } from "../../researchApi/realtime/eventBus";
import { publishCandleEvent } from "../../researchApi/realtime/eventPublisher";
import { loadCandleWorkerConfig } from "../config";
import { NullQuoteUsdRateProvider } from "../usdPricing";
import { runCandleAggregationTick } from "../candleAggregationService";
import { recordCandleWorkerFailure, recordCandleWorkerRunState } from "../health";

const VENUE = "pons";
const logger = ponsComponentLogger("candles:worker");

async function main(): Promise<void> {
  const chainConfig = loadRobinhoodChainConfig();
  const workerConfig = loadCandleWorkerConfig();
  const chainClient = new FailoverChainClient({ config: chainConfig });
  const db = new PrismaClient();
  const usdRateProvider = new NullQuoteUsdRateProvider();

  const realtimeConfig = loadApiConfig().realtime;
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

  void loop();
  logger.info("candles:worker started");

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`received ${signal}, stopping`);
    stopping = true;
    await currentTick;
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
