import { describe, expect, it, vi } from "vitest";

import type { ChainClientResult, ChainReader } from "../chainClient";
import { FailoverChainClient } from "../failoverChainClient";
import {
  backoffWithJitter,
  classifyRpcFailure,
  cooldownFor,
  COOLDOWN_MS,
  parseRetryAfterMs,
  redactRpcUrls,
  resolveHttpEndpoints,
  resolveWsEndpoints,
  sanitizeUrl,
  shouldFailover,
} from "../rpcEndpoints";

/**
 * Phase 7D.3 — RPC failover.
 *
 * All deterministic: no sockets, no live endpoints. The scenarios mirror the ones the
 * spec names — primary failure into secondary success, both private endpoints failing
 * into the default, a complete outage, a wrong chain, and no failover on request faults.
 */

const ALCHEMY_QUOTA_MESSAGE =
  "Monthly capacity limit exceeded. Visit https://dashboard.alchemy.com/settings/billing to upgrade your scaling policy for continued service.";

function ok<T>(data: T): ChainClientResult<T> {
  return { status: "AVAILABLE", data, source: "test", fetchedAt: new Date(), attempts: 1 };
}
function unavailable<T>(reason: string): ChainClientResult<T> {
  return {
    status: "UNAVAILABLE",
    source: "test",
    fetchedAt: new Date(),
    code: "RPC_ERROR",
    reason,
    attempts: 1,
  };
}

/** A stub ChainReader whose getBlockNumber behaviour the test controls. */
function stubReader(behaviour: () => Promise<ChainClientResult<bigint>>): ChainReader {
  return {
    getBlockNumber: behaviour,
    getBlockRef: async () => unavailable("n/a") as never,
    getTransaction: async () => unavailable("n/a") as never,
    getLogs: async () => unavailable("n/a") as never,
    readContract: (async () => unavailable("n/a")) as ChainReader["readContract"],
  };
}

const ENV = {
  ROBINHOOD_RPC_HTTPS: "https://primary.example/v2/KEY_A",
  ROBINHOOD_RPC_HTTPS2: "https://secondary.example/v2/KEY_B",
  DEAFULT_RPC_HTTPS: "https://public.example/rpc",
} as NodeJS.ProcessEnv;

function buildClient(
  perEndpointBehaviour: Record<string, () => Promise<ChainClientResult<bigint>>>,
  env: NodeJS.ProcessEnv = ENV
) {
  const calls: string[] = [];
  const client = new FailoverChainClient({
    config: { chainId: 4663, rpcHttpUrl: "unused" } as never,
    env,
    validateChainId: false,
    perEndpointRetries: 0,
    now: () => 1_000_000,
    random: () => 0,
    clientFactory: (endpoint) =>
      stubReader(async () => {
        calls.push(endpoint.label);
        return perEndpointBehaviour[endpoint.label]();
      }),
  });
  return { client, calls };
}

