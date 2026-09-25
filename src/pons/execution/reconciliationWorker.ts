/**
 * Phase 7E.1 §15 — reconciliation.
 *
 * The browser is not the source of truth. A user can sign, broadcast, and close the tab
 * before anything confirms, so a trade's final state has to be decided here, from the
 * canonical receipt, on a loop that does not depend on anyone being connected.
 *
 * What this does NOT do is guess. A hash the chain has not heard of yet is the normal
 * state of a freshly broadcast transaction, so a miss is counted rather than acted on, and
 * only sustained absence becomes DROPPED. A receipt that is present but whose logs contain
 * no event this venue recognises is recorded as confirmed with null amounts, never
 * back-filled from the quote.
 */

import type { PrismaClient } from "@prisma/client";

import type { ChainClientResult } from "../chainClient";
import { applyReceipt, pendingSubmissions, recordMissingReceipt } from "../../services/executionService";
import { venueById } from "./registry";
import type { ExecutionPlan, ExecutionVenueId, ReceiptFacts } from "./venue";

export interface ReceiptReader {
  /** `null` data means the chain has no receipt for this hash yet — not an error. */
  getReceipt(hash: string): Promise<ChainClientResult<ReceiptFacts | null>>;
}

export interface ReconciliationLogger {
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
}

const noopLogger: ReconciliationLogger = { info: () => {}, warn: () => {} };

export interface ReconciliationDeps {
  db: PrismaClient;
  reader: ReceiptReader;
  logger?: ReconciliationLogger;
  batchSize?: number;
}

export interface ReconciliationTickResult {
  checked: number;
  confirmed: number;
  reverted: number;
  stillPending: number;
  unavailable: number;
}

/**
 * Rebuild the plan reconciliation needs from the stored intent.
 *
 * Only the fields `reconcile` reads are reconstructed — route target, side, wallet and
 * pool — because those are what decide which log belongs to this trade. The rest is
 * padded with values that cannot affect the outcome, which is safer than persisting a
 * whole serialized plan that could drift from the type.
 */
function planForReconcile(intent: {
  venue: string;
  route: string;
  routeTarget: string;
  chainId: number;
  walletAddress: string;
  side: string;
  tokenAddress: string;
  expectedOutput: { toFixed(): string };
  minimumOutput: { toFixed(): string };
  calldataVersion: string;
}): ExecutionPlan | null {
  if (intent.route !== "BONDING_CURVE" && intent.route !== "UNIVERSAL_ROUTER") return null;
  return {
    venue: intent.venue as ExecutionVenueId,
    route: { kind: intent.route, target: intent.routeTarget },
    chainId: intent.chainId,
    walletAddress: intent.walletAddress.toLowerCase(),
    side: intent.side === "sell" ? "sell" : "buy",
    tokenAddress: intent.tokenAddress,
    approvals: [],
    swap: { chainId: intent.chainId, to: intent.routeTarget, data: "0x", value: "0", gasLimit: null, description: "" },
    poolId: null,
    deadline: null,
    expectedOutput: intent.expectedOutput.toFixed(),
    minimumOutput: intent.minimumOutput.toFixed(),
    quoteBlock: { number: "0", hash: "0x", timestamp: "0" },
    calldataVersion: intent.calldataVersion,
  };
}

/** One pass over the pending submissions. Safe to call repeatedly and concurrently. */
export async function reconcileOnce(deps: ReconciliationDeps): Promise<ReconciliationTickResult> {
  const logger = deps.logger ?? noopLogger;
  const result: ReconciliationTickResult = { checked: 0, confirmed: 0, reverted: 0, stillPending: 0, unavailable: 0 };

  const submissions = await pendingSubmissions(deps.db, deps.batchSize ?? 25);
  for (const submission of submissions) {
    result.checked += 1;

    const read = await deps.reader.getReceipt(submission.transactionHash);
    if (read.status === "UNAVAILABLE") {
      // An RPC outage is not evidence about the transaction. Nothing is written, and the
      // attempt counter is deliberately not advanced — otherwise a provider outage would
      // march healthy trades towards DROPPED.
      result.unavailable += 1;
      logger.warn("[reconcile] receipt unreadable", { submissionId: submission.id, reason: read.reason });
      continue;
    }

    if (read.data === null) {
      await recordMissingReceipt(deps.db, submission.id);
      result.stillPending += 1;
      continue;
    }

    const plan = planForReconcile(submission.intent);
    const venue = plan ? venueById(plan.venue) : null;
    if (!plan || !venue) {
      logger.warn("[reconcile] no venue for stored execution", { submissionId: submission.id, venue: submission.intent.venue });
      continue;
    }

    const reconciled = venue.reconcile({ plan, receipt: read.data });
    const applied = await applyReceipt(deps.db, { submissionId: submission.id, reconciled });
    if (!applied.ok) {
      logger.warn("[reconcile] refused", { submissionId: submission.id, code: applied.code, message: applied.message });
      continue;
    }
    if (reconciled.status === "CONFIRMED") result.confirmed += 1;
    else result.reverted += 1;
  }

  return result;
}

export interface ReconciliationWorkerHandle {
  stop(): void;
}

/**
 * Poll on an interval.
 *
 * Deliberately simple: reconciliation is cheap, idempotent and bounded by the number of
 * pending submissions, which is normally zero. It does not need the wakeable-loop
 * machinery the ingestion listeners use.
 */
export function startReconciliationWorker(deps: ReconciliationDeps & { intervalMs?: number }): ReconciliationWorkerHandle {
  const intervalMs = deps.intervalMs ?? 5_000;
  const logger = deps.logger ?? noopLogger;
  let stopped = false;
  let running = false;

  const timer = setInterval(() => {
    // Never overlap: a slow pass must not be joined by the next tick.
    if (stopped || running) return;
    running = true;
    reconcileOnce(deps)
      .then((tick) => {
        if (tick.confirmed || tick.reverted) logger.info("[reconcile] applied receipts", { ...tick });
      })
      .catch((error: unknown) => logger.warn("[reconcile] tick failed", { error: error instanceof Error ? error.message : String(error) }))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref?.();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
