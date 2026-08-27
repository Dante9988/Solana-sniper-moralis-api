/**
 * Phase 6 — bearer-key auth (phase6.txt §3, §5). `POST /scan` always
 * requires a key from `API_KEYS`. `GET` routes require one too unless
 * `API_PUBLIC_READS=true`.
 */

import { NextFunction, Request, Response } from "express";
import { ApiConfig } from "../config";

function extractBearerToken(req: Request): string | undefined {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) return undefined;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : undefined;
}

export function requireApiKey(config: ApiConfig) {
  return function requireApiKeyMiddleware(req: Request, res: Response, next: NextFunction): void {
    const token = extractBearerToken(req);
    if (token && config.apiKeys.has(token)) {
      next();
      return;
    }
    res.status(401).json({ error: "missing or invalid API key" });
  };
}

/** Allows the request through when reads are public; otherwise requires a valid key. */
export function requireApiKeyUnlessPublicReads(config: ApiConfig) {
  const guarded = requireApiKey(config);
  return function optionalAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (config.publicReads) {
      next();
      return;
    }
    guarded(req, res, next);
  };
}