describe("resolveEndpoints", () => {
  it("orders by the documented priority, preserving the DEAFULT spelling", () => {
    const endpoints = resolveHttpEndpoints(ENV);
    expect(endpoints.map((e) => e.label)).toEqual([
      "ROBINHOOD_RPC_HTTPS",
      "ROBINHOOD_RPC_HTTPS2",
      "DEAFULT_RPC_HTTPS",
    ]);
  });

  /**
   * Phase 7D.6 — `…HTTPS3` leads. Probed 2026-09-25: `…HTTPS` and `…HTTPS2` both return
   * HTTP 429 "Monthly capacity limit exceeded", `…HTTPS3` returns 200. Leading with a spent key
   * costs a 429 plus a cooldown on every cold request, paid again after each restart because
   * cooldowns are per-process.
   */
  it("leads with the third private key, keeping the spent ones as failover before the public default", () => {
    const endpoints = resolveHttpEndpoints({
      DEAFULT_RPC_HTTPS: "https://public.example/rpc",
      ROBINHOOD_RPC_HTTPS3: "https://tertiary.example/v2/KEY_C",
      ROBINHOOD_RPC_HTTPS: "https://primary.example/v2/KEY_A",
      ROBINHOOD_RPC_HTTPS2: "https://secondary.example/v2/KEY_B",
    } as NodeJS.ProcessEnv);
    expect(endpoints.map((e) => e.label)).toEqual(["ROBINHOOD_RPC_HTTPS3", "ROBINHOOD_RPC_HTTPS", "ROBINHOOD_RPC_HTTPS2", "DEAFULT_RPC_HTTPS"]);
    const ws = resolveWsEndpoints({
      DEAFULT_RPC_WSS: "wss://public.example",
      ROBINHOOD_RPC_WSS3: "wss://tertiary.example/v2/KEY_C",
      ROBINHOOD_RPC_WSS: "wss://primary.example/v2/KEY_A",
    } as NodeJS.ProcessEnv);
    expect(ws.map((e) => e.label)).toEqual(["ROBINHOOD_RPC_WSS3", "ROBINHOOD_RPC_WSS", "DEAFULT_RPC_WSS"]);
  });

  describe("PONS_RPC_PRIORITY", () => {
    const ALL = {
      DEAFULT_RPC_HTTPS: "https://public.example/rpc",
      ROBINHOOD_RPC_HTTPS3: "https://tertiary.example/v2/KEY_C",
      ROBINHOOD_RPC_HTTPS: "https://primary.example/v2/KEY_A",
      ROBINHOOD_RPC_HTTPS2: "https://secondary.example/v2/KEY_B",
    };

    it("promotes the named endpoints, in the order given", () => {
      const endpoints = resolveHttpEndpoints({ ...ALL, PONS_RPC_PRIORITY: "DEAFULT_RPC_HTTPS,ROBINHOOD_RPC_HTTPS2" } as NodeJS.ProcessEnv);
      expect(endpoints.map((e) => e.label)).toEqual(["DEAFULT_RPC_HTTPS", "ROBINHOOD_RPC_HTTPS2", "ROBINHOOD_RPC_HTTPS3", "ROBINHOOD_RPC_HTTPS"]);
    });

    it("keeps every endpoint exactly once — a promoted one is not also left in place", () => {
      const endpoints = resolveHttpEndpoints({ ...ALL, PONS_RPC_PRIORITY: "ROBINHOOD_RPC_HTTPS" } as NodeJS.ProcessEnv);
      expect(endpoints.map((e) => e.label)).toEqual(["ROBINHOOD_RPC_HTTPS", "ROBINHOOD_RPC_HTTPS3", "ROBINHOOD_RPC_HTTPS2", "DEAFULT_RPC_HTTPS"]);
    });

    it("tolerates whitespace and names from the other transport's list", () => {
      // One setting covers both lists, so WS names appearing here are skipped, not an error.
      const endpoints = resolveHttpEndpoints({ ...ALL, PONS_RPC_PRIORITY: " ROBINHOOD_RPC_WSS3 , DEAFULT_RPC_HTTPS " } as NodeJS.ProcessEnv);
      expect(endpoints.map((e) => e.label)).toEqual(["DEAFULT_RPC_HTTPS", "ROBINHOOD_RPC_HTTPS3", "ROBINHOOD_RPC_HTTPS", "ROBINHOOD_RPC_HTTPS2"]);
    });

    it("falls back to the default order when it names nothing recognisable", () => {
      const endpoints = resolveHttpEndpoints({ ...ALL, PONS_RPC_PRIORITY: "TYPO_RPC" } as NodeJS.ProcessEnv);
      expect(endpoints.map((e) => e.label)).toEqual(["ROBINHOOD_RPC_HTTPS3", "ROBINHOOD_RPC_HTTPS", "ROBINHOOD_RPC_HTTPS2", "DEAFULT_RPC_HTTPS"]);
    });
  });

  it("skips empty and whitespace-only entries", () => {
    const endpoints = resolveHttpEndpoints({
      ROBINHOOD_RPC_HTTPS: "",
      ROBINHOOD_RPC_HTTPS2: "   ",
      DEAFULT_RPC_HTTPS: "https://public.example/rpc",
    } as NodeJS.ProcessEnv);
    expect(endpoints.map((e) => e.label)).toEqual(["DEAFULT_RPC_HTTPS"]);
  });

  it("deduplicates identical URLs, keeping the highest priority", () => {
    const endpoints = resolveHttpEndpoints({
      ROBINHOOD_RPC_HTTPS: "https://same.example/rpc",
      ROBINHOOD_RPC_HTTPS2: "https://same.example/rpc",
      DEAFULT_RPC_HTTPS: "https://other.example/rpc",
    } as NodeJS.ProcessEnv);
    expect(endpoints.map((e) => e.label)).toEqual(["ROBINHOOD_RPC_HTTPS", "DEAFULT_RPC_HTTPS"]);
  });

  it("resolves the websocket list from its own variables", () => {
    const endpoints = resolveWsEndpoints({
      ROBINHOOD_RPC_WSS: "wss://a.example",
      DEAFULT_RPC_WSS: "wss://b.example",
    } as NodeJS.ProcessEnv);
    expect(endpoints.map((e) => e.label)).toEqual(["ROBINHOOD_RPC_WSS", "DEAFULT_RPC_WSS"]);
  });

  it("never exposes the key — only host", () => {
    const [primary] = resolveHttpEndpoints(ENV);
    expect(primary.host).toBe("primary.example");
    expect(sanitizeUrl(primary.url)).toBe("primary.example");
    expect(sanitizeUrl(primary.url)).not.toContain("KEY_A");
  });
});

