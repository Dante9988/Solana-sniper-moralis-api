import { describe, expect, it } from "vitest";
import { ApiConfigError, loadApiConfig } from "../config";

describe("rate-limit backend: fails closed in production (phase7b1.txt §9)", () => {
  it("throws when NODE_ENV=production and RATE_LIMIT_BACKEND is unset — no silent in-memory default", () => {
    expect(() => loadApiConfig({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(ApiConfigError);
  });

  it("throws when RATE_LIMIT_BACKEND=redis but REDIS_URL is unset", () => {
    expect(() => loadApiConfig({ RATE_LIMIT_BACKEND: "redis" } as NodeJS.ProcessEnv)).toThrow(/REDIS_URL/);
  });

  it("succeeds with RATE_LIMIT_BACKEND=redis when REDIS_URL is set", () => {
    const config = loadApiConfig({ RATE_LIMIT_BACKEND: "redis", REDIS_URL: "redis://localhost:6379" } as NodeJS.ProcessEnv);
    expect(config.rateLimit).toEqual({ backend: "redis", redisUrl: "redis://localhost:6379" });
  });

  it("defaults to memory outside production when unset", () => {
    const config = loadApiConfig({} as NodeJS.ProcessEnv);
    expect(config.rateLimit.backend).toBe("memory");
  });

  it("rejects an unrecognized backend value", () => {
    expect(() => loadApiConfig({ RATE_LIMIT_BACKEND: "memcached" } as NodeJS.ProcessEnv)).toThrow(ApiConfigError);
  });

  it("production succeeds when RATE_LIMIT_BACKEND is explicitly memory", () => {
    const config = loadApiConfig({
      NODE_ENV: "production",
      RATE_LIMIT_BACKEND: "memory",
      REALTIME_BACKEND: "memory",
    } as NodeJS.ProcessEnv);
    expect(config.rateLimit.backend).toBe("memory");
  });
});

describe("realtime backend (event bus + WS ticket store): fails closed in production (phase7b2.txt §6)", () => {
  it("throws when NODE_ENV=production and REALTIME_BACKEND is unset — no silent in-memory default", () => {
    expect(() => loadApiConfig({ NODE_ENV: "production", RATE_LIMIT_BACKEND: "memory" } as NodeJS.ProcessEnv)).toThrow(ApiConfigError);
  });

  it("throws when REALTIME_BACKEND=redis but REDIS_URL is unset", () => {
    expect(() => loadApiConfig({ REALTIME_BACKEND: "redis" } as NodeJS.ProcessEnv)).toThrow(/REDIS_URL/);
  });

  it("succeeds with REALTIME_BACKEND=redis when REDIS_URL is set", () => {
    const config = loadApiConfig({ REALTIME_BACKEND: "redis", REDIS_URL: "redis://localhost:6379" } as NodeJS.ProcessEnv);
    expect(config.realtime.backend).toBe("redis");
    expect(config.realtime.redisUrl).toBe("redis://localhost:6379");
  });

  it("defaults to memory outside production when there is no database to carry events over", () => {
    const config = loadApiConfig({} as NodeJS.ProcessEnv);
    expect(config.realtime.backend).toBe("memory");
  });

  // Phase 7D.6. The old default was memory *always*, which meant the candles worker published
  // into a bus the API could not hear: the chart never moved and nothing reported a problem
  // (docs/phase-7d6/root-cause.md). Where a database exists, events go over it by default.
  it("defaults to postgres when DATABASE_URL is set, so worker events reach the API", () => {
    const config = loadApiConfig({ DATABASE_URL: "postgresql://u:p@localhost:5432/app" } as NodeJS.ProcessEnv);
    expect(config.realtime.backend).toBe("postgres");
    expect(config.realtime.databaseUrl).toBe("postgresql://u:p@localhost:5432/app");
  });

  it("an explicit memory backend still wins over the postgres default", () => {
    const config = loadApiConfig({ DATABASE_URL: "postgresql://u:p@localhost:5432/app", REALTIME_BACKEND: "memory" } as NodeJS.ProcessEnv);
    expect(config.realtime.backend).toBe("memory");
  });

  it("throws when REALTIME_BACKEND=postgres but DATABASE_URL is unset", () => {
    expect(() => loadApiConfig({ REALTIME_BACKEND: "postgres" } as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL/);
  });

  it("production accepts an explicit postgres backend", () => {
    const config = loadApiConfig({
      NODE_ENV: "production",
      RATE_LIMIT_BACKEND: "memory",
      REALTIME_BACKEND: "postgres",
      DATABASE_URL: "postgresql://u:p@db:5432/app",
    } as NodeJS.ProcessEnv);
    expect(config.realtime.backend).toBe("postgres");
  });

  it("rejects an unrecognized backend value", () => {
    expect(() => loadApiConfig({ REALTIME_BACKEND: "kafka" } as NodeJS.ProcessEnv)).toThrow(ApiConfigError);
  });

  it("production succeeds when both RATE_LIMIT_BACKEND and REALTIME_BACKEND are explicitly memory", () => {
    const config = loadApiConfig({
      NODE_ENV: "production",
      RATE_LIMIT_BACKEND: "memory",
      REALTIME_BACKEND: "memory",
    } as NodeJS.ProcessEnv);
    expect(config.realtime.backend).toBe("memory");
  });

  it("applies sane defaults for ticket TTL, message size, and connection/subscription limits", () => {
    const config = loadApiConfig({} as NodeJS.ProcessEnv);
    expect(config.realtime.ticketTtlMs).toBeGreaterThanOrEqual(30_000);
    expect(config.realtime.ticketTtlMs).toBeLessThanOrEqual(60_000);
    expect(config.realtime.maxMessageBytes).toBeGreaterThan(0);
    expect(config.realtime.maxSubscriptionsPerConnection).toBeGreaterThan(0);
    expect(config.realtime.maxConnectionsPerUser).toBeGreaterThan(0);
  });
});

describe("CORS config", () => {
  it("rejects a wildcard origin", () => {
    expect(() => loadApiConfig({ CORS_ALLOWED_ORIGINS: "*" } as NodeJS.ProcessEnv)).toThrow(ApiConfigError);
  });

  it("rejects a wildcard mixed in with real origins", () => {
    expect(() => loadApiConfig({ CORS_ALLOWED_ORIGINS: "https://app.onlypump.me,*" } as NodeJS.ProcessEnv)).toThrow(ApiConfigError);
  });

  it("parses a comma-separated allowlist, trimming whitespace", () => {
    const config = loadApiConfig({ CORS_ALLOWED_ORIGINS: " https://app.onlypump.me , https://admin.onlypump.me " } as NodeJS.ProcessEnv);
    expect(config.cors.allowedOrigins).toEqual(new Set(["https://app.onlypump.me", "https://admin.onlypump.me"]));
  });

  it("defaults dev origins to the usual local Vite/Expo ports when unset", () => {
    const config = loadApiConfig({} as NodeJS.ProcessEnv);
    expect(config.cors.devOrigins.has("http://localhost:5173")).toBe(true);
    // The web app's Vite port, under both host spellings a browser may use.
    expect(config.cors.devOrigins.has("http://localhost:8080")).toBe(true);
    expect(config.cors.devOrigins.has("http://127.0.0.1:8080")).toBe(true);
  });
});

describe("Supabase config", () => {
  it("is null (feature off) when SUPABASE_URL is unset", () => {
    const config = loadApiConfig({} as NodeJS.ProcessEnv);
    expect(config.supabase).toBeNull();
  });

  it("derives issuer and jwksUrl from SUPABASE_URL, stripping a trailing slash", () => {
    const config = loadApiConfig({ SUPABASE_URL: "https://xyz.supabase.co/" } as NodeJS.ProcessEnv);
    expect(config.supabase).toEqual({
      projectUrl: "https://xyz.supabase.co",
      issuer: "https://xyz.supabase.co/auth/v1",
      jwksUrl: "https://xyz.supabase.co/auth/v1/.well-known/jwks.json",
      hsSecret: undefined,
      audience: undefined,
    });
  });

  it("rejects a malformed SUPABASE_URL", () => {
    expect(() => loadApiConfig({ SUPABASE_URL: "not a url" } as NodeJS.ProcessEnv)).toThrow(ApiConfigError);
  });

  it("carries an optional HS secret and audience through", () => {
    const config = loadApiConfig({
      SUPABASE_URL: "https://xyz.supabase.co",
      SUPABASE_JWT_SECRET: "shh",
      SUPABASE_JWT_AUDIENCE: "authenticated",
    } as NodeJS.ProcessEnv);
    expect(config.supabase?.hsSecret).toBe("shh");
    expect(config.supabase?.audience).toBe("authenticated");
  });
});
