import { describe, expect, it, vi } from "vitest";

import { JupiterProvider, type JupiterQuoteResponse } from "../providers/jupiterProvider";
import type { AssetIdentity } from "../assetIdentity";
import type { QuoteRequest } from "../contract";

/**
 * Phase 7D.5.1 — Jupiter as a non-custodial provider.
 *
 * Shapes taken from a real response captured 2026-09-20 against
 * `lite-api.jup.ag/swap/v1/quote` (see docs/phase-7d5-1/source-matrix.md). The old
 * `quote-api.jup.ag/v6` host was probed the same day and is unreachable.
 */

const SOL: AssetIdentity = { network: "solana", kind: "token", address: "So11111111111111111111111111111111111111112", decimals: 9, symbol: "SOL", name: "Wrapped SOL" };
const USDC: AssetIdentity = { network: "solana", kind: "token", address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6, symbol: "USDC", name: "USD Coin" };
const ETH: AssetIdentity = { network: "ethereum", kind: "native", address: null, decimals: 18, symbol: "ETH", name: "Ether" };

const request: QuoteRequest = { input: SOL, output: USDC, amountRaw: "100000000", slippageBps: 50, account: "9xQeWvG816bUx9EPvHmaT23yvVM2ZHbGrRvbGxbQ4Uvb" };

/** Field-for-field the live response, trimmed to what the adapter reads. */
function liveQuote(over: Partial<JupiterQuoteResponse> = {}): JupiterQuoteResponse {
  return {
    inputMint: SOL.address!,
    inAmount: "100000000",
    outputMint: USDC.address!,
    outAmount: "10982531",
    otherAmountThreshold: "10927619",
    swapMode: "ExactIn",
    slippageBps: 50,
    priceImpactPct: "0",
    contextSlot: 448855804,
    platformFee: null,
    routePlan: [{ swapInfo: { label: "Kipseli" } }],
    ...over,
  };
}

function provider(json: unknown, ok = true, status = 200) {
  const fetchImpl = vi.fn(async () => ({ ok, status, json: async () => json })) as unknown as typeof fetch;
  return { p: new JupiterProvider({ fetchImpl, now: () => 1_000, baseUrl: "https://lite-api.jup.ag" }), fetchImpl };
}

describe("Jupiter provider", () => {
  it("routes Solana only, and says so plainly for other chains", async () => {
    const { p } = provider(liveQuote());
    const cap = await p.capability(ETH, USDC);
    expect(cap.supported).toBe(false);
    expect(cap.reason).toMatch(/Solana tokens only/);
  });

  it("refuses a native identity instead of guessing the wrapped mint", async () => {
    const { p } = provider(liveQuote());
    const nativeSol: AssetIdentity = { ...SOL, kind: "native", address: null };
    const cap = await p.capability(nativeSol, USDC);
    expect(cap.supported).toBe(false);
    expect(cap.reason).toMatch(/wrapped mint/);
  });

  it("calls the current swap/v1 endpoint, not the dead v6 host", async () => {
    const { p, fetchImpl } = provider(liveQuote());
    await p.quote(request);
    const url = (fetchImpl as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(url).toContain("/swap/v1/quote");
    expect(url).not.toContain("quote-api.jup.ag");
    expect(url).not.toContain("/v6/");
  });

  it("maps otherAmountThreshold to minimumReceived — the number that binds", async () => {
    const { p } = provider(liveQuote());
    const q = await p.quote(request);
    expect(q.output.expected.raw).toBe("10982531");
    expect(q.output.minimumReceived.raw).toBe("10927619");
    // And exposes both in exact decimals at USDC's 6 places.
    expect(q.output.expected.decimal).toBe("10.982531");
    expect(q.output.minimumReceived.decimal).toBe("10.927619");
  });

  it("binds the quote to the account, assets, amount and slippage", async () => {
    const { p } = provider(liveQuote());
    const q = await p.quote(request);
    expect(q.boundTo).toEqual({
      account: request.account,
      network: "solana",
      inputAsset: `solana:${SOL.address}`,
      outputAsset: `solana:${USDC.address}`,
      inputRaw: "100000000",
      slippageBps: 50,
    });
  });

  it("expires quickly, because a stale route is worse than asking for a refresh", async () => {
    const { p } = provider(liveQuote());
    const q = await p.quote(request);
    expect(q.expiresAt).toBeGreaterThan(1_000);
    expect(q.expiresAt - 1_000).toBeLessThanOrEqual(30_000);
  });

  it("reports a missing route as a product state rather than an empty success", async () => {
    const { p } = provider(liveQuote({ routePlan: [] }));
    await expect(p.quote(request)).rejects.toThrow(/No Jupiter route/);
  });

  it("refuses ExactOut, where otherAmountThreshold means the opposite bound", async () => {
    // Reporting a maximum-in as a minimum-out would understate the worst case.
    const { p } = provider(liveQuote({ swapMode: "ExactOut" }));
    await expect(p.quote(request)).rejects.toThrow(/ExactIn only/);
  });

  it("surfaces a platform fee when one is charged", async () => {
    const { p } = provider(liveQuote({ platformFee: { amount: "5000", feeBps: 5 } }));
    const q = await p.quote(request);
    expect(q.fees).toEqual([expect.objectContaining({ kind: "provider", amount: expect.objectContaining({ raw: "5000" }) })]);
  });

  it("returns an unsigned transaction and never a key", async () => {
    const { p } = provider({ swapTransaction: "BASE64TX", lastValidBlockHeight: 42 });
    const q = { providerData: liveQuote(), quoteId: "q" } as never;
    const exec = await p.prepare(q, request);
    expect(exec).toEqual({ kind: "solana_transaction", base64: "BASE64TX", lastValidBlockHeight: 42 });
    expect(JSON.stringify(exec)).not.toMatch(/secret|privateKey|keypair/i);
  });

  it("builds the transaction from the reviewed quote, not a fresh one", async () => {
    const reviewed = liveQuote({ outAmount: "999" });
    const { p, fetchImpl } = provider({ swapTransaction: "TX" });
    await p.prepare({ providerData: reviewed } as never, request);
    const body = JSON.parse((fetchImpl as unknown as { mock: { calls: [string, { body: string }][] } }).mock.calls[0][1].body);
    expect(body.quoteResponse.outAmount).toBe("999");
    expect(body.userPublicKey).toBe(request.account);
  });

  it("reports UNCERTAIN rather than inventing an order result Jupiter does not have", async () => {
    const { p } = provider({});
    const state = await p.status("sig123");
    expect(state.status).toBe("UNCERTAIN");
    expect(state.reason).toMatch(/confirm this signature against Solana/i);
  });

  it("surfaces an HTTP failure instead of returning an empty quote", async () => {
    const { p } = provider({}, false, 503);
    await expect(p.quote(request)).rejects.toThrow(/HTTP 503/);
  });
});