describe("classifyRpcFailure", () => {
  it("recognises Alchemy's monthly capacity message as quota exhaustion, not a rate limit", () => {
    // Both arrive as HTTP 429; conflating them would retry a dead endpoint every 15s.
    expect(classifyRpcFailure({ status: 429, message: ALCHEMY_QUOTA_MESSAGE })).toBe("QUOTA_EXHAUSTED");
  });

  it("treats an ordinary 429 as a rate limit", () => {
    expect(classifyRpcFailure({ status: 429, message: "Too Many Requests" })).toBe("RATE_LIMITED");
  });

  it.each([
    ["execution reverted", "execution reverted: insufficient balance"],
    ["invalid params", "invalid params: expected 32 bytes"],
    ["unsupported method", "the method debug_traceCall does not exist/is not available"],
  ])("classifies %s as a request fault, which must not fail over", (_label, message) => {
    const failure = classifyRpcFailure({ message });
    expect(failure).toBe("REQUEST_FAULT");
    expect(shouldFailover(failure)).toBe(false);
  });

  it("classifies 5xx as retryable server errors and 403 as quota-like", () => {
    expect(classifyRpcFailure({ status: 502, message: "Bad Gateway" })).toBe("SERVER_ERROR");
    expect(classifyRpcFailure({ status: 403, message: "Forbidden" })).toBe("QUOTA_EXHAUSTED");
  });

  /**
   * Phase 7D.5 — a client-side response-size refusal is a range problem, not a sick
   * endpoint. Measured: a topic-only getLogs over 10,000 blocks of curve trades returns
   * ~10.5 MB; classified as CONNECTION it cooled down the only wide-range provider.
   */
  it("classifies a response-size refusal as a range limit, so the endpoint is not cooled down", () => {
    const message = "HTTP response body exceeded the size limit.\n\nMax: 10485760 bytes\nReceived: 10502144 bytes";
    expect(classifyRpcFailure({ message })).toBe("RANGE_LIMIT");
    expect(COOLDOWN_MS.RANGE_LIMIT).toBe(0);
  });

  it("classifies transport failures", () => {
    expect(classifyRpcFailure({ code: "ETIMEDOUT", message: "timed out" })).toBe("TIMEOUT");
    expect(classifyRpcFailure({ code: "ECONNRESET", message: "socket hang up" })).toBe("CONNECTION");
  });

  /**
   * Phase 7D.5. Cloudflare in front of the one endpoint that serves wide `eth_getLogs`
   * ranges answered `403 / error code: 1010` to requests with no `User-Agent`. Filed as
   * QUOTA_EXHAUSTED, that parked a perfectly healthy endpoint for 30 minutes and made a
   * missing header look like a provider-capacity blocker.
   */
  it.each([
    ["Cloudflare 1010", "error code: 1010"],
    ["Cloudflare 1020", "error code: 1020"],
    ["interstitial", "Just a moment..."],
    ["block page", "Attention Required! | Cloudflare"],
  ])("classifies a bot shield (%s) as BOT_CHALLENGE, not a dead key", (_label, message) => {
    expect(classifyRpcFailure({ status: 403, message })).toBe("BOT_CHALLENGE");
  });

  it("still treats a plain 403 as quota-like — only a shield fingerprint changes the class", () => {
    expect(classifyRpcFailure({ status: 403, message: "Forbidden" })).toBe("QUOTA_EXHAUSTED");
  });

  it("fails over on a bot challenge, and parks the endpoint for a minute, not half an hour", () => {
    expect(shouldFailover("BOT_CHALLENGE")).toBe(true);
    expect(COOLDOWN_MS.BOT_CHALLENGE).toBeGreaterThan(0);
    expect(COOLDOWN_MS.BOT_CHALLENGE).toBeLessThan(COOLDOWN_MS.QUOTA_EXHAUSTED / 10);
  });
});

