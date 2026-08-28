/**
 * Phase 6/7B.1 — rate limiting behind a distributed-ready abstraction
 * (phase6.txt §3, phase7b1.txt §9).
 *
 * `MemoryRateLimiterStore` is a single-process fixed-window counter — fine
 * for local dev, tests, and a single-instance deployment, but silently wrong
 * once there is more than one API process (each process gets its own
 * counters, so the effective limit multiplies by instance count).
 * `RedisRateLimiterStore` shares counters across processes via Redis
 * INCR/PEXPIRE. Which one is used is controlled by `RateLimitConfig`
 * (`RATE_LIMIT_BACKEND` / `REDIS_URL`, see ../config.ts), which itself
 * fails closed in production rather than silently defaulting to memory.
 */

import { NextFunction, Request, Response } from "express";
import type { Redis as RedisClient } from "ioredis";
import { RateLimitConfig } from "../config";

export interface RateLimitWindowResult {
  count: number;
  resetAt: number;
}

export interface RateLimiterStore {
  increment(key: string, windowMs: number): Promise<RateLimitWindowResult>;
}

export class MemoryRateLimiterStore implements RateLimiterStore {
  private readonly windows = new Map<string, RateLimitWindowResult>();

  async increment(key: string, windowMs: number): Promise<RateLimitWindowResult> {
    const now = Date.now();
    let window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + windowMs };
      this.windows.set(key, window);
    }
    window.count += 1;
    return window;
  }
}

export class RedisRateLimiterStore implements RateLimiterStore {
  constructor(private readonly redis: RedisClient) {}

  async increment(key: string, windowMs: number): Promise<RateLimitWindowResult> {
    const redisKey = `ratelimit:${key}`;
    const count = await this.redis.incr(redisKey);
    if (count === 1) {
      await this.redis.pexpire(redisKey, windowMs);
    }
    const ttl = await this.redis.pttl(redisKey);
    const resetAt = Date.now() + (ttl > 0 ? ttl : windowMs);
    return { count, resetAt };
  }
}

let sharedRedisStore: RedisRateLimiterStore | undefined;

/** One Redis connection is reused for every limiter built from the same config (see server.ts). */
export function createRateLimiterStore(config: RateLimitConfig): RateLimiterStore {
  if (config.backend === "memory") return new MemoryRateLimiterStore();

  if (!sharedRedisStore) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const IORedis = require("ioredis").default ?? require("ioredis");
    const redis = new IORedis(config.redisUrl, { lazyConnect: false, maxRetriesPerRequest: 2 });
    redis.on("error", (err: Error) => console.error("[rateLimit] Redis connection error:", err.message));
    sharedRedisStore = new RedisRateLimiterStore(redis);
  }
  return sharedRedisStore;
}

export function createRateLimiter(options: { windowMs: number; max: number; keyFn: (req: Request) => string; store?: RateLimiterStore }) {
  const store = options.store ?? new MemoryRateLimiterStore();

  return function rateLimit(req: Request, res: Response, next: NextFunction): void {
    const key = options.keyFn(req);
    store
      .increment(key, options.windowMs)
      .then(({ count, resetAt }) => {
        if (count > options.max) {
          const retryAfterSeconds = Math.ceil((resetAt - Date.now()) / 1000);
          res.setHeader("Retry-After", String(Math.max(retryAfterSeconds, 1)));
          res.status(429).json({ error: { code: "RATE_LIMITED", message: "rate limit exceeded", requestId: req.requestId ?? "" } });
          return;
        }
        next();
      })
      .catch(next);
  };
}

function requestIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

function requestApiKey(req: Request): string | undefined {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length).trim();
}

/** Keys by API key when present (authenticated caller), else by IP. */
export function rateLimitKey(req: Request): string {
  return requestApiKey(req) ?? `ip:${requestIp(req)}`;
}
