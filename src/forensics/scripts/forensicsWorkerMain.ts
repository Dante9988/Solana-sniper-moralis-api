/**
 * Phase 5D — `npm run forensics:worker` entrypoint (phase5d.txt §11).
 *
 * This is the ONLY place the worker is ever started — importing
 * `forensicsWorker.ts` itself has no side effects. Not imported by the
 * active listener, the intelligence orchestrator, or any other script.
 */

import { randomUUID } from "node:crypto";
import { prisma } from "../../services/prismaClient";
import { ForensicsWorker, ForensicsWorkerLogger } from "../forensicsWorker";
import { loadForensicsWorkerConfig } from "../forensicsWorkerConfig";
import { SolanaForensicsClient } from "../solanaForensicsClient";
import { resolveHeliusRpcUrl } from "../forensicsConfig";
import { isForensicsReconciliationEnabled } from "../forensicsIntegrationConfig";
import { reconcileForensicsRun, reconcilePendingForensicsRuns } from "../../services/forensicsIntelligenceReconciliation";

const logger: ForensicsWorkerLogger = {
  info: (message) => console.log(`[forensics:worker] ${message}`),
  warn: (message) => console.warn(`[forensics:worker] ${message}`),
  error: (message) => console.error(`[forensics:worker] ${message}`),
};

async function main(): Promise<void> {
  const config = loadForensicsWorkerConfig();
  const workerId = `forensics-worker-${randomUUID()}`;

  if (!config.enabled) {
    logger.info("FORENSICS_WORKER_ENABLED is not true — exiting safely without starting.");
    await prisma.$disconnect();
    return;
  }

  const rpcUrl = resolveHeliusRpcUrl();
  const reconciliationEnabled = isForensicsReconciliationEnabled();

  const worker = new ForensicsWorker({
    db: prisma,
    workerId,
    config,
    logger,
    createRpcClient: ({ budget, deadlineMs, signal }) =>
      new SolanaForensicsClient({ rpcUrl, budget, totalDeadlineMs: deadlineMs, signal }),
    // Reconciliation runs only inside this worker process, only when
    // explicitly enabled — never from an import or the listener (phase5e.txt §9).
    onRunPersisted: reconciliationEnabled ? (runId) => reconcileForensicsRun(prisma, runId).then(() => undefined) : undefined,
    reconciliationSweep: reconciliationEnabled ? () => reconcilePendingForensicsRuns(prisma).then(() => undefined) : undefined,
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`received ${signal}, shutting down gracefully...`);
    worker
      .stop()
      .then(() => prisma.$disconnect())
      .then(() => process.exit(0))
      .catch((err) => {
        logger.error(`error during shutdown: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  worker.start();
  logger.info(`started (workerId=${workerId}, concurrency=${config.concurrency}, deepEnabled follows thresholds.ts)`);
}

main().catch((err) => {
  console.error("[forensics:worker] fatal error:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
