/**
 * Phase 7E.4.3 — the Solana ingestion worker.
 *
 * Runs three loops against one engine:
 *   the live `logsSubscribe` listener      (src/solana/pumpfunListener.ts)
 *   recovery from the persisted checkpoint (same listener, same engine)
 *   finality reconciliation                (src/solana/pumpfunFinalityReconciler.ts)
 *
 * Off by default. `SOLANA_DISCOVERY_ENABLED=true` is required to start, deliberately: this worker
 * writes canonical rows for a whole new chain, and it should be a decision to turn on rather than
 * something that happens because a process was deployed.
 *
 *   SOLANA_DISCOVERY_ENABLED=true npm run solana:worker
 *
 * Never logs the RPC URL, which carries the API key — only its host.
 */

import { PrismaClient } from "@prisma/client";

import { reconcilePumpfunFinality } from "../pumpfunFinalityReconciler";
import { PumpfunListener } from "../pumpfunListener";
import { SolanaIngestionMetrics } from "../pumpfunMetrics";
import { SolanaRpc, describeEndpoint, resolveSolanaRpcEndpoint } from "../rpc";

const RECONCILE_INTERVAL_MS = Number(process.env.SOLANA_RECONCILE_INTERVAL_MS ?? 30_000);
const SNAPSHOT_INTERVAL_MS = Number(process.env.SOLANA_SNAPSHOT_INTERVAL_MS ?? 30_000);

async function main(): Promise<void> {
  if (process.env.SOLANA_DISCOVERY_ENABLED !== "true") {
    console.log("[solana] SOLANA_DISCOVERY_ENABLED is not true — not starting. This is the default.");
    return;
  }
  const endpoint = resolveSolanaRpcEndpoint();
  if (!endpoint) throw new Error("SOLANA_RPC_ENDPOINT is not configured");

  const db = new PrismaClient();
  const rpc = new SolanaRpc(endpoint);
  const metrics = new SolanaIngestionMetrics();
  const listener = new PumpfunListener({ db, rpc, metrics });

  console.log(`[solana] worker starting host=${describeEndpoint(endpoint)}`);
  await listener.start();

  const timers: NodeJS.Timeout[] = [];

  timers.push(
    setInterval(() => {
      void reconcilePumpfunFinality({ db, rpc, metrics })
        .then((result) => {
          if (result.promoted > 0 || result.orphaned > 0 || result.errors.length > 0) {
            console.log(`[solana] finality ${JSON.stringify({ ...result, errors: result.errors.length })}`);
          }
        })
        .catch((error) => metrics.recordError(error instanceof Error ? error.message : String(error)));
    }, RECONCILE_INTERVAL_MS)
  );

  timers.push(
    setInterval(() => {
      console.log(`[solana] ${JSON.stringify(metrics.snapshot())}`);
    }, SNAPSHOT_INTERVAL_MS)
  );

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[solana] ${signal} — draining`);
    for (const timer of timers) clearInterval(timer);
    await listener.stop();
    console.log(`[solana] final ${JSON.stringify(metrics.snapshot())}`);
    await db.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error(`[solana] fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
