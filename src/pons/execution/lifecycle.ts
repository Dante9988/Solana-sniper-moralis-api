/**
 * Phase 7E.1 §12 — the execution state machine.
 *
 * This is the backend's copy of the truth. The frontend has its own reducer
 * (`state/tradeMachine.ts`), but a browser can close mid-flight, so the states that
 * outlive a tab — SUBMITTED onward — are decided here from chain receipts (§15).
 *
 * Two rules are load-bearing and tested:
 *   - a terminal state never changes again, so a late reconciliation cannot resurrect a
 *     finished trade or overwrite CONFIRMED with DROPPED;
 *   - a transition that is not in TRANSITIONS is refused rather than applied, so an
 *     out-of-order webhook or a retried poll cannot walk the machine backwards.
 */

export const EXECUTION_STATES = [
  "QUOTE_READY",
  "SIMULATING",
  "SIMULATION_FAILED",
  "READY_FOR_REVIEW",
  "AWAITING_SIGNATURE",
  "USER_REJECTED",
  "SUBMITTED",
  "CONFIRMING",
  "CONFIRMED",
  "REVERTED",
  "DROPPED",
  "REPLACED",
  "UNKNOWN",
] as const;

export type ExecutionState = (typeof EXECUTION_STATES)[number];

/** Once reached, the record is final. */
export const TERMINAL_STATES: readonly ExecutionState[] = Object.freeze([
  "CONFIRMED",
  "REVERTED",
  "USER_REJECTED",
  "SIMULATION_FAILED",
  "REPLACED",
  "DROPPED",
]);

/**
 * `UNKNOWN` is deliberately not terminal. It is what a submission becomes when the chain
 * cannot be read, and the whole point is that a later read can still resolve it.
 */
const TRANSITIONS: Readonly<Record<ExecutionState, readonly ExecutionState[]>> = Object.freeze({
  QUOTE_READY: ["SIMULATING", "READY_FOR_REVIEW", "USER_REJECTED"],
  SIMULATING: ["READY_FOR_REVIEW", "SIMULATION_FAILED"],
  SIMULATION_FAILED: [],
  READY_FOR_REVIEW: ["AWAITING_SIGNATURE", "USER_REJECTED"],
  AWAITING_SIGNATURE: ["SUBMITTED", "USER_REJECTED"],
  USER_REJECTED: [],
  SUBMITTED: ["CONFIRMING", "CONFIRMED", "REVERTED", "DROPPED", "REPLACED", "UNKNOWN"],
  CONFIRMING: ["CONFIRMED", "REVERTED", "DROPPED", "REPLACED", "UNKNOWN"],
  CONFIRMED: [],
  REVERTED: [],
  DROPPED: [],
  REPLACED: [],
  UNKNOWN: ["CONFIRMED", "REVERTED", "DROPPED", "REPLACED", "CONFIRMING"],
});

export function isTerminal(state: ExecutionState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function canTransition(from: ExecutionState, to: ExecutionState): boolean {
  if (from === to) return true; // Idempotent re-application of the same state is a no-op, not an error.
  return TRANSITIONS[from].includes(to);
}

export type TransitionResult =
  | { ok: true; state: ExecutionState; changed: boolean }
  | { ok: false; reason: "TERMINAL" | "ILLEGAL"; from: ExecutionState; to: ExecutionState };

/**
 * Apply a transition, or explain why not.
 *
 * Reconciliation calls this for every poll, so "already in that state" must be a success
 * with `changed: false` rather than a failure — otherwise a steady-state poll would log an
 * error on every tick.
 */
export function transition(from: ExecutionState, to: ExecutionState): TransitionResult {
  if (from === to) return { ok: true, state: from, changed: false };
  if (isTerminal(from)) return { ok: false, reason: "TERMINAL", from, to };
  if (!canTransition(from, to)) return { ok: false, reason: "ILLEGAL", from, to };
  return { ok: true, state: to, changed: true };
}

/**
 * User-facing wording. §12: "Frontend language should be user friendly" — but the backend
 * owns the mapping so an API consumer and the UI cannot drift apart.
 *
 * Nothing here says "success" before a confirmed chain result exists (§2).
 */
export const EXECUTION_STATE_LABELS: Readonly<Record<ExecutionState, string>> = Object.freeze({
  QUOTE_READY: "Quote ready",
  SIMULATING: "Checking the trade",
  SIMULATION_FAILED: "This trade would fail",
  READY_FOR_REVIEW: "Ready to review",
  AWAITING_SIGNATURE: "Waiting for your wallet",
  USER_REJECTED: "You cancelled this trade",
  SUBMITTED: "Sent to the network",
  CONFIRMING: "Confirming",
  CONFIRMED: "Done",
  REVERTED: "The trade did not go through",
  DROPPED: "The network dropped this transaction",
  REPLACED: "Replaced by another transaction",
  UNKNOWN: "Still checking with the network",
});
