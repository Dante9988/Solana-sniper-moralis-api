/**
 * Jupiter API contract.
 *
 * The offline half runs always and pins what the service sends and reads. The live half is
 * opt-in and calls Jupiter for real, because the failure this file exists to prevent was not
 * a logic bug — `quote-api.jup.ag` was retired and stopped resolving, and nothing in the
 * codebase noticed. A unit test with a mocked axios would have stayed green throughout.
 *
 *   JUPITER_RUN_LIVE_TEST=true npx vitest run src/services/__tests__/jupiterContract.test.ts
 */

import { describe, expect, it } from "vitest";

const RUN_LIVE = process.env.JUPITER_RUN_LIVE_TEST === "true";

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** A well-known public address, used read-only to shape a swap request. Never signed with. */
const PUBLIC_OWNER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

/** Jupiter's responses are untyped JSON; this is the shape the service relies on. */
type JsonRecord = Record<string, unknown>;

function base(env: NodeJS.ProcessEnv): string {
  return env.JUPITER_API_BASE?.trim() || (env.JUPITER_API_KEY?.trim() ? "https://api.jup.ag/swap/v1" : "https://lite-api.jup.ag/swap/v1");
}

describe("Jupiter endpoint selection", () => {
  it("defaults to the keyless tier", () => {
    expect(base({} as NodeJS.ProcessEnv)).toBe("https://lite-api.jup.ag/swap/v1");
  });

  it("uses the keyed tier when a key is present", () => {
    expect(base({ JUPITER_API_KEY: "k" } as NodeJS.ProcessEnv)).toBe("https://api.jup.ag/swap/v1");
  });

  it("never points at the retired host", () => {
    // quote-api.jup.ag returned DNS ENOTFOUND on 2026-09-26. If it ever comes back, it is
    // still not the endpoint this service should use.
    for (const env of [{}, { JUPITER_API_KEY: "k" }, { JUPITER_API_BASE: "https://example.test/swap/v1" }]) {
      expect(base(env as NodeJS.ProcessEnv)).not.toContain("quote-api.jup.ag");
    }
  });

  it("lets an operator override the base entirely", () => {
    expect(base({ JUPITER_API_BASE: "https://example.test/swap/v1" } as NodeJS.ProcessEnv)).toBe("https://example.test/swap/v1");
  });
});

describe.skipIf(!RUN_LIVE)("Jupiter live contract", () => {
  it("quotes, and does NOT carry the decimals the old code read", async () => {
    const res = await fetch(`${base(process.env)}/quote?inputMint=${SOL}&outputMint=${USDC}&amount=10000000&slippageBps=100`);
    expect(res.status).toBe(200);
    const quote = (await res.json()) as JsonRecord;

    expect(quote.inAmount).toBe("10000000");
    expect(Number(quote.outAmount)).toBeGreaterThan(0);
    // `otherAmountThreshold` is the minimum the swap may deliver — what a user is promised.
    expect(Number(quote.otherAmountThreshold)).toBeGreaterThan(0);
    expect(Number(quote.otherAmountThreshold)).toBeLessThanOrEqual(Number(quote.outAmount));

    // The bug this pins: the response has neither field, and the old code read both,
    // defaulting decimals to 9 for every token. USDC has 6.
    expect(quote).not.toHaveProperty("outputDecimals");
    expect(quote).not.toHaveProperty("price");
  }, 30_000);

  it("builds an unsigned swap transaction for a public key", async () => {
    const quote = await fetch(`${base(process.env)}/quote?inputMint=${SOL}&outputMint=${USDC}&amount=10000000&slippageBps=100`).then((r) => r.json() as Promise<JsonRecord>);
    const res = await fetch(`${base(process.env)}/swap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quoteResponse: quote, userPublicKey: PUBLIC_OWNER, wrapAndUnwrapSol: true }),
    });
    expect(res.status).toBe(200);
    const swap = (await res.json()) as JsonRecord;

    expect(typeof swap.swapTransaction).toBe("string");
    expect(String(swap.swapTransaction).length).toBeGreaterThan(100);
    // Jupiter simulates before returning; the service refuses a route that already failed.
    expect(swap.simulationError ?? null).toBeNull();
  }, 30_000);

  it("shows why the legacy wrap flag was invisible: it is ignored, not rejected", async () => {
    const quote = await fetch(`${base(process.env)}/quote?inputMint=${SOL}&outputMint=${USDC}&amount=10000000&slippageBps=100`).then((r) => r.json() as Promise<JsonRecord>);
    const res = await fetch(`${base(process.env)}/swap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // The old body: a misspelled wrap flag and a parameter that no longer exists.
      body: JSON.stringify({ quoteResponse: quote, userPublicKey: PUBLIC_OWNER, wrapUnwrapSOL: true, useJitoTip: false }),
    });
    // 200. Unknown keys are dropped silently, so the mistake never surfaced as an error.
    expect(res.status).toBe(200);
  }, 30_000);
});
