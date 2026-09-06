/**
 * Phase 7B.4 — `npm run pons:worker` entrypoint.
 *
 * This is the ONLY place the discovery/trade listeners and graduation
 * poller are ever started — importing discoveryListener.ts/tradeListener.ts/
 * graduationPoller.ts has no side effects (src/forensics/forensicsWorker.ts
 * precedent). All three run in one process here since none of them are
 * CPU-heavy; split into separate processes later if that changes.
 */

import { PrismaClient } from "@prisma/client";
import { loadRobinhoodChainConfig } from "../config";
import { PonsChainClient } from "../chainClient";
import { DiscoveryListener } from "../discoveryListener";
import { TradeListener } from "../tradeListener";
import { GraduationPoller } from "../graduationPoller";

function prefixedLogger(prefix: string) {
  return {
    info: (message: string) => console.log(`[${prefix}] ${message}`),
    warn: (message: string) => console.warn(`[${prefix}] ${message}`),
    error: (message: string) => console.error(`[${prefix}] ${message}`),
  };
}

async function main(): Promise<void> {
  const config = loadRobinhoodChainConfig();
  const chainClient = new PonsChainClient({ config });
  const db = new PrismaClient();

  const discoveryListener = new DiscoveryListener({ chainClient, db, config, logger: prefixedLogger("pons:discovery") });
  const tradeListener = new TradeListener({ chainClient, db, config, logger: prefixedLogger("pons:trades") });
  const graduationPoller = new GraduationPoller({ chainClient, db, config, logger: prefixedLogger("pons:graduation") });

  discoveryListener.start();
  tradeListener.start();
  graduationPoller.start();

  console.log("[pons:worker] started discovery, trade, and graduation loops.");

  const shutdown = async (signal: string) => {
    console.log(`[pons:worker] received ${signal}, stopping...`);
    discoveryListener.stop();
    tradeListener.stop();
    graduationPoller.stop();
    await db.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[pons:worker] FATAL:", err);
    process.exit(1);
  });
}
