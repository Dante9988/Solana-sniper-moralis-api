/**
 * Phase 7E.1 §13–§15 — persistence, idempotency and reconciliation for real trades.
 *
 * Three rules shape everything here:
 *
 *   §3  Non-custodial. Nothing in this file accepts, stores or returns a private key, seed
 *       phrase or signature. A wallet signs; we record the hash it reports.
 *   §14 Every write is idempotent. A reload, a reconnect or a double click must not create
 *       a second trade, and the guarantee is a PostgreSQL unique constraint, not a check.
 *   §15 The browser is not the source of truth. A tab can close between signing and
 *       confirmation, so state after SUBMITTED comes from chain receipts.
 */

import { Prisma, type ExecutionState, type PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";

import { canTransition, isTerminal } from "../pons/execution/lifecycle";
import type { ExecutionPlan, ReconciledExecution } from "../pons/execution/venue";
import type { PonsQuote } from "../pons/quote/quoteService";

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/** After this many failed lookups a hash the chain has never heard of becomes DROPPED. */
export const MAX_RECONCILE_ATTEMPTS = 20;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Stable JSON so the same request always fingerprints the same way regardless of key
 * order. Reused from the paper-trading service's approach deliberately: one canonicaliser,
 * one behaviour.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export type CreateIntentResult =
  | { ok: true; created: boolean; intentId: string }
  | { ok: false; code: "IDEMPOTENCY_KEY_REUSED" | "QUOTE_NOT_FOUND"; message: string };

export interface CreateIntentParams {
  userId: string;
  idempotencyKey: string;
  plan: ExecutionPlan;
  quote: PonsQuote;
  quoteSnapshotId: string;
  simulationSnapshotId: string | null;
}

/**
 * Record the intent behind one wallet prompt.
 *
 * The fingerprint covers what the user would be signing — the calldata, the target, the
 * value and the minimum output — so reusing a key for a *different* trade is refused
 * rather than silently replayed as the first one. Reusing it for the *same* trade returns
 * the original row, which is exactly what a retry after a dropped response needs.
 */
export async function createExecutionIntent(db: PrismaClient, params: CreateIntentParams): Promise<CreateIntentResult> {
  const { plan, quote } = params;
  const fingerprint = sha256(
    canonicalJson({
      to: plan.swap.to,
      data: plan.swap.data,
      value: plan.swap.value,
      wallet: plan.walletAddress,
      minimumOutput: plan.minimumOutput,
      quoteSnapshotId: params.quoteSnapshotId,
    })
  );

  const existing = await db.executionIntent.findUnique({
    where: { userId_idempotencyKey: { userId: params.userId, idempotencyKey: params.idempotencyKey } },
  });
  if (existing) {
    if (existing.requestFingerprint !== fingerprint) {
      return { ok: false, code: "IDEMPOTENCY_KEY_REUSED", message: "this idempotency key was already used for a different trade" };
    }
    return { ok: true, created: false, intentId: existing.id };
  }

  const snapshot = await db.evidenceSnapshot.findUnique({ where: { id: params.quoteSnapshotId } });
  if (!snapshot || snapshot.kind !== "QUOTE") {
    return { ok: false, code: "QUOTE_NOT_FOUND", message: "no such quote" };
  }

  try {
    const intent = await db.executionIntent.create({
      data: {
        userId: params.userId,
        idempotencyKey: params.idempotencyKey,
        requestFingerprint: fingerprint,
        chain: quote.chain,
        chainId: plan.chainId,
        walletAddress: plan.walletAddress,
        tokenAddress: plan.tokenAddress,
        side: plan.side,
        venue: plan.venue,
        route: plan.route.kind,
        routeTarget: plan.route.target,
        inputCurrency: quote.input.currency,
        inputSymbol: quote.input.symbol,
        inputDecimals: quote.input.decimals,
        inputAmount: new Prisma.Decimal(quote.input.amount),
        outputCurrency: quote.output.currency,
        outputSymbol: quote.output.symbol,
        outputDecimals: quote.output.decimals,
        expectedOutput: new Prisma.Decimal(plan.expectedOutput),
        minimumOutput: new Prisma.Decimal(plan.minimumOutput),
        slippageBps: quote.slippageBps,
        deadline: plan.deadline === null ? null : BigInt(plan.deadline),
        calldata: plan.swap.data,
        callValue: new Prisma.Decimal(plan.swap.value),
        calldataVersion: plan.calldataVersion,
        quoteSnapshotId: params.quoteSnapshotId,
        simulationSnapshotId: params.simulationSnapshotId,
        state: "READY_FOR_REVIEW",
      },
    });
    return { ok: true, created: true, intentId: intent.id };
  } catch (error) {
    // Two identical requests racing: the loser reads the winner's row.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const winner = await db.executionIntent.findUnique({
        where: { userId_idempotencyKey: { userId: params.userId, idempotencyKey: params.idempotencyKey } },
      });
      if (winner) {
        if (winner.requestFingerprint !== fingerprint) {
          return { ok: false, code: "IDEMPOTENCY_KEY_REUSED", message: "this idempotency key was already used for a different trade" };
        }
        return { ok: true, created: false, intentId: winner.id };
      }
    }
    throw error;
  }
}

