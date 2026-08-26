import { describe, expect, it } from "vitest";
import { loadXConfig, XConfigError } from "../config";

describe("loadXConfig — defaults and fail-closed validation (phaseX.txt)", () => {
  it("defaults to the documented base URL, disabled streaming, and no token when env is empty", () => {
    const config = loadXConfig({});
    expect(config.baseUrl).toBe("https://api.x.com/2");
    expect(config.streamEnabled).toBe(false);
    expect(config.requestTimeoutMs).toBe(8000);
    expect(config.bearerToken).toBeUndefined();
  });

  it("the token is present only when explicitly provided in the given env — never read from real process.env by default in tests", () => {
    const withToken = loadXConfig({ X_BEARER_TOKEN: "fake-test-token-not-real" });
    expect(withToken.bearerToken).toBe("fake-test-token-not-real");

    const withoutToken = loadXConfig({});
    expect(withoutToken.bearerToken).toBeUndefined();
  });

  it("treats a blank/whitespace-only token as not configured", () => {
    const config = loadXConfig({ X_BEARER_TOKEN: "   " });
    expect(config.bearerToken).toBeUndefined();
  });

  it("accepts a valid https base URL and strips a trailing slash", () => {
    const config = loadXConfig({ X_API_BASE_URL: "https://api.x.com/2/" });
    expect(config.baseUrl).toBe("https://api.x.com/2");
  });

  it("rejects a non-https base URL", () => {
    expect(() => loadXConfig({ X_API_BASE_URL: "http://api.x.com/2" })).toThrow(XConfigError);
  });

  it("rejects a malformed base URL", () => {
    expect(() => loadXConfig({ X_API_BASE_URL: "not a url" })).toThrow(XConfigError);
  });

  it("strict boolean parsing: only exactly 'true' or 'false' are accepted for X_STREAM_ENABLED", () => {
    expect(loadXConfig({ X_STREAM_ENABLED: "true" }).streamEnabled).toBe(true);
    expect(loadXConfig({ X_STREAM_ENABLED: "false" }).streamEnabled).toBe(false);
    for (const bad of ["1", "yes", "enabled", "0", "True1"]) {
      expect(() => loadXConfig({ X_STREAM_ENABLED: bad })).toThrow(XConfigError);
    }
  });

  it("never silently enables streaming on malformed/unknown configuration — it throws instead", () => {
    expect(() => loadXConfig({ X_STREAM_ENABLED: "maybe" })).toThrow(XConfigError);
  });

  it("X_STREAM_ENABLED defaults to false and stays false unless explicitly set", () => {
    expect(loadXConfig({}).streamEnabled).toBe(false);
  });

  it("validates X_REQUEST_TIMEOUT_MS as a positive integer with a safe default", () => {
    expect(loadXConfig({}).requestTimeoutMs).toBe(8000);
    expect(loadXConfig({ X_REQUEST_TIMEOUT_MS: "5000" }).requestTimeoutMs).toBe(5000);
    expect(() => loadXConfig({ X_REQUEST_TIMEOUT_MS: "0" })).toThrow(XConfigError);
    expect(() => loadXConfig({ X_REQUEST_TIMEOUT_MS: "-1" })).toThrow(XConfigError);
    expect(() => loadXConfig({ X_REQUEST_TIMEOUT_MS: "abc" })).toThrow(XConfigError);
  });

  it("the returned config is frozen (cannot be mutated by a caller)", () => {
    const config = loadXConfig({});
    expect(() => {
      // @ts-expect-error intentionally attempting a disallowed mutation
      config.streamEnabled = true;
    }).toThrow();
  });
});