describe("cooldowns", () => {
  it("gives quota exhaustion a far longer cooldown than a rate limit", () => {
    expect(COOLDOWN_MS.QUOTA_EXHAUSTED).toBeGreaterThan(COOLDOWN_MS.RATE_LIMITED * 100);
  });

  it("honours Retry-After when it is longer than the computed cooldown", () => {
    const retryAfter = parseRetryAfterMs("120");
    expect(retryAfter).toBe(120_000);
    expect(cooldownFor("RATE_LIMITED", retryAfter, 1)).toBe(120_000);
  });

  it("ignores a Retry-After shorter than a quota cooldown", () => {
    // A provider asking for 60s mid-monthly-outage still cannot serve in 60s.
    expect(cooldownFor("QUOTA_EXHAUSTED", 60_000, 1)).toBe(COOLDOWN_MS.QUOTA_EXHAUSTED);
  });

  it("parses an HTTP-date Retry-After", () => {
    const now = Date.parse("2026-09-12T00:00:00Z");
    expect(parseRetryAfterMs("Sat, 12 Sep 2026 00:00:30 GMT", now)).toBe(30_000);
  });

  it("escalates repeat failures but caps the escalation", () => {
    const once = cooldownFor("TIMEOUT", null, 1);
    const many = cooldownFor("TIMEOUT", null, 50);
    expect(many).toBeGreaterThan(once);
    expect(many).toBe(COOLDOWN_MS.TIMEOUT * 8);
  });

  it("never cools down a request fault", () => {
    expect(cooldownFor("REQUEST_FAULT", null, 5)).toBe(0);
  });
});

describe("backoffWithJitter", () => {
  it("stays within the exponential cap", () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const delay = backoffWithJitter(attempt, 100, 4_000, () => 0.999);
      expect(delay).toBeLessThanOrEqual(4_000);
    }
  });

  it("is jittered, not fixed", () => {
    expect(backoffWithJitter(3, 100, 4_000, () => 0)).toBe(0);
    expect(backoffWithJitter(3, 100, 4_000, () => 0.5)).toBeGreaterThan(0);
  });
});

const ALCHEMY_RANGE_MESSAGE =
  "Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range. Based on your parameters, this block range should work: [0x3a75d20, 0x3a75d29]. Upgrade to PAYG for expanded block range.";

