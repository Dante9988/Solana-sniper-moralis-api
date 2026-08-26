/**
 * Phase 5D — bounded standalone forensics worker (phase5d.txt §§10-11).
 *
 * Importing this module has ZERO side effects — no timers, no process
 * listeners, no client construction. A worker only ever starts when a
 * caller explicitly constructs `ForensicsWorker` and calls `.start()`
 * (from `npm run forensics:worker`'s entrypoint script, never at import
 * time, never during tests).
 */

import { PrismaClient } from "@prisma/client";
import {
  claimNextForensicsJob,
  ClaimedForensicsJob,
  completeForensicsJob,
  computeBackoffMs,
  extendForensicsJobLease,
  failForensicsJob,
  ForensicsJobValidationError,
  retryForensicsJob,
} from "./forensicsJobService";
import { persistForensicsRun } from "./forensicsRunPersistence";
import { runBundleForensics } from "./bundleForensicsService";
import { ForensicsRpcClient } from "./solanaForensicsClient";
import { RequestBudget, createRequestBudget } from "./requestBudget";
import { ForensicsWorkerConfig } from "./forensicsWorkerConfig";
import { AnalysisLevel, LaunchInfo } from "./types";

export interface ForensicsWorkerLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

const noopLogger: ForensicsWorkerLogger = { info: () => {}, warn: () => {}, error: () => {} };

export interface ForensicsWorkerDependencies {
  db: PrismaClient;
  /** Constructs the read-only Phase 5B client for one job. Never a live client at import time — only when a job is actually claimed. */
  createRpcClient: (opts: { budget: RequestBudget; deadlineMs: number; signal: AbortSignal }) => ForensicsRpcClient;
  workerId: string;
  config: ForensicsWorkerConfig;
  logger?: ForensicsWorkerLogger;
  /**
   * Phase 5E (phase5e.txt §9): invoked AFTER a forensic run transaction has
   * already committed, only when reconciliation is enabled by the caller —
   * this class never checks any reconciliation flag itself. Forensic
   * persistence always succeeds independently of this callback; a
   * reconciliation failure here is logged and swallowed, never marks the
   * forensic job/run failed. Wired only from the worker entrypoint script,
   * never from an import or the listener.
   */
  onRunPersisted?: (runId: string) => Promise<void>;
  /** Periodic sweep for previously-unreconciled runs. Only scheduled if provided. */
  reconciliationSweep?: () => Promise<void>;
  reconciliationSweepMs?: number;
}

async function interruptibleSleep(ms: number, isStopping: () => boolean): Promise<void> {
  const step = 250;
  let remaining = ms;
  while (remaining > 0 && !isStopping()) {
    const chunk = Math.min(step, remaining);
    await new Promise((resolve) => setTimeout(resolve, chunk));
    remaining -= chunk;
  }
}

export class ForensicsWorker {
  private stopping = false;
  private running = false;
  private readonly activeAbortControllers = new Set<AbortController>();
  private readonly heartbeatTimers = new Set<ReturnType<typeof setInterval>>();
  private loopPromises: Promise<void>[] = [];
  private reconciliationSweepTimer: ReturnType<typeof setInterval> | undefined;
  private readonly logger: ForensicsWorkerLogger;

  constructor(private readonly deps: ForensicsWorkerDependencies) {
    this.logger = deps.logger ?? noopLogger;
  }

