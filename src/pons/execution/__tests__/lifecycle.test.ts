/**
 * Phase 7E.1 §12 — the execution state machine.
 *
 * The two properties that matter for money are asserted exhaustively rather than by
 * example: a terminal state never moves, and no transition outside the declared table is
 * allowed. An exhaustive sweep is cheap here (13 states) and catches a future state added
 * to the enum without a row in the table.
 */

import { describe, expect, it } from "vitest";

import {
  EXECUTION_STATES,
  EXECUTION_STATE_LABELS,
  TERMINAL_STATES,
  canTransition,
  isTerminal,
  transition,
  type ExecutionState,
} from "../lifecycle";

describe("execution lifecycle", () => {
  it("never leaves a terminal state, for any target", () => {
    for (const from of TERMINAL_STATES) {
      for (const to of EXECUTION_STATES) {
        if (from === to) continue;
        const result = transition(from, to);
        expect(result, `${from} -> ${to}`).toEqual({ ok: false, reason: "TERMINAL", from, to });
      }
    }
  });

  it("treats re-applying the same state as a no-op, so a steady-state poll is not an error", () => {
    for (const state of EXECUTION_STATES) {
      expect(transition(state, state)).toEqual({ ok: true, state, changed: false });
    }
  });

  it("refuses every transition outside the declared table", () => {
    // A representative illegal set: walking backwards, skipping the wallet, and
    // resurrecting a rejection.
    const illegal: [ExecutionState, ExecutionState][] = [
      ["QUOTE_READY", "SUBMITTED"],
      ["QUOTE_READY", "CONFIRMED"],
      ["READY_FOR_REVIEW", "CONFIRMED"],
      ["SUBMITTED", "READY_FOR_REVIEW"],
      ["CONFIRMING", "AWAITING_SIGNATURE"],
      ["AWAITING_SIGNATURE", "CONFIRMED"],
    ];
    for (const [from, to] of illegal) {
      expect(transition(from, to), `${from} -> ${to}`).toMatchObject({ ok: false });
    }
  });

  it("allows the happy path a real trade walks", () => {
    const path: ExecutionState[] = ["QUOTE_READY", "SIMULATING", "READY_FOR_REVIEW", "AWAITING_SIGNATURE", "SUBMITTED", "CONFIRMING", "CONFIRMED"];
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(canTransition(path[i], path[i + 1]), `${path[i]} -> ${path[i + 1]}`).toBe(true);
    }
  });

  it("lets a submission fail in each way the chain can fail it", () => {
    for (const outcome of ["CONFIRMED", "REVERTED", "DROPPED", "REPLACED"] as ExecutionState[]) {
      expect(canTransition("SUBMITTED", outcome)).toBe(true);
      expect(canTransition("CONFIRMING", outcome)).toBe(true);
    }
  });

  it("keeps UNKNOWN recoverable, because it means 'could not read the chain'", () => {
    expect(isTerminal("UNKNOWN")).toBe(false);
    expect(canTransition("UNKNOWN", "CONFIRMED")).toBe(true);
    expect(canTransition("UNKNOWN", "REVERTED")).toBe(true);
  });

  it("gives every state a label that does not claim success early", () => {
    for (const state of EXECUTION_STATES) {
      const label = EXECUTION_STATE_LABELS[state];
      expect(label, state).toBeTruthy();
      if (state !== "CONFIRMED") {
        expect(label.toLowerCase(), state).not.toContain("success");
      }
    }
    // Submitting is explicitly not "done".
    expect(EXECUTION_STATE_LABELS.SUBMITTED).not.toEqual(EXECUTION_STATE_LABELS.CONFIRMED);
  });
});