describe("block-range limits", () => {
  it("classifies Alchemy's free-tier eth_getLogs cap as a range limit, not quota or connection", () => {
    expect(classifyRpcFailure({ status: 400, message: ALCHEMY_RANGE_MESSAGE })).toBe("RANGE_LIMIT");
    expect(classifyRpcFailure({ message: "query returned more than 10000 results" })).toBe("RANGE_LIMIT");
    expect(COOLDOWN_MS.RANGE_LIMIT).toBe(0);
  });

  it("does not treat a generic invalid-parameters error as a range limit", () => {
    expect(classifyRpcFailure({ message: "Invalid parameters were provided to the RPC method" })).not.toBe("RANGE_LIMIT");
  });

  it("moves a wide log query past range-capped endpoints without cooling them down", async () => {
    // Pin the walk order: this test is about stepping *through* several endpoints, so it must
    // not depend on which key happens to lead today (Phase 7D.6 put …HTTPS3 first).
    const env = {
      ...ENV,
      ROBINHOOD_RPC_HTTPS3: "https://tertiary.example/v2/KEY_C",
      PONS_RPC_PRIORITY: "ROBINHOOD_RPC_HTTPS,ROBINHOOD_RPC_HTTPS2,ROBINHOOD_RPC_HTTPS3,DEAFULT_RPC_HTTPS",
    } as NodeJS.ProcessEnv;
    const calls: string[] = [];
    const client = new FailoverChainClient({
      config: { chainId: 4663, rpcHttpUrl: "unused" } as never,
      env,
      validateChainId: false,
      perEndpointRetries: 2,
      now: () => 1_000_000,
      random: () => 0,
      clientFactory: (endpoint) => ({
        ...stubReader(async () => ok(99n)),
        getLogs: async () => {
          calls.push(endpoint.label);
          return endpoint.label === "DEAFULT_RPC_HTTPS" ? ok([]) : unavailable(ALCHEMY_RANGE_MESSAGE);
        },
      }),
    });

    const logs = await client.getLogs({ address: "0x0", event: {} as never, fromBlock: 1n, toBlock: 2000n });
    expect(logs.status).toBe("AVAILABLE");
    // One attempt per capped endpoint (no retries on a plan limit), then the wide-range endpoint.
    expect(calls).toEqual(["ROBINHOOD_RPC_HTTPS", "ROBINHOOD_RPC_HTTPS2", "ROBINHOOD_RPC_HTTPS3", "DEAFULT_RPC_HTTPS"]);

    // No failure recorded, so no cooldown: the capped endpoints still serve ordinary calls first.
    expect(client.healthSnapshot().map((h) => h.lastFailure ?? null)).toEqual([null, null, null, null]);
    calls.length = 0;
    expect((await client.getBlockNumber()).status).toBe("AVAILABLE");
  });
});

describe("FailoverChainClient — whose range cap counts (Phase 7D.5)", () => {
  /**
   * Endpoints are tried best-key-first and the Alchemy keys refuse anything wider than 10
   * blocks. When the widest endpoint (the public default, lowest priority) is in cooldown,
   * the only voice left is a narrow one — and `curveTradeListener` used to believe it,
   * halving its window repeatedly down to the 10-block floor while a provider stood ready
   * to serve 7,500. A cap is only evidence about the range when the widest endpoint spoke.
   */
  it("does not report a narrow endpoint's range cap while the widest endpoint is cooled down", async () => {
    const { client } = buildClient({
      // Cool the default down with a quota failure on an unrelated call first.
      ROBINHOOD_RPC_HTTPS: async () => unavailable(ALCHEMY_RANGE_MESSAGE),
      ROBINHOOD_RPC_HTTPS2: async () => unavailable(ALCHEMY_RANGE_MESSAGE),
      DEAFULT_RPC_HTTPS: async () => unavailable(ALCHEMY_QUOTA_MESSAGE),
    });

    // First call cools DEAFULT (quota → 30 min).
    await client.getBlockNumber();
    const result = await client.getBlockNumber();

    expect(result.status).toBe("UNAVAILABLE");
    if (result.status !== "UNAVAILABLE") return;
    expect(result.reason).toMatch(/no usable RPC endpoint for this request right now/i);
    expect(result.reason).not.toMatch(/up to a \d+ block range/i);
  });

  it("does report the widest endpoint's own range cap — that one is authoritative", async () => {
    const { client } = buildClient({
      ROBINHOOD_RPC_HTTPS: async () => unavailable(ALCHEMY_RANGE_MESSAGE),
      ROBINHOOD_RPC_HTTPS2: async () => unavailable(ALCHEMY_RANGE_MESSAGE),
      DEAFULT_RPC_HTTPS: async () => unavailable("block range exceeds maximum allowed (max=10000, requested=50001)"),
    });

    const result = await client.getBlockNumber();

    expect(result.status).toBe("UNAVAILABLE");
    if (result.status !== "UNAVAILABLE") return;
    // The caller must see this one, or the window can never find its real ceiling.
    expect(result.reason).toMatch(/block range exceeds maximum allowed/i);
  });
});

