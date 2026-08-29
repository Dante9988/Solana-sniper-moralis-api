/**
 * Phase 7B.2 — POST /api/v1/wallets/challenges, POST /api/v1/wallets/verify
 * (phase7b2.txt §2). Strictly Supabase-authenticated, like /me — a wallet
 * proof is bound to a real user identity, not an opaque internal API key.
 * All persistence/verification logic lives in
 * src/services/walletVerificationService.ts; these handlers only validate
 * the HTTP-shaped input and map service errors onto the standard envelope.
 */

import { PrismaClient } from "@prisma/client";
import { Router } from "express";
import { ApiConfig } from "../config";
import { AuthenticateDeps, createRequireSupabaseUser } from "../middleware/authenticate";
import { CreateChallengeRequestSchema, VerifyChallengeRequestSchema } from "../contracts/wallets";
import { sendError } from "../contracts/errors";
import { createRateLimiter, createRateLimiterStore, rateLimitKey } from "../middleware/rateLimit";
import { createWalletChallenge, verifyWalletChallenge, WalletVerificationError } from "../../services/walletVerificationService";

const ERROR_CODE_FOR: Record<WalletVerificationError["code"], Parameters<typeof sendError>[1]> = {
  INVALID_ADDRESS: "INVALID_ADDRESS",
  INVALID_SIGNATURE_FORMAT: "BAD_REQUEST",
  CHALLENGE_NOT_FOUND: "NOT_FOUND",
  CHALLENGE_EXPIRED: "CHALLENGE_EXPIRED",
  CHALLENGE_ALREADY_CONSUMED: "CHALLENGE_ALREADY_USED",
  ADDRESS_MISMATCH: "UNAUTHORIZED",
  USER_MISMATCH: "UNAUTHORIZED",
  SIGNATURE_INVALID: "UNAUTHORIZED",
  ADDRESS_ALREADY_CLAIMED: "WALLET_ALREADY_CLAIMED",
};

/** OnlyPump's own domain/URI bound into every challenge message (phase7b2.txt §2) — never taken from request input, so a caller can't get a challenge minted for an arbitrary domain. */
function challengeBinding() {
  const domain = process.env.ONLYPUMP_DOMAIN?.trim() || "onlypump.me";
  const uri = process.env.ONLYPUMP_URI?.trim() || `https://${domain}`;
  return { domain, uri };
}

export function createWalletsRouter(db: PrismaClient, config: ApiConfig, deps: AuthenticateDeps): Router {
  const router = Router();
  const requireSupabaseUser = createRequireSupabaseUser(deps);
  const store = createRateLimiterStore(config.rateLimit);
  // Tighter than the read limiter — challenge creation writes a row and
  // verify does real crypto work; both are worth throttling per caller.
  const challengeLimiter = createRateLimiter({ windowMs: 60_000, max: 10, keyFn: rateLimitKey, store });
  const verifyLimiter = createRateLimiter({ windowMs: 60_000, max: 20, keyFn: rateLimitKey, store });

  router.post("/challenges", requireSupabaseUser, challengeLimiter, async (req, res, next) => {
    const parsed = CreateChallengeRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "BAD_REQUEST", "address is required", req.requestId);
      return;
    }
    try {
      const { domain, uri } = challengeBinding();
      const result = await createWalletChallenge(db, {
        userId: (req.auth as { userId: string }).userId,
        address: parsed.data.address,
        domain,
        uri,
      });
      res.json({ challengeId: result.challengeId, message: result.message, expiresAt: result.expiresAt.toISOString() });
    } catch (err) {
      if (err instanceof WalletVerificationError) {
        sendError(res, ERROR_CODE_FOR[err.code], err.message, req.requestId);
        return;
      }
      next(err);
    }
  });

  router.post("/verify", requireSupabaseUser, verifyLimiter, async (req, res, next) => {
    const parsed = VerifyChallengeRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "BAD_REQUEST", "challengeId, address, and signature are all required", req.requestId);
      return;
    }
    try {
      const verified = await verifyWalletChallenge(db, {
        userId: (req.auth as { userId: string }).userId,
        challengeId: parsed.data.challengeId,
        address: parsed.data.address,
        signature: parsed.data.signature,
      });
      res.json({ id: verified.id, address: verified.address, network: verified.network, verifiedAt: verified.verifiedAt.toISOString() });
    } catch (err) {
      if (err instanceof WalletVerificationError) {
        sendError(res, ERROR_CODE_FOR[err.code], err.message, req.requestId);
        return;
      }
      next(err);
    }
  });

  return router;
}
