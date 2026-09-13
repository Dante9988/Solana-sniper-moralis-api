/**
 * Phase 7B.4 — `npm run pons:worker` entrypoint.
 *
 * This is the ONLY place the discovery/trade listeners and graduation
 * poller are ever started — importing discoveryListener.ts/tradeListener.ts/
 * graduationPoller.ts has no side effects (src/forensics/forensicsWorker.ts
 * precedent). All three run in one process here since none of them are
 * CPU-heavy; split into separate processes later if that changes.
 *
 * Phase 7B.5A §7 — uses the redacting Pino logger (ponsLogger.ts) instead
 * of prefixed console methods, and waits for each loop's in-flight tick to
 * finish (waitForIdle()) before disconnecting Prisma on shutdown, so a
 * SIGTERM/SIGINT during an in-flight tick never disconnects mid-write.
 */

import { PrismaClient } from "@prisma/client";
import { loadRobinhoodChainConfig, loadPonsV2Config, PonsConfigError } from "../config";
import { FailoverChainClient } from "../failoverChainClient";
import { DiscoveryListener } from "../discoveryListener";
import { TradeListener } from "../tradeListener";
import { GraduationPoller } from "../graduationPoller";
import { DiscoveryV2Listener } from "../discoveryV2Listener";
import { TradeV2Listener } from "../tradeV2Listener";
import { ponsLogger, ponsComponentLogger } from "../logger";

async function main(): Promise<void> {
  const config = loadRobinhoodChainConfig();
  const chainClient = new FailoverChainClient({ config });
  const db = new PrismaClient();

  const discoveryListener = new DiscoveryListener({ chainClient, db, config, logger: ponsComponentLogger("pons:discovery") });
  const tradeListener = new TradeListener({ chainClient, db, config, logger: ponsComponentLogger("pons:trades") });
  const graduationPoller = new GraduationPoller({ chainClient, db, config, logger: ponsComponentLogger("pons:graduation") });

  discoveryListener.start();
  tradeListener.start();
  graduationPoller.start();

  // Phase 7D §7 — Pons V2 (Uniswap V4 graduation + transaction history) is
  // optional at the config level: a deployment that hasn't set
  // PONS_V2_FACTORY yet keeps running the V1 loops above untouched rather
  // than crashing the whole worker. No V2 graduation poller — PoolGraduated
  // is a real event, read in the same tick as discovery.
  let discoveryV2Listener: DiscoveryV2Listener | null = null;
  let tradeV2Listener: TradeV2Listener | null = null;
  try {
    const v2Config = loadPonsV2Config();
    discoveryV2Listener = new DiscoveryV2Listener({ chainClient, db, config, v2Config, logger: ponsComponentLogger("pons:discovery-v2") });
    tradeV2Listener = new TradeV2Listener({ chainClient, db, config, v2Config, logger: ponsComponentLogger("pons:trades-v2") });
    discoveryV2Listener.start();
    tradeV2Listener.start();
    ponsLogger.info("started discovery, trade, graduation, and pons_v2 discovery/trade loops");
  } catch (err) {
    if (err instanceof PonsConfigError) {
      ponsLogger.warn({ reason: err.message }, "PONS_V2_FACTORY not configured — skipping Pons V2 (Uniswap V4) ingestion");
      ponsLogger.info("started discovery, trade, and graduation loops");
    } else {
      throw err;
    }
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    ponsLogger.info({ signal }, "received signal, stopping");
    discoveryListener.stop();
    tradeListener.stop();
    graduationPoller.stop();
    discoveryV2Listener?.stop();
    tradeV2Listener?.stop();
    await Promise.all([
      discoveryListener.waitForIdle(),
      tradeListener.waitForIdle(),
      graduationPoller.waitForIdle(),
      discoveryV2Listener?.waitForIdle() ?? Promise.resolve(),
      tradeV2Listener?.waitForIdle() ?? Promise.resolve(),
    ]);
    await db.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (require.main === module) {
  main().catch((err) => {
    ponsLogger.error({ err: err instanceof Error ? err.message : String(err) }, "FATAL");
    process.exit(1);
  });
}
