import { describe, expect, it } from "vitest";
import { createRequestBudget, RequestBudget } from "../requestBudget";

describe("RequestBudget", () => {
  it("reserves and completes credits, tracking calls by method", () => {
    const budget = new RequestBudget("FAST", 25);
    expect(budget.reserve("getTokenSupply", 1)).toBe(true);
    budget.recordCompletion(1);
    expect(budget.reserve("getTokenAccounts", 10)).toBe(true);
    budget.recordCompletion(10);

    const snapshot = budget.snapshot();
    expect(snapshot.requestsAttempted).toBe(2);
    expect(snapshot.requestsCompleted).toBe(2);
    expect(snapshot.creditsReserved).toBe(11);
    expect(snapshot.creditsConsumed).toBe(11);
    expect(snapshot.callsByMethod).toEqual({ getTokenSupply: 1, getTokenAccounts: 1 });
    expect(snapshot.budgetExhausted).toBe(false);
  });

  it("refuses a reservation that would exceed the budget and marks it exhausted", () => {
    const budget = new RequestBudget("FAST", 5);
    expect(budget.reserve("getTokenAccounts", 10)).toBe(false);
    const snapshot = budget.snapshot();
    expect(snapshot.creditsReserved).toBe(0);
    expect(snapshot.requestsAttempted).toBe(0);
    expect(snapshot.budgetExhausted).toBe(true);
  });

  it("stops reserving once cumulative reservations would exceed the cap", () => {
    const budget = new RequestBudget("FAST", 15);
    expect(budget.reserve("a", 10)).toBe(true);
    expect(budget.reserve("a", 10)).toBe(false); // 10 + 10 > 15
    expect(budget.snapshot().budgetExhausted).toBe(true);
    expect(budget.snapshot().creditsReserved).toBe(10);
  });

  it("release() frees credit for a request that was never sent", () => {
    const budget = new RequestBudget("FAST", 10);
    expect(budget.reserve("a", 10)).toBe(true);
    budget.release(10);
    expect(budget.remainingCredits).toBe(10);
    expect(budget.reserve("b", 10)).toBe(true);
  });

  it("rejects a non-positive or unsafe maxCredits at construction", () => {
    expect(() => new RequestBudget("FAST", 0)).toThrow();
    expect(() => new RequestBudget("FAST", -1)).toThrow();
    expect(() => new RequestBudget("FAST", Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });
});

describe("createRequestBudget", () => {
  it("creates a FAST budget with the approved default", () => {
    const budget = createRequestBudget("FAST");
    expect(budget.snapshot().maxCredits).toBe(75);
  });

  it("refuses to create a DEEP budget when DEEP_FORENSICS_ENABLED is false (the approved default)", () => {
    expect(() => createRequestBudget("DEEP")).toThrow(/disabled/);
  });

  it("allows an explicit override even when DEEP is disabled by default (caller opts in explicitly)", () => {
    const budget = createRequestBudget("DEEP", 300);
    expect(budget.snapshot().maxCredits).toBe(300);
  });
});