export type RecordSubmissionResult =
  | { ok: true; created: boolean; submissionId: string }
  | { ok: false; code: "INTENT_NOT_FOUND" | "INVALID_HASH" | "HASH_BELONGS_TO_ANOTHER_INTENT" | "ILLEGAL_STATE"; message: string };

/**
 * Record the transaction hash a wallet returned.
 *
 * `@@unique([chain, transactionHash])` means one hash reconciles to exactly one submitted
 * execution (§14). A hash arriving twice for the SAME intent replays; the same hash
 * claimed by a DIFFERENT intent is refused, because one of the two claims must be wrong
 * and guessing which would corrupt both records.
 *
 * This does NOT mark the trade successful. It moves to SUBMITTED, and only a receipt can
 * take it further (§2).
 */
export async function recordSubmission(
  db: PrismaClient,
  params: { userId: string; intentId: string; transactionHash: string; observedFromBlock?: bigint | null }
): Promise<RecordSubmissionResult> {
  if (!TX_HASH_RE.test(params.transactionHash)) {
    return { ok: false, code: "INVALID_HASH", message: "transactionHash must be a 32-byte hex hash" };
  }
  const hash = params.transactionHash.toLowerCase();

  const intent = await db.executionIntent.findFirst({ where: { id: params.intentId, userId: params.userId } });
  if (!intent) return { ok: false, code: "INTENT_NOT_FOUND", message: "no such trade" };

  const existing = await db.submittedExecution.findUnique({ where: { chain_transactionHash: { chain: intent.chain, transactionHash: hash } } });
  if (existing) {
    if (existing.intentId !== intent.id) {
      return { ok: false, code: "HASH_BELONGS_TO_ANOTHER_INTENT", message: "this transaction is already recorded against a different trade" };
    }
    return { ok: true, created: false, submissionId: existing.id };
  }

  if (isTerminal(intent.state) || !canTransition(intent.state, "SUBMITTED")) {
    return { ok: false, code: "ILLEGAL_STATE", message: `a trade in state ${intent.state} cannot accept a submission` };
  }

  try {
    const submission = await db.$transaction(async (tx) => {
      const created = await tx.submittedExecution.create({
        data: {
          intentId: intent.id,
          chain: intent.chain,
          transactionHash: hash,
          walletAddress: intent.walletAddress,
          observedFromBlock: params.observedFromBlock ?? null,
        },
      });
      await tx.executionIntent.update({ where: { id: intent.id }, data: { state: "SUBMITTED" } });
      return created;
    });
    return { ok: true, created: true, submissionId: submission.id };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const winner = await db.submittedExecution.findUnique({ where: { chain_transactionHash: { chain: intent.chain, transactionHash: hash } } });
      if (winner) {
        if (winner.intentId !== intent.id) {
          return { ok: false, code: "HASH_BELONGS_TO_ANOTHER_INTENT", message: "this transaction is already recorded against a different trade" };
        }
        return { ok: true, created: false, submissionId: winner.id };
      }
    }
    throw error;
  }
}

export type ApplyReceiptResult =
  | { ok: true; state: ExecutionState; changed: boolean }
  | { ok: false; code: "SUBMISSION_NOT_FOUND" | "ILLEGAL_TRANSITION"; message: string };

/**
 * Write what the chain said, once.
 *
 * A terminal intent is left alone: a late poll must not overwrite CONFIRMED with DROPPED,
 * and re-applying the same receipt is a no-op rather than an error, because reconciliation
 * runs on a loop.
 */