describe("FailoverChainClient", () => {
  it("primary failure -> secondary success", async () => {
    const { client, calls } = buildClient({
      ROBINHOOD_RPC_HTTPS: async () => unavailable(ALCHEMY_QUOTA_MESSAGE),
      ROBINHOOD_RPC_HTTPS2: async () => ok(61599834n),
      DEAFULT_RPC_HTTPS: async () => unavailable("should not be reached"),
    });

    const result = await client.getBlockNumber();
    expect(result.status).toBe("AVAILABLE");
    if (result.status !== "AVAILABLE") return;
    expect(result.data).toBe(61599834n);
    // Stops at the first success — the default is never touched.
    expect(calls).toEqual(["ROBINHOOD_RPC_HTTPS", "ROBINHOOD_RPC_HTTPS2"]);
  });

  it("both private endpoints failing -> default success", async () => {
    const { client, calls } = buildClient({
      ROBINHOOD_RPC_HTTPS: async () => unavailable(ALCHEMY_QUOTA_MESSAGE),
      ROBINHOOD_RPC_HTTPS2: async () => unavailable("Forbidden"),
      DEAFULT_RPC_HTTPS: async () => ok(42n),
    });

    const result = await client.getBlockNumber();
    expect(result.status).toBe("AVAILABLE");
    expect(calls).toEqual(["ROBINHOOD_RPC_HTTPS", "ROBINHOOD_RPC_HTTPS2", "DEAFULT_RPC_HTTPS"]);
  });

  it("two exhausted keys rotate to the third key, and the exhausted ones stay cooled down", async () => {
    // Same reason: the scenario is "the first two keys are spent", so they have to be first.
    const env = {
      ...ENV,
      ROBINHOOD_RPC_HTTPS3: "https://tertiary.example/v2/KEY_C",
      PONS_RPC_PRIORITY: "ROBINHOOD_RPC_HTTPS,ROBINHOOD_RPC_HTTPS2,ROBINHOOD_RPC_HTTPS3,DEAFULT_RPC_HTTPS",
    } as NodeJS.ProcessEnv;
    const { client, calls } = buildClient(
      {
        ROBINHOOD_RPC_HTTPS: async () => unavailable(ALCHEMY_QUOTA_MESSAGE),
        ROBINHOOD_RPC_HTTPS2: async () => unavailable(ALCHEMY_QUOTA_MESSAGE),
        ROBINHOOD_RPC_HTTPS3: async () => ok(7n),
        DEAFULT_RPC_HTTPS: async () => unavailable("should not be reached"),
      },
      env
    );

    expect((await client.getBlockNumber()).status).toBe("AVAILABLE");
    expect(calls).toEqual(["ROBINHOOD_RPC_HTTPS", "ROBINHOOD_RPC_HTTPS2", "ROBINHOOD_RPC_HTTPS3"]);

    // The next request goes straight to the third key: exhausted keys are not retried every call.
    calls.length = 0;
    expect((await client.getBlockNumber()).status).toBe("AVAILABLE");
    expect(calls).toEqual(["ROBINHOOD_RPC_HTTPS3"]);
    const health = client.healthSnapshot();
    expect(health.find((h) => h.label === "ROBINHOOD_RPC_HTTPS")?.lastFailure).toBe("QUOTA_EXHAUSTED");
    expect(health.find((h) => h.label === "ROBINHOOD_RPC_HTTPS2")?.lastFailure).toBe("QUOTA_EXHAUSTED");
  });

  it("complete outage returns a structured unavailable, never a throw", async () => {
    const { client } = buildClient({
      ROBINHOOD_RPC_HTTPS: async () => unavailable(ALCHEMY_QUOTA_MESSAGE),
      ROBINHOOD_RPC_HTTPS2: async () => unavailable("socket hang up"),
      DEAFULT_RPC_HTTPS: async () => unavailable("Bad Gateway"),
    });

    const result = await client.getBlockNumber();
    expect(result.status).toBe("UNAVAILABLE");
    if (result.status !== "UNAVAILABLE") return;
    expect(result.code).toBe("RPC_ERROR");
  });

  it("does NOT fail over on a contract revert", async () => {
    const { client, calls } = buildClient({
      ROBINHOOD_RPC_HTTPS: async () => unavailable("execution reverted: not graduated"),
      ROBINHOOD_RPC_HTTPS2: async () => ok(1n),
      DEAFULT_RPC_HTTPS: async () => ok(1n),
    });

    const result = await client.getBlockNumber();
    expect(result.status).toBe("UNAVAILABLE");
    // The decisive assertion: a revert reverts everywhere, so only one endpoint is tried.
    expect(calls).toEqual(["ROBINHOOD_RPC_HTTPS"]);
  });

  it("puts a quota-exhausted endpoint into cooldown and skips it next time", async () => {
    let primaryCalls = 0;
    const client = new FailoverChainClient({
      config: { chainId: 4663, rpcHttpUrl: "unused" } as never,
      env: ENV,
      validateChainId: false,
      perEndpointRetries: 0,
      now: () => 1_000_000,
      random: () => 0,
      clientFactory: (endpoint) =>
        stubReader(async () => {
          if (endpoint.label === "ROBINHOOD_RPC_HTTPS") {
            primaryCalls += 1;
            return unavailable(ALCHEMY_QUOTA_MESSAGE);
          }
          return ok(7n);
        }),
    });

    await client.getBlockNumber();
    await client.getBlockNumber();
    await client.getBlockNumber();

    // Tried once, then skipped while cooling down — not retried on every request.
    expect(primaryCalls).toBe(1);

    const health = client.healthSnapshot();
    const primary = health.find((h) => h.label === "ROBINHOOD_RPC_HTTPS")!;
    expect(primary.lastFailure).toBe("QUOTA_EXHAUSTED");
    expect(primary.healthy).toBe(false);
    expect(primary.cooldownUntil).toBeGreaterThan(1_000_000);
  });

  it("reports sanitized health with no URLs or keys", async () => {
    const { client } = buildClient({
      ROBINHOOD_RPC_HTTPS: async () => unavailable(ALCHEMY_QUOTA_MESSAGE),
      ROBINHOOD_RPC_HTTPS2: async () => ok(1n),
      DEAFULT_RPC_HTTPS: async () => ok(1n),
    });
    await client.getBlockNumber();

    const serialized = JSON.stringify(client.healthSnapshot());
    expect(serialized).not.toContain("KEY_A");
    expect(serialized).not.toContain("KEY_B");
    expect(serialized).not.toContain("https://");
    expect(serialized).toContain("primary.example");
  });

  it("counts failovers for monitoring", async () => {
    const { client } = buildClient({
      ROBINHOOD_RPC_HTTPS: async () => unavailable(ALCHEMY_QUOTA_MESSAGE),
      ROBINHOOD_RPC_HTTPS2: async () => ok(1n),
      DEAFULT_RPC_HTTPS: async () => ok(1n),
    });
    await client.getBlockNumber();

    const secondary = client.healthSnapshot().find((h) => h.label === "ROBINHOOD_RPC_HTTPS2")!;
    expect(secondary.failoverCount).toBe(1);
    expect(secondary.successCount).toBe(1);
  });

  it("reports unavailable when nothing is configured, rather than throwing", async () => {
    const client = new FailoverChainClient({
      config: { chainId: 4663, rpcHttpUrl: "unused" } as never,
      env: {} as NodeJS.ProcessEnv,
      validateChainId: false,
    });
    expect(client.endpointCount).toBe(0);

    const result = await client.getBlockNumber();
    expect(result.status).toBe("UNAVAILABLE");
    if (result.status !== "UNAVAILABLE") return;
    expect(result.reason).toMatch(/no usable RPC endpoint/i);
  });
});