  /** No-op (and logs why) if the worker is disabled — callers should exit safely afterward, never crash. */
  start(): void {
    if (this.running) return;
    if (!this.deps.config.enabled) {
      this.logger.info("forensics worker disabled (FORENSICS_WORKER_ENABLED=false); exiting safely");
      return;
    }
    this.running = true;
    this.stopping = false;
    this.loopPromises = Array.from({ length: this.deps.config.concurrency }, (_, i) =>
      this.runLoop(`${this.deps.workerId}#${i}`)
    );

    if (this.deps.reconciliationSweep) {
      const intervalMs = this.deps.reconciliationSweepMs ?? 60_000;
      this.reconciliationSweepTimer = setInterval(() => {
        this.deps.reconciliationSweep?.().catch((err) => {
          this.logger.warn(`reconciliation sweep failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }, intervalMs);
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Aborts any in-flight analysis, lets it finish (persisting a PARTIAL result and releasing its lease), then returns. */
  async stop(): Promise<void> {
    this.stopping = true;
    for (const controller of this.activeAbortControllers) controller.abort();
    if (this.reconciliationSweepTimer) {
      clearInterval(this.reconciliationSweepTimer);
      this.reconciliationSweepTimer = undefined;
    }
    await Promise.allSettled(this.loopPromises);
    this.running = false;
  }

  private async runLoop(slotWorkerId: string): Promise<void> {
    while (!this.stopping) {
      let claimed: ClaimedForensicsJob | null = null;
      try {
        claimed = await claimNextForensicsJob(this.deps.db, slotWorkerId, this.deps.config.leaseMs);
      } catch (err) {
        this.logger.error(`forensics worker ${slotWorkerId}: claim failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (!claimed) {
        await interruptibleSleep(this.deps.config.pollMs, () => this.stopping);
        continue;
      }

      await this.processJob(claimed, slotWorkerId);
    }
  }

  private async processJob(job: ClaimedForensicsJob, workerId: string): Promise<void> {
    const abortController = new AbortController();
    this.activeAbortControllers.add(abortController);
    const heartbeat = setInterval(() => {
      extendForensicsJobLease(this.deps.db, job.id, workerId, this.deps.config.leaseMs).catch((err) => {
        this.logger.warn(`forensics worker ${workerId}: heartbeat failed for job ${job.id}: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, this.deps.config.heartbeatMs);
    this.heartbeatTimers.add(heartbeat);

    try {
      const analysisLevel = job.analysisLevel as AnalysisLevel;
      const budget = createRequestBudget(analysisLevel);
      const client = this.deps.createRpcClient({ budget, deadlineMs: this.deps.config.leaseMs, signal: abortController.signal });

      const { report, eligibility, clusters, holderSnapshotSlot } = await runBundleForensics(
        { client },
        {
          mint: job.mint,
          discoverySignature: job.discoverySignature ?? undefined,
          discoverySource: job.discoverySource as LaunchInfo["source"],
          analysisLevel,
        }
      );

      const jobStatus: "COMPLETE" | "PARTIAL" = report.coverage.status === "COMPLETE" ? "COMPLETE" : "PARTIAL";

      const { runId } = await persistForensicsRun(this.deps.db, {
        jobId: job.id,
        assetId: job.assetId,
        mint: job.mint,
        attemptNumber: job.attemptCount,
        analysisLevel,
        runStatus: jobStatus,
        report,
        eligibility,
        clusters,
        holderSnapshotSlot,
      });

      // Budget-exhausted/coverage-limited usable reports persist as PARTIAL
      // and do not automatically retry/spend again (phase5d.txt §10).
      await completeForensicsJob(this.deps.db, job.id, workerId, jobStatus);
      this.logger.info(`forensics job ${job.id} (${job.mint}) -> ${jobStatus} (run ${runId})`);

      // Forensic persistence above has already succeeded independently of
      // this — a reconciliation failure here must never mark the job/run
      // failed (phase5e.txt §9).
      if (this.deps.onRunPersisted) {
        await this.deps.onRunPersisted(runId).catch((err) => {
          this.logger.warn(`reconciliation callback failed for run ${runId}: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    } catch (err) {
      await this.handleJobFailure(job, workerId, err);
    } finally {
      clearInterval(heartbeat);
      this.heartbeatTimers.delete(heartbeat);
      this.activeAbortControllers.delete(abortController);
    }
  }

  private async handleJobFailure(job: ClaimedForensicsJob, workerId: string, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    const permanent = err instanceof ForensicsJobValidationError;
    try {
      if (permanent || job.attemptCount >= job.maxAttempts) {
        await failForensicsJob(this.deps.db, job.id, workerId, permanent ? "VALIDATION_ERROR" : "RETRIES_EXHAUSTED", message);
      } else {
        const backoff = computeBackoffMs(job.attemptCount, this.deps.config.baseBackoffMs);
        await retryForensicsJob(this.deps.db, job.id, workerId, "WORKER_ERROR", message, backoff);
      }
    } catch (persistErr) {
      this.logger.error(
        `forensics worker ${workerId}: failed to record failure for job ${job.id}: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`
      );
    }
    this.logger.error(`forensics job ${job.id} (${job.mint}) failed: ${message}`);
  }
}
