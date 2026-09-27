/**
 * Phase 7E.4.3 §11 — runs the EXISTING candle aggregation tick for chain `solana`.
 *
 *   SOLANA_CANDLE_TICKS=4 npm run solana:candles
 *
 * There is no Solana candle code here. This is `runCandleAggregationTick` — the same function
 * `candles:worker` calls for Robinhood — pointed at `chain: "solana"`. §11: "Do NOT build
 * Solana-specific candle infrastructure."
 *
 * It exists as its own entrypoint because `candles:worker` is wired to Robinhood specifically: it
 * constructs a `FailoverChainClient` from Robinhood's RPC config, prices through Chainlink feeds on
 * Robinhood Chain, and records Robinhood-shaped worker health. Folding Solana into that process is a
 * refactor of the worker's wiring, not of the candle domain, and is deliberately left for its own
 * change rather than bundled here.
 *
 * Two deliberate choices:
 *
 *   `chainClient` throws on every call. Solana decimals are persisted on the `DiscoveredToken` row
 *   at discovery time, so `resolveTokenDecimals` short-circuits and never needs a chain read. If
 *   that ever stops being true, this script fails loudly instead of quietly reaching for an EVM RPC.
 *
 *   `usdRateProvider` is the Null provider, so `volumeUsd` is null. No trusted historical SOL/USD
 *   source is configured in this repository, and §10 is explicit that an untrustworthy USD figure is
 *   unavailable rather than estimated. Quote-denominated candles are complete and correct regardless.
 */

import { PrismaClient } from "@prisma/client";

import { runCandleAggregationTick } from "../../candles/candleAggregationService";
import { recordCandleWorkerFailure, recordCandleWorkerRunState } from "../../candles/health";
import { NullQuoteUsdRateProvider } from "../../candles/usdPricing";
import type { ChainReader } from "../../pons/chainClient";
import { PUMPFUN_VENUE, SOLANA_CHAIN } from "../pumpfunAdapter";
import { refreshSolanaMarketActivity } from "../solanaMarketActivity";

const TICKS = Number(process.env.SOLANA_CANDLE_TICKS ?? 1);
/**
 * Phase 7E.4.4 — when set, run forever at this interval instead of a fixed number of ticks. This is
 * how `scripts/dev-stack.sh start solana-candles` runs it, so a live Solana chart keeps moving. Each
 * tick also refreshes the Solana activity windows and records worker health for chain `solana`, so
 * the API's freshness for a Solana chart is measured, not assumed.
 */
const INTERVAL_MS = Number(process.env.SOLANA_CANDLE_INTERVAL_MS ?? 0);

const noEvmClient = new Proxy({} as ChainReader, {
  get(_target, property) {
    return () => {
      throw new Error(`Solana candle aggregation must not call an EVM chain client (called ${String(property)})`);
    };
  },
});

async function tickOnce(db: PrismaClient) {
  return runCandleAggregationTick({
    db,
    chainClient: noEvmClient,
    chain: SOLANA_CHAIN,
    venue: PUMPFUN_VENUE,
    usdRateProvider: new NullQuoteUsdRateProvider(),
    maxInvalidationTokensPerTick: 50,
    maxForwardTokensPerTick: 100,
    tradePageCap: 5_000,
    logger: {
      info: () => {},
      warn: (message, fields) => console.log(`[solana:candles] warn ${message} ${JSON.stringify(fields ?? {})}`),
      error: (message, fields) => console.log(`[solana:candles] error ${message} ${JSON.stringify(fields ?? {})}`),
    },
  });
}

async function main(): Promise<void> {
  const db = new PrismaClient();

  if (INTERVAL_MS > 0) {
    let stopping = false;
    const stop = () => {
      stopping = true;
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    console.log(`[solana:candles] looping every ${INTERVAL_MS}ms`);
    while (!stopping) {
      try {
        const summary = await tickOnce(db);
        await recordCandleWorkerRunState(db, SOLANA_CHAIN, summary);
        const activity = await refreshSolanaMarketActivity(db);
        if (summary.tokensProcessed > 0 || summary.invalidationsProcessed > 0) {
          console.log(`[solana:candles] ${JSON.stringify({ ...summary, activityTokens: activity.tokensUpdated })}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`[solana:candles] tick failed: ${message}`);
        await recordCandleWorkerFailure(db, SOLANA_CHAIN, message).catch(() => undefined);
      }
      await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
    }
    await db.$disconnect();
    return;
  }

  for (let tick = 1; tick <= Math.max(1, TICKS); tick += 1) {
    const summary = await tickOnce(db);
    console.log(`[solana:candles] tick ${tick} ${JSON.stringify(summary)}`);
    if (summary.tokensProcessed === 0 && summary.invalidationsProcessed === 0) break;
  }
  await refreshSolanaMarketActivity(db);
  await db.$disconnect();
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`[solana:candles] fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
);
