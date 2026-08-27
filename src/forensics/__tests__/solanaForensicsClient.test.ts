import { afterEach, describe, expect, it, vi } from "vitest";
import { SolanaForensicsClient, SolanaForensicsClientOptions } from "../solanaForensicsClient";
import { RequestBudget } from "../requestBudget";
import { ForensicsClientRuntimeConfig } from "../forensicsConfig";

const FAKE_RPC_URL = "https://mainnet.helius-rpc.com/?api-key=SUPER_SECRET_KEY_123";
const FAST_CONFIG: ForensicsClientRuntimeConfig = Object.freeze({
  requestTimeoutMs: 200,
  totalDeadlineMs: 5_000,
  maxResponseBytes: 2 * 1024 * 1024,
  maxRetries: 2,
  baseRetryDelayMs: 5,
  maxRetryDelayMs: 20,
});

function budget(maxCredits = 1000): RequestBudget {
  return new RequestBudget("FAST", maxCredits);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeClient(fetchImpl: any, overrides: Partial<SolanaForensicsClientOptions> = {}): SolanaForensicsClient {
  return new SolanaForensicsClient({
    rpcUrl: FAKE_RPC_URL,
    budget: budget(),
    runtimeConfig: FAST_CONFIG,
    fetchImpl: fetchImpl as typeof fetch,
    ...overrides,
  });
}

function requestId(init: RequestInit): string {
  return JSON.parse(init.body as string).id;
}

function jsonOk(bodyFor: (id: string) => unknown, headers: Record<string, string> = {}) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const id = requestId(init as RequestInit);
    return new Response(JSON.stringify(bodyFor(id)), { status: 200, headers });
  });
}

function httpStatus(status: number, headers: Record<string, string> = {}) {
  return vi.fn(async () => new Response(JSON.stringify({ error: "x" }), { status, headers }));
}

const realFetch = vi.spyOn(globalThis, "fetch");
afterEach(() => {
  expect(realFetch).not.toHaveBeenCalled();
  realFetch.mockReset();
});

describe("request shape correctness", () => {
  it("sends DAS getTokenAccounts with the documented single object parameter", async () => {
    const fetchImpl = jsonOk((id) => ({
      jsonrpc: "2.0",
      id,
      result: { total: 0, limit: 5, last_indexed_slot: 1, token_accounts: [] },
    }));
    const client = makeClient(fetchImpl);
    const result = await client.getTokenAccountsByMint("MintA", { limit: 5 });
    expect(result.status).toBe("AVAILABLE");
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body.method).toBe("getTokenAccounts");
    expect(Array.isArray(body.params)).toBe(false);
    expect(body.params).toMatchObject({ mint: "MintA", limit: 5 });
  });

  it("sends getTransactionsForAddress with POSITIONAL [address, options] parameters", async () => {
    const fetchImpl = jsonOk((id) => ({ jsonrpc: "2.0", id, result: { data: [], paginationToken: null } }));
    const client = makeClient(fetchImpl);
    const result = await client.getTransactionsForAddress("AddrA", { limit: 1 });
    expect(result.status).toBe("AVAILABLE");
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body.method).toBe("getTransactionsForAddress");
    expect(Array.isArray(body.params)).toBe(true);
    expect(body.params[0]).toBe("AddrA");
    expect(body.params[1]).toMatchObject({ limit: 1 });
  });

  it("regression guard: never regresses getTransactionsForAddress to the incorrect single-object form", async () => {
    const fetchImpl = jsonOk((id) => ({ jsonrpc: "2.0", id, result: { data: [], paginationToken: null } }));
    const client = makeClient(fetchImpl);
    await client.getTransactionsForAddress("AddrA");
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(Array.isArray(body.params)).toBe(true);
    expect(body.params).toHaveLength(2);
  });
});

describe("successful responses", () => {
  it("returns AVAILABLE with parsed data and estimated credits for getTokenSupply", async () => {
    const fetchImpl = jsonOk((id) => ({
      jsonrpc: "2.0",
      id,
      result: { context: { slot: 42 }, value: { amount: "1000000", decimals: 6, uiAmount: 1 } },
    }));
    const client = makeClient(fetchImpl);
    const result = await client.getTokenSupply("MintA");
    expect(result).toMatchObject({ status: "AVAILABLE", estimatedCredits: 1, contextSlot: 42 });
    if (result.status === "AVAILABLE") expect(result.data.value.amount).toBe("1000000");
  });
});