describe("redactRpcUrls — the API key must never reach a response or a log", () => {
  /**
   * Observed in production on 2026-09-12: the pool-evidence endpoint returned a 429
   * detail containing the full provider URL, API key and all, straight to the browser.
   * viem's error text embeds the request URL, and that text flows into `reason`/`detail`.
   *
   * The credential below is SYNTHETIC. The first version of this test used the real
   * leaked key as its fixture, which committed that key to a public repository — the
   * exact failure the test exists to prevent. Never paste a real credential into a test,
   * even one being asserted as redacted.
   */
  const LEAKED = [
    "RPC Request failed.",
    "",
    "URL: https://robinhood-mainnet.g.alchemy.com/v2/SYNTHETIC_TEST_KEY_NOT_A_REAL_CREDENTIAL",
    "Details: Monthly capacity limit exceeded.",
  ].join("\n");

  it("removes the key but keeps the host, which is the useful part", () => {
    const safe = redactRpcUrls(LEAKED);
    expect(safe).not.toContain("SYNTHETIC_TEST_KEY_NOT_A_REAL_CREDENTIAL");
    expect(safe).not.toContain("/v2/");
    expect(safe).toContain("robinhood-mainnet.g.alchemy.com");
    // The diagnostic message itself must survive.
    expect(safe).toContain("Monthly capacity limit exceeded");
  });

  it.each([
    ["wss", "wss://rpc.example.com/ws/v3/SECRETKEY"],
    ["query-string key", "https://rpc.example.com/rpc?apikey=SECRETKEY"],
    ["http", "http://internal.example.com/v2/SECRETKEY"],
  ])("redacts a %s URL", (_label, url) => {
    const safe = redactRpcUrls(`failed calling ${url} now`);
    expect(safe).not.toContain("SECRETKEY");
  });

  it("leaves a bare host URL and ordinary text alone", () => {
    expect(redactRpcUrls("see https://viem.sh")).toContain("viem.sh");
    expect(redactRpcUrls("execution reverted")).toBe("execution reverted");
  });

  it("redacts every URL in a message, not just the first", () => {
    const safe = redactRpcUrls("a https://x.example/v2/KEY1 and b https://y.example/v2/KEY2");
    expect(safe).not.toContain("KEY1");
    expect(safe).not.toContain("KEY2");
  });
});

