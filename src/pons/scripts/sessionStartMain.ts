/**
 * Phase 7D.5 — open a new local observation session.
 *
 * Run by `scripts/dev-stack.sh start` (all services) so the *stack*, not an individual
 * worker, decides where a session begins. Starting one worker rejoins the session this
 * created; only a deliberate full-stack start cuts a new boundary.
 *
 * Refuses to run in `resume` mode: hosted environments continue from durable checkpoints
 * and must never have a session silently imposed on them.
 */

import { PrismaClient } from "@prisma/client";

import { loadRobinhoodChainConfig } from "../config";
import { FailoverChainClient } from "../failoverChainClient";
import { ROBINHOOD_CHAIN } from "../discoveryListener";
import { loadIngestionMode, openSession } from "../ingestionSession";
import { ponsLogger } from "../logger";

async function main(): Promise<void> {
  const mode = loadIngestionMode();
  if (mode !== "live-head") {
    ponsLogger.info(`PONS_INGESTION_MODE=${mode} — no session opened; durable checkpoints are in charge.`);
    return;
  }

  const config = loadRobinhoodChainConfig();
  const chainClient = new FailoverChainClient({ config });
  const db = new PrismaClient();
  try {
    const session = await openSession(db, chainClient, ROBINHOOD_CHAIN);
    // Printed rather than only logged: the runbook asks for the boundary to be recorded,
    // and this is the one moment it is decided.
    process.stdout.write(
      `live-head session opened\n` +
        `  id:        ${session.id}\n` +
        `  boundary:  block ${session.startBlock} (${session.startHash})\n` +
        `  chain time:${session.startTimestamp.toISOString()}\n` +
        `  ingesting: from block ${session.startBlock + 1n} forward\n`
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  ponsLogger.error({ err: err instanceof Error ? err.message : String(err) }, "failed to open live-head session");
  process.exit(1);
});
