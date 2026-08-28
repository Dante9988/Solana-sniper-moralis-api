/**
 * Phase 7B.1 — server-side verification of a Supabase-issued access token
 * (phase7b1.txt §5). This is the only place a Supabase JWT is cryptographically
 * checked; every route that needs a real user identity goes through this.
 *
 * Supabase access tokens are signed either with the project's modern
 * asymmetric key (ES256/RS256, verified against the project's published
 * JWKS) or, on older projects, a shared HS256 secret (Settings -> API ->
 * JWT Settings). Both are supported; which one a given token uses is read
 * from its own (unverified) header `alg`, then verified against the
 * matching configured key material. `jose`'s `jwtVerify` always checks the
 * signature — there is no code path here that trusts a merely-decoded JWT.
 */

import { createLocalJWKSet, createRemoteJWKSet, decodeProtectedHeader, errors as joseErrors, JWK, jwtVerify, JWTVerifyGetKey } from "jose";
import { SupabaseAuthConfig } from "../config";

export class SupabaseAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupabaseAuthError";
  }
}

export interface SupabaseIdentity {
  /** The Supabase `sub` claim — an immutable UUID, the application user id. */
  userId: string;
  email?: string;
}

export interface SupabaseJwtVerifier {
  verify(token: string): Promise<SupabaseIdentity>;
}

/** Lets tests inject local key material instead of fetching Supabase's real JWKS endpoint. */
export interface SupabaseVerifierOverrides {
  jwks?: { keys: JWK[] };
}

function extractIdentity(payload: Record<string, unknown>): SupabaseIdentity {
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new SupabaseAuthError("token is missing a subject (sub) claim");
  }
  return {
    userId: payload.sub,
    email: typeof payload.email === "string" ? payload.email : undefined,
  };
}

export function createSupabaseJwtVerifier(config: SupabaseAuthConfig, overrides: SupabaseVerifierOverrides = {}): SupabaseJwtVerifier {
  const remoteOrLocalJwks: JWTVerifyGetKey = overrides.jwks
    ? createLocalJWKSet(overrides.jwks)
    : createRemoteJWKSet(new URL(config.jwksUrl));

  return {
    async verify(token: string): Promise<SupabaseIdentity> {
      let alg: string | undefined;
      try {
        alg = decodeProtectedHeader(token).alg;
      } catch {
        throw new SupabaseAuthError("malformed token");
      }
      if (!alg || alg === "none") {
        // jose's jwtVerify already refuses alg:none, but reject it explicitly
        // and early so the failure reason is unambiguous in logs.
        throw new SupabaseAuthError("unsigned tokens are never accepted");
      }

      try {
        if (alg.startsWith("HS")) {
          if (!config.hsSecret) {
            throw new SupabaseAuthError("token uses a shared-secret (HS*) signature but SUPABASE_JWT_SECRET is not configured");
          }
          const { payload } = await jwtVerify(token, new TextEncoder().encode(config.hsSecret), {
            issuer: config.issuer,
            audience: config.audience,
          });
          return extractIdentity(payload);
        }

        const { payload } = await jwtVerify(token, remoteOrLocalJwks, {
          issuer: config.issuer,
          audience: config.audience,
        });
        return extractIdentity(payload);
      } catch (err) {
        if (err instanceof SupabaseAuthError) throw err;
        if (err instanceof joseErrors.JWTExpired) throw new SupabaseAuthError("token is expired");
        if (err instanceof joseErrors.JWTClaimValidationFailed) {
          throw new SupabaseAuthError(`token claim validation failed: ${err.claim}`);
        }
        throw new SupabaseAuthError("invalid token signature");
      }
    },
  };
}