describe("request deadlines and metrics (§2)", () => {
  it("bounds total elapsed time across providers instead of compounding per-endpoint timeouts", async () => {
    // Three endpoints that each burn 5s. Without a total budget the caller waits 15s+;
    // with a 6s budget the cascade is cut short.
    let clock = 1_000_000;
    const client = new FailoverChainClient({
      config: { chainId: 4663, rpcHttpUrl: "unused" } as never,
      env: ENV,
      validateChainId: false,
      perEndpointRetries: 0,
      totalDeadlineMs: 6_000,
      now: () => clock,
      random: () => 0,
      clientFactory: () =>
        stubReader(async () => {
          clock += 5_000; // each attempt consumes 5s of the budget
          return unavailable("socket hang up");
        }),
    });

    const result = await client.getBlockNumber();
    expect(result.status).toBe("UNAVAILABLE");
    if (result.status !== "UNAVAILABLE") return;
    expect(result.code).toBe("TIMEOUT");
    expect(result.reason).toMatch(/deadline/i);
    expect(client.metricsSnapshot().deadlineExceededCount).toBe(1);
  });

  it("does not trip the deadline on a fast success", async () => {
    const { client } = buildClient({
      ROBINHOOD_RPC_HTTPS: async () => ok(1n),
      ROBINHOOD_RPC_HTTPS2: async () => ok(1n),
      DEAFULT_RPC_HTTPS: async () => ok(1n),
    });
    const result = await client.getBlockNumber();
    expect(result.status).toBe("AVAILABLE");
    expect(client.metricsSnapshot().deadlineExceededCount).toBe(0);
  });

  it("exposes sanitized request, failover and health metrics", async () => {
    const { client } = buildClient({
      ROBINHOOD_RPC_HTTPS: async () => unavailable(ALCHEMY_QUOTA_MESSAGE),
      ROBINHOOD_RPC_HTTPS2: async () => ok(1n),
      DEAFULT_RPC_HTTPS: async () => ok(1n),
    });
    await client.getBlockNumber();
    await client.getBlockNumber();

    const m = client.metricsSnapshot();
    expect(m.requestCount).toBe(2);
    expect(m.failoverCount).toBeGreaterThanOrEqual(1);
    expect(m.endpointCount).toBe(3);
    expect(m.healthyEndpoints).toBeLessThan(3); // the quota-exhausted one is unhealthy

    // The whole point: safe to export without redaction at the call site.
    const serialized = JSON.stringify(m);
    expect(serialized).not.toContain("KEY_A");
    expect(serialized).not.toContain("https://");
  });
});
