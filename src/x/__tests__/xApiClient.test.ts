import { afterEach, describe, expect, it, vi } from "vitest";
import { XApiClient } from "../xApiClient";
import { XConfig } from "../config";

const FAKE_TOKEN = "fake-test-bearer-token-not-real";

function baseConfig(overrides: Partial<XConfig> = {}): XConfig {
  return Object.freeze({
    baseUrl: "https://api.x.com/2",
    streamEnabled: false,
    requestTimeoutMs: 200,
    bearerToken: FAKE_TOKEN,
    ...overrides,
  });
}

function makeClient(fetchImpl: typeof fetch, overrides: Partial<XConfig> = {}): XApiClient {
  return new XApiClient({ config: baseConfig(overrides), fetchImpl });
}

// Guarantees zero live X requests across this whole file, regardless of what
// any individual test does — matches the forensics client test suite's
// safety net (phaseX.txt: "No test may contact X").
const realFetch = vi.spyOn(globalThis, "fetch");
afterEach(() => {
  expect(realFetch).not.toHaveBeenCalled();
  realFetch.mockReset();
});

describe("XApiClient.checkStreamRulesAccess — success", () => {
  it("reports a valid successful response", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ data: [{ id: "1", value: "x" }], meta: { sent: "now" } }), { status: 200 }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const result = await client.checkStreamRulesAccess();
    expect(result).toMatchObject({ status: "SUCCESS", httpStatus: 200, ruleCount: 1, hasMeta: true });
    if (result.status === "SUCCESS") {
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.completedAtUtc).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it("reports zero rules and absent meta when the response has neither", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({}), { status: 200 }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const result = await client.checkStreamRulesAccess();
    expect(result).toMatchObject({ status: "SUCCESS", ruleCount: 0, hasMeta: false });
  });

  it("constructs exactly one '/2' in the endpoint even though X_API_BASE_URL already ends in /2", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await client.checkStreamRulesAccess();
    const calledUrl = fetchImpl.mock.calls[0][0] as string;
    expect(calledUrl).toBe("https://api.x.com/2/tweets/search/stream/rules?max_results=1");
    expect((calledUrl.match(/\/2\//g) ?? []).length).toBe(1);
  });

  it("sends the Bearer header to fetch but never returns or logs it", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await client.checkStreamRulesAccess();
    logSpy.mockRestore();

    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);

    const serializedResult = JSON.stringify(result);
    expect(serializedResult).not.toContain(FAKE_TOKEN);
    for (const call of logSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(FAKE_TOKEN);
    }
  });

  it("extracts safe rate-limit headers when present", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "x-rate-limit-limit": "300", "x-rate-limit-remaining": "299", "x-rate-limit-reset": "1700000000" },
        })
    );
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const result = await client.checkStreamRulesAccess();
    expect(result.rateLimit).toEqual({ limit: 300, remaining: 299, resetEpochSeconds: 1700000000 });
  });

  it("makes exactly one GET request — no retry on success", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await client.checkStreamRulesAccess();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("GET");
  });

  it("never issues a rule-mutation request (no POST/PUT/DELETE to the rules endpoint)", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await client.checkStreamRulesAccess();
    for (const call of fetchImpl.mock.calls) {
      const init = call[1] as RequestInit | undefined;
      expect(init?.method).not.toMatch(/POST|PUT|DELETE/);
    }
  });

  it("never connects to the persistent filtered-stream endpoint", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await client.checkStreamRulesAccess();
    for (const call of fetchImpl.mock.calls) {
      const url = call[0] as string;
      expect(url).not.toMatch(/\/tweets\/search\/stream(?!\/rules)/);
      expect(url).toContain("/stream/rules");
    }
  });
});

describe("XApiClient.checkStreamRulesAccess — missing/not-configured token", () => {
  it("returns NOT_CONFIGURED and makes no request at all when no bearer token is set", async () => {
    const fetchImpl = vi.fn();
    const client = makeClient(fetchImpl as unknown as typeof fetch, { bearerToken: undefined });
    const result = await client.checkStreamRulesAccess();
    expect(result).toMatchObject({ status: "FAILURE", code: "NOT_CONFIGURED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("XApiClient.checkStreamRulesAccess — HTTP failure classification", () => {
  it.each([
    [401, "AUTHENTICATION_FAILED"],
    [403, "ACCESS_DENIED"],
    [429, "RATE_LIMITED"],
    [500, "SERVER_ERROR"],
    [503, "SERVER_ERROR"],
  ] as const)("classifies HTTP %d as %s", async (status, expectedCode) => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ title: "error" }), { status }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const result = await client.checkStreamRulesAccess();
    expect(result).toMatchObject({ status: "FAILURE", code: expectedCode, httpStatus: status });
  });

  it("classifies an unmapped non-2xx status as UNEXPECTED_STATUS", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response("not found", { status: 404 }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const result = await client.checkStreamRulesAccess();
    expect(result).toMatchObject({ status: "FAILURE", code: "UNEXPECTED_STATUS", httpStatus: 404 });
  });

  it("does not retry after a failure — exactly one request", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response("", { status: 429 }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await client.checkStreamRulesAccess();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("XApiClient.checkStreamRulesAccess — timeout", () => {
  it("classifies a hanging request as TIMEOUT and does not retry", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        })
    );
    const client = makeClient(fetchImpl as unknown as typeof fetch, {});
    const result = await client.checkStreamRulesAccess();
    expect(result).toMatchObject({ status: "FAILURE", code: "TIMEOUT" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("XApiClient.checkStreamRulesAccess — malformed/oversized responses", () => {
  it("classifies malformed JSON as INVALID_RESPONSE", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response("not json", { status: 200 }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const result = await client.checkStreamRulesAccess();
    expect(result).toMatchObject({ status: "FAILURE", code: "INVALID_RESPONSE" });
  });

  it("classifies a response failing schema validation (non-object JSON) as INVALID_RESPONSE", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify("just a string"), { status: 200 }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const result = await client.checkStreamRulesAccess();
    expect(result).toMatchObject({ status: "FAILURE", code: "INVALID_RESPONSE" });
  });

  it("classifies an oversized response (via content-length) as RESPONSE_TOO_LARGE without reading the body", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-length": String(10 * 1024 * 1024) } })
    );
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const result = await client.checkStreamRulesAccess();
    expect(result).toMatchObject({ status: "FAILURE", code: "RESPONSE_TOO_LARGE" });
  });

  it("classifies an oversized response body (no content-length header) as RESPONSE_TOO_LARGE", async () => {
    const hugeBody = JSON.stringify({ data: [], padding: "x".repeat(100 * 1024) });
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(hugeBody, { status: 200 }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const result = await client.checkStreamRulesAccess();
    expect(result).toMatchObject({ status: "FAILURE", code: "RESPONSE_TOO_LARGE" });
  });
});

describe("XApiClient.checkStreamRulesAccess — network failure", () => {
  it("classifies a rejected fetch as NETWORK_ERROR and sanitizes the message", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => {
      throw new Error(`connect failed for https://api.x.com/2/tweets?token=${FAKE_TOKEN}`);
    });
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const result = await client.checkStreamRulesAccess();
    expect(result).toMatchObject({ status: "FAILURE", code: "NETWORK_ERROR" });
    if (result.status === "FAILURE") {
      expect(result.reason).not.toContain(FAKE_TOKEN);
      expect(result.reason).not.toMatch(/https?:\/\//);
    }
  });
});
