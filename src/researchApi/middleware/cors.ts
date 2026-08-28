/**
 * Phase 7B.1 — explicit CORS allowlist, no wildcard (phase7b1.txt §8).
 *
 * Native mobile clients (Expo) don't send a browser `Origin` header for
 * same-app requests and aren't subject to CORS at all — this middleware
 * only ever affects browser callers, and only ever needs to list the web
 * origins that should be allowed to read the response.
 */

import { NextFunction, Request, Response } from "express";
import { CorsConfig } from "../config";

function isAllowedOrigin(origin: string, config: CorsConfig): boolean {
  if (config.allowedOrigins.has(origin)) return true;
  if (!config.isProduction && config.devOrigins.has(origin)) return true;
  return false;
}

export function createCorsMiddleware(config: CorsConfig) {
  return function cors(req: Request, res: Response, next: NextFunction): void {
    const origin = req.header("origin");

    // No Origin header at all -> not a browser cross-origin request (server-to-
    // server, curl, a native mobile client). Nothing to do; let it through to
    // normal auth/route handling untouched.
    if (!origin) {
      next();
      return;
    }

    if (!isAllowedOrigin(origin, config)) {
      // Do not set any Access-Control-* headers — the browser enforces the
      // block on its own. We still let the request reach routes (matching
      // standard CORS behavior for simple/non-preflighted requests) rather
      // than 403ing here, since a same-origin server client could also send
      // an Origin header; the browser is the actual enforcement point for
      // cross-origin reads. Preflight (OPTIONS) requests, however, must be
      // rejected outright so the browser never proceeds to the real request.
      if (req.method === "OPTIONS") {
        res.status(403).end();
        return;
      }
      next();
      return;
    }

    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type");
    res.setHeader("Access-Control-Max-Age", "600");

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}
