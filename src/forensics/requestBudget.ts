/**
 * Phase 5B per-analysis request budget. This is an internal safety
 * mechanism, not an authoritative Helius billing record (phase5b.txt §7).
 */

import { AnalysisLevel } from "./types";
import {
  DEEP_FORENSICS_ENABLED,
  DEEP_FORENSICS_MAX_CREDITS_PER_TOKEN,
  FAST_FORENSICS_MAX_CREDITS_PER_TOKEN,
} from "./thresholds";

export interface RequestBudgetSnapshot {
  analysisLevel: AnalysisLevel;
  maxCredits: number;
  creditsReserved: number;
  creditsConsumed: number;
  requestsAttempted: number;
  requestsCompleted: number;
  callsByMethod: Record<string, number>;
  budgetExhausted: boolean;
}

/**
 * Tracks credits reserved/consumed and request counts for a single forensic
 * analysis run. Reserve before issuing a request; if reservation fails, the
 * caller must not issue that request and must surface `BUDGET_EXHAUSTED`.
 */
export class RequestBudget {
  private creditsReserved = 0;
  private creditsConsumed = 0;
  private requestsAttempted = 0;
  private requestsCompleted = 0;
  private readonly callsByMethod: Record<string, number> = {};
  private budgetExhausted = false;

  constructor(
    private readonly analysisLevel: AnalysisLevel,
    private readonly maxCredits: number
  ) {
    if (!Number.isSafeInteger(maxCredits) || maxCredits <= 0) {
      throw new Error(`maxCredits must be a positive safe integer, got ${maxCredits}`);
    }
  }

  /**
   * Reserve credits before issuing a request. Returns `false` (and leaves all
   * accounting untouched) if the reservation would exceed the budget — the
   * caller must not send that request.
   */
  reserve(method: string, estimatedCredits: number): boolean {
    if (this.creditsReserved + estimatedCredits > this.maxCredits) {
      this.budgetExhausted = true;
      return false;
    }
    this.creditsReserved += estimatedCredits;
    this.requestsAttempted += 1;
    this.callsByMethod[method] = (this.callsByMethod[method] ?? 0) + 1;
    return true;
  }

  /** Record actual completion (success or failure — the request was sent) of a reserved call. */
  recordCompletion(actualCredits: number): void {
    this.requestsCompleted += 1;
    this.creditsConsumed += actualCredits;
  }

  /** Release credit reserved for a request that was ultimately never sent. */
  release(estimatedCredits: number): void {
    this.creditsReserved = Math.max(0, this.creditsReserved - estimatedCredits);
  }

  get remainingCredits(): number {
    return Math.max(0, this.maxCredits - this.creditsReserved);
  }

  isExhausted(): boolean {
    return this.budgetExhausted;
  }

  snapshot(): RequestBudgetSnapshot {
    return {
      analysisLevel: this.analysisLevel,
      maxCredits: this.maxCredits,
      creditsReserved: this.creditsReserved,
      creditsConsumed: this.creditsConsumed,
      requestsAttempted: this.requestsAttempted,
      requestsCompleted: this.requestsCompleted,
      callsByMethod: { ...this.callsByMethod },
      budgetExhausted: this.budgetExhausted,
    };
  }
}

/**
 * Creates a budget using the approved FAST/DEEP defaults (env-overridable via
 * `thresholds.ts`). Throws if asked to create a DEEP budget while
 * `DEEP_FORENSICS_ENABLED` is `false` — DEEP analysis stays opt-in.
 */
export function createRequestBudget(
  analysisLevel: AnalysisLevel,
  maxCreditsOverride?: number
): RequestBudget {
  if (analysisLevel === "DEEP" && !DEEP_FORENSICS_ENABLED && maxCreditsOverride === undefined) {
    throw new Error("DEEP analysis is disabled (DEEP_FORENSICS_ENABLED=false)");
  }
  const maxCredits =
    maxCreditsOverride ??
    (analysisLevel === "DEEP" ? DEEP_FORENSICS_MAX_CREDITS_PER_TOKEN : FAST_FORENSICS_MAX_CREDITS_PER_TOKEN);
  return new RequestBudget(analysisLevel, maxCredits);
}
