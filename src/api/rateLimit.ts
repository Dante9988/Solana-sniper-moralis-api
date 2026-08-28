/**
 * Minimal in-memory fixed-window rate limiter for the unauthenticated
 * `/pay/*` Solana Pay routes (phase7.txt §3: "Add rate limiting ... for
 * public payment intents"). Mirrors src/researchApi/middleware/rateLimit.ts
 * but is duplicated rather than imported — this trading surface is
 * deliberately kept decoupled from the read-only research API (see
 * ARCHITECTURE.md §8.4).
 */

import { NextFunction, Request, Response } from 'express';

interface Window {
  count: number;
  resetAt: number;
}

export function createRateLimiter(options: { windowMs: number; max: number }) {
  const windows = new Map<string, Window>();

  return function rateLimit(req: Request, res: Response, next: NextFunction): void {
    const key = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    let window = windows.get(key);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + options.windowMs };
      windows.set(key, window);
    }
    window.count += 1;
    if (window.count > options.max) {
      const retryAfterSeconds = Math.ceil((window.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.status(429).json({ error: 'rate limit exceeded', retryAfterSeconds });
      return;
    }
    next();
  };
}
