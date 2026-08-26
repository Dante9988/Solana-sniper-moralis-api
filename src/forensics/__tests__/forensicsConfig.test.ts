import { describe, expect, it } from "vitest";
import { loadForensicsClientRuntimeConfig, resolveHeliusRpcUrl } from "../forensicsConfig";
import { ForensicsConfigError } from "../thresholds";

describe("loadForensicsClientRuntimeConfig", () => {
  it("uses documented defaults when env vars are absent", () => {
    const config = loadForensicsClientRuntimeConfig({});
    expect(config.requestTimeoutMs).toBe(8_000);
    expect(config.totalDeadlineMs).toBe(15_000);
    expect(config.maxResponseBytes).toBe(2 * 1024 * 1024);
    expect(config.maxRetries).toBe(3);
    expect(config.baseRetryDelayMs).toBe(200);
    expect(config.maxRetryDelayMs).toBe(4_000);
  });

  it("fails closed on a non-positive-integer value", () => {
    expect(() => loadForensicsClientRuntimeConfig({ FORENSICS_REQUEST_TIMEOUT_MS: "0" })).toThrow(
      ForensicsConfigError
    );
    expect(() => loadForensicsClientRuntimeConfig({ FORENSICS_MAX_RETRIES: "-1" })).toThrow(
      ForensicsConfigError
    );
    expect(() => loadForensicsClientRuntimeConfig({ FORENSICS_MAX_RESPONSE_BYTES: "abc" })).toThrow(
      ForensicsConfigError
    );
  });

  it("accepts a valid override", () => {
    expect(loadForensicsClientRuntimeConfig({ FORENSICS_REQUEST_TIMEOUT_MS: "5000" }).requestTimeoutMs).toBe(
      5000
    );
  });
});

describe("resolveHeliusRpcUrl", () => {
  it("returns undefined (never throws) when unset", () => {
    expect(resolveHeliusRpcUrl({})).toBeUndefined();
  });

  it("returns the configured URL when present", () => {
    expect(resolveHeliusRpcUrl({ HELIUS_HTTPS_URI: "https://example.test/?api-key=fake" })).toBe(
      "https://example.test/?api-key=fake"
    );
  });
});
