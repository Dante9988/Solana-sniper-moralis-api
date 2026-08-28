import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { createCorsMiddleware } from "../middleware/cors";
import { CorsConfig } from "../config";

function buildApp(config: CorsConfig) {
  const app = express();
  app.use(createCorsMiddleware(config));
  app.get("/thing", (_req, res) => res.json({ ok: true }));
  return app;
}

describe("CORS allowlist (phase7b1.txt §8)", () => {
  const prodConfig: CorsConfig = {
    allowedOrigins: new Set(["https://app.onlypump.me"]),
    devOrigins: new Set(["http://localhost:5173"]),
    isProduction: true,
  };

  it("allows the exact configured production origin", async () => {
    const app = buildApp(prodConfig);
    const res = await request(app).get("/thing").set("Origin", "https://app.onlypump.me");
    expect(res.headers["access-control-allow-origin"]).toBe("https://app.onlypump.me");
  });

  it("denies an unexpected browser origin — no Access-Control-Allow-Origin header at all", async () => {
    const app = buildApp(prodConfig);
    const res = await request(app).get("/thing").set("Origin", "https://evil.example.com");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rejects a preflight (OPTIONS) request from a denied origin with 403", async () => {
    const app = buildApp(prodConfig);
    const res = await request(app).options("/thing").set("Origin", "https://evil.example.com").set("Access-Control-Request-Method", "GET");
    expect(res.status).toBe(403);
  });

  it("a missing Origin header (native mobile / server-to-server) is never blocked", async () => {
    const app = buildApp(prodConfig);
    const res = await request(app).get("/thing");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("a malformed Origin header is treated as just another disallowed origin, not a crash", async () => {
    const app = buildApp(prodConfig);
    const res = await request(app).get("/thing").set("Origin", "not a url");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("does NOT honor dev origins in production", async () => {
    const app = buildApp(prodConfig);
    const res = await request(app).get("/thing").set("Origin", "http://localhost:5173");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("honors dev origins outside production", async () => {
    const devConfig: CorsConfig = { ...prodConfig, isProduction: false };
    const app = buildApp(devConfig);
    const res = await request(app).get("/thing").set("Origin", "http://localhost:5173");
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });

  it("preflight for an allowed origin returns 204 with the expected headers", async () => {
    const app = buildApp(prodConfig);
    const res = await request(app).options("/thing").set("Origin", "https://app.onlypump.me").set("Access-Control-Request-Method", "GET");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-methods"]).toMatch(/GET/);
  });
});

describe("CorsConfig loading rejects a wildcard production origin (config-level, phase7b1.txt §8)", () => {
  it("throws when CORS_ALLOWED_ORIGINS contains \"*\"", async () => {
    const { loadApiConfig } = await import("../config");
    expect(() => loadApiConfig({ CORS_ALLOWED_ORIGINS: "*", RATE_LIMIT_BACKEND: "memory" } as NodeJS.ProcessEnv)).toThrow(/\*/);
  });
});
