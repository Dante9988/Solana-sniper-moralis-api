import { describe, expect, it, vi } from "vitest";
import { createTokenIntelligenceDispatcher, deriveTokenSource } from "../tokenIntelligenceDispatch";
import { PUMPSWAP_PROGRAM_ID, PUMP_FUN_RAYDIUM_MIGRATION, PUMP_FUN_PROGRAM_ID } from "../pumpswapService";
import { TokenIntelligenceReport } from "../../intelligence/types";

const emptyReport = {} as TokenIntelligenceReport;

describe("deriveTokenSource", () => {
  it("maps the real PumpSwap AMM program id to PUMPSWAP", () => {
    expect(deriveTokenSource(PUMPSWAP_PROGRAM_ID.toBase58())).toBe("PUMPSWAP");
  });

  it("maps the Raydium migration program id to MIGRATION", () => {
    expect(deriveTokenSource(PUMP_FUN_RAYDIUM_MIGRATION.toBase58())).toBe("MIGRATION");
  });

  it("falls back to UNKNOWN for the mislabeled pump.fun bonding-curve program id currently configured as 'pumpswap'", () => {
    expect(deriveTokenSource(PUMP_FUN_PROGRAM_ID.toBase58())).toBe("UNKNOWN");
  });

  it("falls back to UNKNOWN for an unrecognized or missing program id", () => {
    expect(deriveTokenSource(undefined)).toBe("UNKNOWN");
    expect(deriveTokenSource("SomeOtherProgramId")).toBe("UNKNOWN");
  });
});

describe("createTokenIntelligenceDispatcher", () => {
  it("builds and forwards a TokenDiscoveryEvent preserving signature, mint, source and raw payload", () => {
    const processEvent = vi.fn().mockResolvedValue(emptyReport);
    const rawPayload = { logs: ["Program log: Instruction: CreatePool"], signature: "sig-1" };
    const { dispatch } = createTokenIntelligenceDispatcher({
      processEvent,
      idFactory: () => "evt-1",
      now: () => new Date("2026-01-01T00:00:00Z"),
    });

    dispatch("sig-1", "MintAAA", PUMPSWAP_PROGRAM_ID.toBase58(), rawPayload);

    expect(processEvent).toHaveBeenCalledTimes(1);
    expect(processEvent).toHaveBeenCalledWith({
      id: "evt-1",
      source: "PUMPSWAP",
      signature: "sig-1",
      mint: "MintAAA",
      discoveredAt: new Date("2026-01-01T00:00:00Z"),
      receivedAt: new Date("2026-01-01T00:00:00Z"),
      rawPayload,
    });
  });

  it("returns synchronously without waiting for research to complete", () => {
    const processEvent = vi.fn(() => new Promise<TokenIntelligenceReport>(() => {}));
    const { dispatch } = createTokenIntelligenceDispatcher({ processEvent });

    const start = Date.now();
    dispatch("sig-2", "MintBBB", undefined, {});
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(50);
  });

  it("deduplicates by signature+mint and does not dispatch the same discovery twice", () => {
    const processEvent = vi.fn().mockResolvedValue(emptyReport);
    const { dispatch } = createTokenIntelligenceDispatcher({ processEvent });

    dispatch("sig-3", "MintCCC", undefined, {});
    dispatch("sig-3", "MintCCC", undefined, {});

    expect(processEvent).toHaveBeenCalledTimes(1);
  });

  it("treats the same signature with a different mint as a distinct discovery", () => {
    const processEvent = vi.fn().mockResolvedValue(emptyReport);
    const { dispatch } = createTokenIntelligenceDispatcher({ processEvent });

    dispatch("sig-4", "MintDDD", undefined, {});
    dispatch("sig-4", "MintEEE", undefined, {});

    expect(processEvent).toHaveBeenCalledTimes(2);
  });

  it("enforces bounded concurrency by skipping dispatch once the limit is reached", () => {
    const processEvent = vi.fn(() => new Promise<TokenIntelligenceReport>(() => {}));
    const dispatcher = createTokenIntelligenceDispatcher({ processEvent, maxConcurrent: 1 });

    dispatcher.dispatch("sig-5", "MintFFF", undefined, {});
    dispatcher.dispatch("sig-6", "MintGGG", undefined, {});

    expect(processEvent).toHaveBeenCalledTimes(1);
    expect(dispatcher.activeJobs).toBe(1);
  });

  it("never throws when the research pipeline throws synchronously", () => {
    const processEvent = vi.fn(() => {
      throw new Error("boom");
    });
    const dispatcher = createTokenIntelligenceDispatcher({ processEvent });

    expect(() => dispatcher.dispatch("sig-7", "MintHHH", undefined, {})).not.toThrow();
    // slot must be released so the pipeline isn't permanently jammed
    expect(dispatcher.activeJobs).toBe(0);
  });

  it("never throws and leaves no unhandled rejection when the research pipeline rejects", async () => {
    const processEvent = vi.fn().mockRejectedValue(new Error("api down"));
    const { dispatch } = createTokenIntelligenceDispatcher({ processEvent });

    expect(() => dispatch("sig-8", "MintIII", undefined, {})).not.toThrow();
    // Let the rejection's .catch() handler run; vitest fails the test run on
    // any unhandled rejection surfaced during this tick.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("frees the concurrency slot after the timeout elapses even if research is still running", async () => {
    const processEvent = vi.fn(() => new Promise<TokenIntelligenceReport>(() => {})); // never resolves
    const dispatcher = createTokenIntelligenceDispatcher({ processEvent, maxConcurrent: 1, timeoutMs: 10 });

    dispatcher.dispatch("sig-9", "MintJJJ", undefined, {});
    expect(dispatcher.activeJobs).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(dispatcher.activeJobs).toBe(0);

    dispatcher.dispatch("sig-10", "MintKKK", undefined, {});
    expect(processEvent).toHaveBeenCalledTimes(2);
  });
});
