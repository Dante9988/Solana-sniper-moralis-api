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
import { loadRobinhoodChainConfig } from "../config";
import { PonsChainClient } from "../chainClient";
import { DiscoveryListener } from "../discoveryListener";
import { TradeListener } from "../tradeListener";
import { GraduationPoller } from "../graduationPoller";
import { ponsLogger, ponsComponentLogger } from "../logger";

async function main(): Promise<void> {
  const config = loadRobinhoodChainConfig();
  const chainClient = new PonsChainClient({ config });
  const db = new PrismaClient();

  const discoveryListener = new DiscoveryListener({ chainClient, db, config, logger: ponsComponentLogger("pons:discovery") });
  const tradeListener = new TradeListener({ chainClient, db, config, logger: ponsComponentLogger("pons:trades") });
  const graduationPoller = new GraduationPoller({ chainClient, db, config, logger: ponsComponentLogger("pons:graduation") });

  discoveryListener.start();
  tradeListener.start();
  graduationPoller.start();

  ponsLogger.info("started discovery, trade, and graduation loops");

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    ponsLogger.info({ signal }, "received signal, stopping");
    discoveryListener.stop();
    tradeListener.stop();
    graduationPoller.stop();
    await Promise.all([discoveryListener.waitForIdle(), tradeListener.waitForIdle(), graduationPoller.waitForIdle()]);
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