describe("bigint-safe balances", () => {
  it("preserves a token amount beyond Number.MAX_SAFE_INTEGER as an exact string", async () => {
    const hugeDigits = "123456789012345678901234";
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const id = requestId(init);
      const raw = `{"jsonrpc":"2.0","id":"${id}","result":{"total":1,"limit":1,"last_indexed_slot":1,"token_accounts":[{"address":"A","mint":"M","owner":"O","amount":${hugeDigits}}]}}`;
      return new Response(raw, { status: 200 });
    });
    const client = makeClient(fetchImpl);
    const result = await client.getTokenAccountsByMint("MintA", { limit: 1 });
    expect(result.status).toBe("AVAILABLE");
    if (result.status === "AVAILABLE") {
      const amount = result.data.token_accounts[0].amount;
      expect(amount).toBe(hugeDigits);
      expect(BigInt(amount)).toBe(BigInt(hugeDigits));
    }
  });
});

describe("JSON-RPC and HTTP error handling", () => {
  it("classifies a JSON-RPC error body as RPC_ERROR", async () => {
    const fetchImpl = jsonOk((id) => ({ jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid params" } }));
    const client = makeClient(fetchImpl);
    const result = await client.getTokenSupply("MintA");
    expect(result).toMatchObject({ status: "UNAVAILABLE", code: "RPC_ERROR" });
  });

  it.each([
    [401, "AUTHENTICATION_FAILED"],
    [403, "ACCESS_DENIED"],
  ])("classifies HTTP %s as %s without retry", async (status, code) => {
    const fetchImpl = httpStatus(status as number);
    const client = makeClient(fetchImpl);
    const result = await client.getTokenSupply("MintA");
    expect(result).toMatchObject({ status: "UNAVAILABLE", code });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries HTTP 429 then succeeds", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      call += 1;
      if (call === 1) return new Response("{}", { status: 429 });
      const id = requestId(init);
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id, result: { context: { slot: 1 }, value: { amount: "1", decimals: 0, uiAmount: 1 } } }),
        { status: 200 }
      );
    });
    const client = makeClient(fetchImpl);
    const result = await client.getTokenSupply("MintA");
    expect(result.status).toBe("AVAILABLE");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("respects a valid Retry-After header on 429", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      call += 1;
      if (call === 1) return new Response("{}", { status: 429, headers: { "retry-after": "0" } });
      const id = requestId(init);
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id, result: { context: { slot: 1 }, value: { amount: "1", decimals: 0, uiAmount: 1 } } }),
        { status: 200 }
      );
    });
    const client = makeClient(fetchImpl);
    const result = await client.getTokenSupply("MintA");
    expect(result.status).toBe("AVAILABLE");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries a retryable 5xx (503) then succeeds", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      call += 1;
      if (call === 1) return new Response("{}", { status: 503 });
      const id = requestId(init);
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id, result: { context: { slot: 1 }, value: { amount: "1", decimals: 0, uiAmount: 1 } } }),
        { status: 200 }
      );
    });
    const client = makeClient(fetchImpl);
    const result = await client.getTokenSupply("MintA");
    expect(result.status).toBe("AVAILABLE");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-retryable 500", async () => {
    const fetchImpl = httpStatus(500);
    const client = makeClient(fetchImpl);
    const result = await client.getTokenSupply("MintA");
    expect(result).toMatchObject({ status: "UNAVAILABLE" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up after exhausting retries on repeated 429s", async () => {
    const fetchImpl = httpStatus(429);
    const client = makeClient(fetchImpl);
    const result = await client.getTokenSupply("MintA");
    expect(result).toMatchObject({ status: "UNAVAILABLE", code: "RATE_LIMITED" });
    expect(fetchImpl).toHaveBeenCalledTimes(FAST_CONFIG.maxRetries + 1);
  });
});

