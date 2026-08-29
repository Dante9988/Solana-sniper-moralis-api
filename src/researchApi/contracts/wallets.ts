/**
 * Phase 7B.2 — request/response contracts for wallet-ownership verification
 * (phase7b1.txt-style single Zod source, phase7b2.txt §2).
 */

import { z } from "./zodOpenApi";

export const CreateChallengeRequestSchema = z
  .object({
    address: z.string().min(32).max(64).openapi({ example: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin" }),
  })
  .openapi("CreateWalletChallengeRequest");

export const CreateChallengeResponseSchema = z
  .object({
    challengeId: z.string(),
    message: z.string(),
    expiresAt: z.string(),
  })
  .openapi("CreateWalletChallengeResponse");

export const VerifyChallengeRequestSchema = z
  .object({
    challengeId: z.string().min(1),
    address: z.string().min(32).max(64),
    signature: z.string().min(1).openapi({ description: "Base58-encoded detached Ed25519 signature from wallet-adapter's signMessage." }),
  })
  .openapi("VerifyWalletChallengeRequest");

export const VerifiedWalletSchema = z
  .object({
    id: z.string(),
    address: z.string(),
    network: z.string(),
    verifiedAt: z.string(),
  })
  .openapi("VerifiedWallet");

export const VerifiedWalletListSchema = z.array(VerifiedWalletSchema).openapi("VerifiedWalletList");
