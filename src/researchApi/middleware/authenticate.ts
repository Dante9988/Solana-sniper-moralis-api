/**
 * Phase 7B.1 — combined authentication for the versioned gateway
 * (phase7b1.txt §5-6). A caller is authenticated one of two ways:
 *
 *   1. A valid Supabase access token (`Authorization: Bearer <supabase-jwt>`)
 *      — the path public web/mobile clients use. Verified by
 *      `supabaseAuth.ts`; never trusts a merely-decoded, unsigned, expired,
 *      wrong-issuer, or wrong-audience token.
 *   2. A valid internal `API_KEYS` bearer token — kept only for existing
 *      internal/admin/server-to-server callers (phase7b1.txt §5's "Keep
 *      API_AUTH_TOKEN only for explicitly internal/admin compatibility
 *      routes" — this is the research API's own equivalent, API_KEYS,
 *      distinct from the trading API's API_AUTH_TOKEN in src/api/index.ts).
 *
 * Fails closed: with neither Supabase nor any API key configured, every
 * authenticated route is unreachable (503 AUTH_NOT_CONFIGURED) rather than
 * silently open.
 */

import { NextFunction, Request, Response } from "express";
import { ApiConfig } from "../config";
import { sendError } from "../contracts/errors";
import { createSupabaseJwtVerifier, SupabaseAuthError, SupabaseJwtVerifier, SupabaseVerifierOverrides } from "./supabaseAuth";

export type AuthContext = { type: "supabase"; userId: string; email?: string } | { type: "apiKey" };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

function extractBearerToken(req: Request): string | undefined {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) return undefined;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : undefined;
}

/** Built once per config, reused across requests — JWKS fetches are cached internally by jose. */
export function buildSupabaseVerifier(config: ApiConfig, overrides?: SupabaseVerifierOverrides): SupabaseJwtVerifier | null {
  if (!config.supabase) return null;
  return createSupabaseJwtVerifier(config.supabase, overrides);
}

export interface AuthenticateDeps {
  supabaseVerifier: SupabaseJwtVerifier | null;
}

/** Requires either a valid Supabase JWT or a valid internal API key. */
export function createAuthenticate(config: ApiConfig, deps: AuthenticateDeps) {
  return async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!deps.supabaseVerifier && config.apiKeys.size === 0) {
      sendError(res, "AUTH_NOT_CONFIGURED", "This server has no authentication configured — refusing all authenticated requests.", req.requestId);
      return;
    }

    const token = extractBearerToken(req);
    if (!token) {
      sendError(res, "UNAUTHORIZED", "missing bearer token", req.requestId);
      return;
    }

    if (config.apiKeys.has(token)) {
      req.auth = { type: "apiKey" };
      next();
      return;
    }

    if (deps.supabaseVerifier) {
      try {
        const identity = await deps.supabaseVerifier.verify(token);
        req.auth = { type: "supabase", userId: identity.userId, email: identity.email };
        next();
        return;
      } catch (err) {
        const message = err instanceof SupabaseAuthError ? err.message : "invalid token";
        sendError(res, "UNAUTHORIZED", message, req.requestId);
        return;
      }
    }

    sendError(res, "UNAUTHORIZED", "invalid or unrecognized bearer token", req.requestId);
  };
}

/** Allows the request through unauthenticated when reads are public; otherwise requires §authenticate's rules. */
export function createAuthenticateUnlessPublicReads(config: ApiConfig, deps: AuthenticateDeps) {
  const guarded = createAuthenticate(config, deps);
  return function optionalAuth(req: Request, res: Response, next: NextFunction): void {
    if (config.publicReads) {
      next();
      return;
    }
    void guarded(req, res, next);
  };
}

/** Strictly Supabase-only — for routes (like /me) that return a Supabase-derived identity and cannot be satisfied by an opaque internal API key. */
export function createRequireSupabaseUser(deps: AuthenticateDeps) {
  return async function requireSupabaseUser(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!deps.supabaseVerifier) {
      sendError(res, "AUTH_NOT_CONFIGURED", "Supabase authentication is not configured on this server.", req.requestId);
      return;
    }
    const token = extractBearerToken(req);
    if (!token) {
      sendError(res, "UNAUTHORIZED", "missing bearer token", req.requestId);
      return;
    }
    try {
      const identity = await deps.supabaseVerifier.verify(token);
      req.auth = { type: "supabase", userId: identity.userId, email: identity.email };
      next();
    } catch (err) {
      const message = err instanceof SupabaseAuthError ? err.message : "invalid token";
      sendError(res, "UNAUTHORIZED", message, req.requestId);
    }
  };
}