describe("malformed and schema-invalid responses", () => {
  it("classifies malformed JSON as INVALID_RESPONSE", async () => {
    const fetchImpl = vi.fn(async () => new Response("not-json{", { status: 200 }));
    const client = makeClient(fetchImpl);
    const result = await client.getTokenSupply("MintA");
    expect(result).toMatchObject({ status: "UNAVAILABLE", code: "INVALID_RESPONSE" });
  });

  it("classifies a schema-invalid result as INVALID_RESPONSE", async () => {
    const fetchImpl = jsonOk((id) => ({ jsonrpc: "2.0", id, result: { unexpected: true } }));
    const client = makeClient(fetchImpl);
    const result = await client.getTokenSupply("MintA");
    expect(result).toMatchObject({ status: "UNAVAILABLE", code: "INVALID_RESPONSE" });
  });

  it("classifies a mismatched JSON-RPC id as INVALID_RESPONSE", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "totally-different-id",
            result: { context: { slot: 1 }, value: { amount: "1", decimals: 0, uiAmount: 1 } },
          }),
          { status: 200 }
        )
    );
    const client = makeClient(fetchImpl);
    const result = await client.getTokenSupply("MintA");
    expect(result).toMatchObject({ status: "UNAVAILABLE", code: "INVALID_RESPONSE" });
  });

  it("classifies an oversized response as RESPONSE_TOO_LARGE", async () => {
    const fetchImpl = jsonOk((id) => ({
      jsonrpc: "2.0",
      id,
      result: { context: { slot: 1 }, value: { amount: "1".repeat(500), decimals: 0, uiAmount: 1 } },
    }));
    const client = makeClient(fetchImpl, { runtimeConfig: { ...FAST_CONFIG, maxResponseBytes: 10 } });
    const result = await client.getTokenSupply("MintA");
    expect(result).toMatchObject({ status: "UNAVAILABLE", code: "RESPONSE_TOO_LARGE" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("timeouts, abort, and total deadline", () => {
  it("times out a hanging request and does not retry indefinitely", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        })
    );
    const client = makeClient(fetchImpl, {
      runtimeConfig: { ...FAST_CONFIG, requestTimeoutMs: 20, maxRetries: 0 },
    });
    const result = await client.getTokenSupply("MintA");
    expect(result).toMatchObject({ status: "UNAVAILABLE", code: "TIMEOUT" });
  });

  it("returns ABORTED immediately when the caller's signal is already aborted, without any fetch call", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn();
    const client = makeClient(fetchImpl as unknown as typeof fetch, { signal: controller.signal });
    const result = await client.getTokenSupply("MintA");
    expect(result).toMatchObject({ status: "UNAVAILABLE", code: "ABORTED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stops issuing new requests once the total deadline has passed", async () => {
    let currentTime = 0;
    const fetchImpl = vi.fn();
    const client = new SolanaForensicsClient({
      rpcUrl: FAKE_RPC_URL,
      budget: budget(),
      runtimeConfig: FAST_CONFIG,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      totalDeadlineMs: 10,
      now: () => new Date(currentTime),
    });
    currentTime = 1000; // well past the 10ms deadline computed at construction
    const result = await client.getTokenSupply("MintA");
    expect(result).toMatchObject({ status: "UNAVAILABLE", code: "TIMEOUT" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("budget interaction", () => {
  it("returns BUDGET_EXHAUSTED before issuing a request when insufficient credit remains", async () => {
    const fetchImpl = vi.fn();
    const client = makeClient(fetchImpl, { budget: budget(1) }); // getTokenAccounts costs 10
    const result = await client.getTokenAccountsByMint("MintA");
    expect(result).toMatchObject({ status: "UNAVAILABLE", code: "BUDGET_EXHAUSTED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("tracks request and credit accounting across a successful call", async () => {
    const b = budget(100);
    const fetchImpl = jsonOk((id) => ({
      jsonrpc: "2.0",
      id,
      result: { context: { slot: 1 }, value: { amount: "1", decimals: 0, uiAmount: 1 } },
    }));
    const client = makeClient(fetchImpl, { budget: b });
    await client.getTokenSupply("MintA");
    const snapshot = b.snapshot();
    expect(snapshot.requestsAttempted).toBe(1);
    expect(snapshot.requestsCompleted).toBe(1);
    expect(snapshot.creditsReserved).toBe(1);
    expect(snapshot.creditsConsumed).toBe(1);
    expect(snapshot.callsByMethod.getTokenSupply).toBe(1);
  });
});

describe("pagination", () => {
  it("terminates naturally (COMPLETE) when a page has no cursor", async () => {
    const fetchImpl = jsonOk((id) => ({
      jsonrpc: "2.0",
      id,
      result: { total: 1, limit: 1000, last_indexed_slot: 1, cursor: null, token_accounts: [] },
    }));
    const client = makeClient(fetchImpl);
    const result = await client.getTokenAccountsPaginated("MintA", { maxPages: 5 });
    expect(result.status).toBe("COMPLETE");
    expect(result.pagesFetched).toBe(1);
  });

  it("stops at the configured maximum page and marks PARTIAL", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      call += 1;
      const id = requestId(init);
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: { total: 100, limit: 1, last_indexed_slot: 1, cursor: `page-${call}`, token_accounts: [] },
        }),
        { status: 200 }
      );
    });
    const client = makeClient(fetchImpl);
    const result = await client.getTokenAccountsPaginated("MintA", { maxPages: 2 });
    expect(result.status).toBe("PARTIAL");
    expect(result.pagesFetched).toBe(2);
    expect(result.warnings.some((w) => w.includes("maximum holder pages reached"))).toBe(true);
  });

  it("detects a repeated cursor and marks PARTIAL", async () => {
    const fetchImpl = jsonOk((id) => ({
      jsonrpc: "2.0",
      id,
      result: { total: 100, limit: 1, last_indexed_slot: 1, cursor: "same-cursor", token_accounts: [] },
    }));
    const client = makeClient(fetchImpl);
    const result = await client.getTokenAccountsPaginated("MintA", { maxPages: 10 });
    expect(result.status).toBe("PARTIAL");
    expect(result.warnings.some((w) => w.includes("repeated cursor"))).toBe(true);
  });

  it("marks PARTIAL when the budget is exhausted mid-pagination", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      call += 1;
      const id = requestId(init);
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: { total: 100, limit: 1, last_indexed_slot: 1, cursor: `page-${call}`, token_accounts: [] },
        }),
        { status: 200 }
      );
    });
    // 15 credits: enough for exactly one 10-credit DAS page, not a second.
    const client = makeClient(fetchImpl, { budget: budget(15) });
    const result = await client.getTokenAccountsPaginated("MintA", { maxPages: 10 });
    expect(result.status).toBe("PARTIAL");
    expect(result.pagesFetched).toBe(1);
    expect(result.warnings.some((w) => w.includes("BUDGET_EXHAUSTED"))).toBe(true);
  });
});

