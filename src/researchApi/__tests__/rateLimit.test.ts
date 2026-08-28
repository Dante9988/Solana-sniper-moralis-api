import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createRateLimiter, MemoryRateLimiterStore, RedisRateLimiterStore } from "../middleware/rateLimit";

function buildApp(store: ReturnType<typeof createRateLimiter> extends never ? never : Parameters<typeof createRateLimiter>[0]["store"]) {
  const app = express();
  app.use((req, _res, next) => {
    req.requestId = "test-request-id";
    next();
  });
  const limiter = createRateLimiter({ windowMs: 60_000, max: 2, keyFn: () => "fixed-key", store });
  app.get("/thing", limiter, (_req, res) => res.json({ ok: true }));
  return app;
}

describe("MemoryRateLimiterStore-backed limiter (phase7b1.txt §9)", () => {
  it("allows up to `max` requests in the window, then 429s with a standard error envelope", async () => {
    const app = buildApp(new MemoryRateLimiterStore());
    expect((await request(app).get("/thing")).status).toBe(200);
    expect((await request(app).get("/thing")).status).toBe(200);
    const third = await request(app).get("/thing");
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe("RATE_LIMITED");
    expect(third.headers["retry-after"]).toBeTruthy();
  });
});

describe("RedisRateLimiterStore (mocked ioredis client — never a live connection, phase7b1.txt §11)", () => {
  function fakeRedis() {
    const counts = new Map<string, number>();
    return {
      incr: vi.fn(async (key: string) => {
        const next = (counts.get(key) ?? 0) + 1;
        counts.set(key, next);
        return next;
      }),
      pexpire: vi.fn(async () => 1),
      pttl: vi.fn(async () => 60_000),
    };
  }

  it("increments a shared counter via INCR/PEXPIRE/PTTL and enforces the same limit as the memory store", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const redis = fakeRedis() as any;
    const store = new RedisRateLimiterStore(redis);
    const app = buildApp(store);

    expect((await request(app).get("/thing")).status).toBe(200);
    expect((await request(app).get("/thing")).status).toBe(200);
    const third = await request(app).get("/thing");
    expect(third.status).toBe(429);

    expect(redis.incr).toHaveBeenCalledTimes(3);
    expect(redis.pexpire).toHaveBeenCalledTimes(1); // only set on the first increment
  });

  it("propagates a Redis error to the route's error handler rather than silently allowing the request through", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const redis = { incr: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")), pexpire: vi.fn(), pttl: vi.fn() } as any;
    const store = new RedisRateLimiterStore(redis);
    const app = express();
    app.use((req, _res, next) => {
      req.requestId = "test-request-id";
      next();
    });
    const limiter = createRateLimiter({ windowMs: 60_000, max: 2, keyFn: () => "fixed-key", store });
    app.get("/thing", limiter, (_req, res) => res.json({ ok: true }));
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: "internal error" });
    });

    const res = await request(app).get("/thing");
    expect(res.status).toBe(500);
  });
});
