/**
 * Phase 6 — minimal in-memory fixed-window rate limiter (phase6.txt §3).
 * No new dependency: a small counter map is sufficient for a single-process
 * read-only API. Resets on process restart, which is acceptable here — the
 * goal is abuse damping, not billing-grade accounting.
 */

import { NextFunction, Request, Response } from "express";

interface Window {
  count: number;
  resetAt: number;
}

export function createRateLimiter(options: { windowMs: number; max: number; keyFn: (req: Request) => string }) {
  const windows = new Map<string, Window>();

  return function rateLimit(req: Request, res: Response, next: NextFunction): void {
    const key = options.keyFn(req);
    const now = Date.now();
    let window = windows.get(key);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + options.windowMs };
      windows.set(key, window);
    }
    window.count += 1;
    if (window.count > options.max) {
      const retryAfterSeconds = Math.ceil((window.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retryAfterSeconds));
      res.status(429).json({ error: "rate limit exceeded", retryAfterSeconds });
      return;
    }
    next();
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