describe("getTokenLargestAccounts fallback labeling", () => {
  it("is always labeled PARTIAL/limited, never a complete-coverage claim", async () => {
    const fetchImpl = jsonOk((id) => ({
      jsonrpc: "2.0",
      id,
      result: { context: { slot: 1 }, value: [{ address: "A", amount: "1", decimals: 0, uiAmount: 1 }] },
    }));
    const client = makeClient(fetchImpl);
    const result = await client.getTokenLargestAccounts("MintA");
    expect(result.status).toBe("PARTIAL");
    if (result.status === "PARTIAL") expect(result.reason).toMatch(/top-20/i);
  });
});

describe("secret handling", () => {
  it("never includes the API key or RPC URL in a result, even on network failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`fetch failed: ${FAKE_RPC_URL} ECONNREFUSED`);
    });
    const client = makeClient(fetchImpl);
    const result = await client.getTokenSupply("MintA");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("SUPER_SECRET_KEY_123");
    expect(serialized).not.toContain(FAKE_RPC_URL);
  });

  it("never logs the API key or RPC URL", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => {
      throw new Error(`fetch failed: ${FAKE_RPC_URL}`);
    });
    const client = makeClient(fetchImpl);
    await client.getTokenSupply("MintA");
    for (const spy of [logSpy, errorSpy, warnSpy]) {
      for (const call of spy.mock.calls) {
        expect(call.join(" ")).not.toContain("SUPER_SECRET_KEY_123");
      }
    }
    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

describe("not configured", () => {
  it("returns NOT_CONFIGURED without any fetch attempt when no RPC URL is available", async () => {
    const fetchImpl = vi.fn();
    const client = new SolanaForensicsClient({ rpcUrl: undefined, budget: budget(), fetchImpl, runtimeConfig: FAST_CONFIG });
    const result = await client.getTokenSupply("MintA");
    expect(result).toMatchObject({ status: "UNAVAILABLE", code: "NOT_CONFIGURED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