export async function applyReceipt(
  db: PrismaClient,
  params: { submissionId: string; reconciled: ReconciledExecution }
): Promise<ApplyReceiptResult> {
  const submission = await db.submittedExecution.findUnique({ where: { id: params.submissionId }, include: { intent: true, receipt: true } });
  if (!submission) return { ok: false, code: "SUBMISSION_NOT_FOUND", message: "no such submission" };

  const target = params.reconciled.status;
  if (isTerminal(submission.intent.state)) {
    return { ok: true, state: submission.intent.state, changed: false };
  }
  if (!canTransition(submission.intent.state, target)) {
    return { ok: false, code: "ILLEGAL_TRANSITION", message: `cannot move from ${submission.intent.state} to ${target}` };
  }

  const r = params.reconciled;
  const receiptData = {
    status: target,
    blockNumber: BigInt(r.blockNumber),
    blockHash: r.blockHash,
    gasUsed: new Prisma.Decimal(r.gasUsed),
    effectiveGasPrice: r.effectiveGasPrice === null ? null : new Prisma.Decimal(r.effectiveGasPrice),
    actualInput: r.actualInput === null ? null : new Prisma.Decimal(r.actualInput),
    actualOutput: r.actualOutput === null ? null : new Prisma.Decimal(r.actualOutput),
    matchedWallet: r.matchedWallet,
    failureReason: r.failureReason,
  };

  await db.$transaction(async (tx) => {
    await tx.executionReceipt.upsert({
      where: { submissionId: submission.id },
      create: { submissionId: submission.id, ...receiptData },
      update: receiptData,
    });
    await tx.submittedExecution.update({
      where: { id: submission.id },
      data: { lastReconciledAt: new Date(), reconcileAttempts: { increment: 1 } },
    });
    await tx.executionIntent.update({ where: { id: submission.intent.id }, data: { state: target, failureReason: r.failureReason } });
  });
  return { ok: true, state: target, changed: true };
}

/**
 * A hash the chain has never heard of.
 *
 * Counted rather than acted on immediately: a node that has not yet seen a freshly
 * broadcast transaction is normal, and calling that DROPPED on the first miss would
 * routinely mislabel healthy trades. Only after MAX_RECONCILE_ATTEMPTS does it become
 * DROPPED; until then the intent sits in CONFIRMING, which says "still checking".
 */
export async function recordMissingReceipt(db: PrismaClient, submissionId: string): Promise<ExecutionState | null> {
  const submission = await db.submittedExecution.findUnique({ where: { id: submissionId }, include: { intent: true } });
  if (!submission) return null;
  if (isTerminal(submission.intent.state)) return submission.intent.state;

  const attempts = submission.reconcileAttempts + 1;
  const target: ExecutionState = attempts >= MAX_RECONCILE_ATTEMPTS ? "DROPPED" : "CONFIRMING";

  await db.$transaction(async (tx) => {
    await tx.submittedExecution.update({ where: { id: submission.id }, data: { reconcileAttempts: attempts, lastReconciledAt: new Date() } });
    if (canTransition(submission.intent.state, target)) {
      await tx.executionIntent.update({
        where: { id: submission.intent.id },
        data: {
          state: target,
          failureReason: target === "DROPPED" ? "the network never mined this transaction" : null,
        },
      });
    }
  });
  return target;
}

/** §15 — what to restore when the user reopens the app. */
export async function listExecutions(db: PrismaClient, userId: string, limit = 50) {
  return db.executionIntent.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { submissions: { include: { receipt: true }, orderBy: { submittedAt: "desc" } } },
  });
}

export async function getExecution(db: PrismaClient, userId: string, intentId: string) {
  return db.executionIntent.findFirst({
    where: { id: intentId, userId },
    include: { submissions: { include: { receipt: true }, orderBy: { submittedAt: "desc" } } },
  });
}

/** Submissions still worth polling: not terminal, oldest check first. */
export async function pendingSubmissions(db: PrismaClient, limit = 25) {
  return db.submittedExecution.findMany({
    where: { intent: { state: { in: ["SUBMITTED", "CONFIRMING", "UNKNOWN"] } } },
    orderBy: [{ lastReconciledAt: { sort: "asc", nulls: "first" } }],
    take: limit,
    include: { intent: true },
  });
}
