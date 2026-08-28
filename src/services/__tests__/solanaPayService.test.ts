import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../jupiterService", () => ({
  jupiterService: {
    buildBuySwapTransaction: vi.fn(),
    buildSellSwapTransaction: vi.fn(),
  },
}));

import { jupiterService } from "../jupiterService";
import {
  buildTransactionForAccount,
  createBuyIntent,
  createSellIntent,
  getIntent,
  labelForIntent,
  SolanaPayConfigError,
} from "../solanaPayService";

const MINT = "So11111111111111111111111111111111111111112";
const ACCOUNT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

describe("solanaPayService: SOLANA_PAY_BASE_URL is required (fail-closed)", () => {
  const original = process.env.SOLANA_PAY_BASE_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.SOLANA_PAY_BASE_URL;
    else process.env.SOLANA_PAY_BASE_URL = original;
  });

  it("throws a SolanaPayConfigError rather than building a broken link", () => {
    delete process.env.SOLANA_PAY_BASE_URL;
    expect(() => createBuyIntent(MINT, 0.1)).toThrow(SolanaPayConfigError);
  });
});

describe("solanaPayService: intents", () => {
  beforeEach(() => {
    process.env.SOLANA_PAY_BASE_URL = "https://bot.example.com";
    vi.mocked(jupiterService.buildBuySwapTransaction).mockReset();
    vi.mocked(jupiterService.buildSellSwapTransaction).mockReset();
  });

  it("rejects an invalid mint before creating a session", () => {
    expect(() => createBuyIntent("not-a-mint", 0.1)).toThrow();
  });

  it("rejects a non-positive buy amount", () => {
    expect(() => createBuyIntent(MINT, 0)).toThrow(/greater than 0/);
  });

  it("rejects an out-of-range sell percentage", () => {
    expect(() => createSellIntent(MINT, 101)).toThrow(/between 1 and 100/);
    expect(() => createSellIntent(MINT, 0)).toThrow(/between 1 and 100/);
  });

  it("produces a solana: URL wrapping the configured HTTPS base and the intent id", () => {
    const { intentId, url } = createBuyIntent(MINT, 0.25);
    expect(url.startsWith("solana:")).toBe(true);
    const decoded = decodeURIComponent(url.slice("solana:".length));
    expect(decoded).toBe(`https://bot.example.com/pay/buy/${intentId}`);
  });

  it("getIntent returns the stored intent by id", () => {
    const { intentId } = createSellIntent(MINT, 50);
    const intent = getIntent(intentId);
    expect(intent).toMatchObject({ kind: "SELL", tokenAddress: MINT, amount: 50 });
  });

  it("getIntent returns undefined for an unknown id", () => {
    expect(getIntent("does-not-exist")).toBeUndefined();
  });

  it("labelForIntent describes buy vs sell distinctly", () => {
    const buy = getIntent(createBuyIntent(MINT, 1).intentId)!;
    const sell = getIntent(createSellIntent(MINT, 25).intentId)!;
    expect(labelForIntent(buy).label).toMatch(/Buy 1 SOL/);
    expect(labelForIntent(sell).label).toMatch(/Sell 25%/);
  });

  it("buildTransactionForAccount rejects an expired/unknown intent", async () => {
    await expect(buildTransactionForAccount("nope", ACCOUNT)).rejects.toThrow(/expired|does not exist/);
  });

  it("buildTransactionForAccount never touches a private key — it only forwards the caller-declared public account to jupiterService", async () => {
    vi.mocked(jupiterService.buildBuySwapTransaction).mockResolvedValue({
      transactionBase64: "base64tx",
      quote: { inAmount: "1", outAmount: "2", outputDecimals: 9 },
    });

    const { intentId } = createBuyIntent(MINT, 0.5);
    const result = await buildTransactionForAccount(intentId, ACCOUNT);

    expect(result.transaction).toBe("base64tx");
    expect(jupiterService.buildBuySwapTransaction).toHaveBeenCalledWith(ACCOUNT, MINT, 0.5);
  });

  it("is one-time-use: a second build attempt against the same intentId fails once the first build has succeeded", async () => {
    vi.mocked(jupiterService.buildBuySwapTransaction).mockResolvedValue({
      transactionBase64: "base64tx",
      quote: { inAmount: "1", outAmount: "2", outputDecimals: 9 },
    });

    const { intentId } = createBuyIntent(MINT, 0.5);
    await buildTransactionForAccount(intentId, ACCOUNT);

    await expect(buildTransactionForAccount(intentId, ACCOUNT)).rejects.toThrow(/expired|does not exist/);
    expect(getIntent(intentId)).toBeUndefined();
  });

  it("a failed build (e.g. jupiterService throws) leaves the intent live for a retry, rather than burning it", async () => {
    vi.mocked(jupiterService.buildBuySwapTransaction).mockRejectedValueOnce(new Error("Failed to get quote from Jupiter"));

    const { intentId } = createBuyIntent(MINT, 0.5);
    await expect(buildTransactionForAccount(intentId, ACCOUNT)).rejects.toThrow(/Failed to get quote/);

    expect(getIntent(intentId)).toBeDefined();

    vi.mocked(jupiterService.buildBuySwapTransaction).mockResolvedValueOnce({
      transactionBase64: "base64tx-retry",
      quote: { inAmount: "1", outAmount: "2", outputDecimals: 9 },
    });
    const retried = await buildTransactionForAccount(intentId, ACCOUNT);
    expect(retried.transaction).toBe("base64tx-retry");
  });

  it("expires after INTENT_TTL_MS: getIntent and buildTransactionForAccount both stop recognizing it", async () => {
    vi.useFakeTimers();
    try {
      const { intentId } = createBuyIntent(MINT, 0.5);
      expect(getIntent(intentId)).toBeDefined();

      vi.advanceTimersByTime(10 * 60_000 + 1); // just past the 10-minute TTL

      expect(getIntent(intentId)).toBeUndefined();
      await expect(buildTransactionForAccount(intentId, ACCOUNT)).rejects.toThrow(/expired|does not exist/);
      expect(jupiterService.buildBuySwapTransaction).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the account posted by the wallet can only select whose transaction is built - it cannot change the intent's mint, amount, or side", async () => {
    vi.mocked(jupiterService.buildSellSwapTransaction).mockResolvedValue({
      transactionBase64: "sell-tx",
      quote: { inAmount: "1", outAmount: "2", outputDecimals: 9 },
    });

    const { intentId } = createSellIntent(MINT, 40);
    const ANOTHER_ACCOUNT = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";

    await buildTransactionForAccount(intentId, ANOTHER_ACCOUNT);

    // Whichever account the caller declared, the intent's own kind/mint/amount
    // (fixed at creation via createSellIntent) are the only values used - the
    // request body's `account` field cannot smuggle in a different mint,
    // amount, or side.
    expect(jupiterService.buildSellSwapTransaction).toHaveBeenCalledWith(ANOTHER_ACCOUNT, MINT, 40);
    expect(jupiterService.buildBuySwapTransaction).not.toHaveBeenCalled();
  });
});
