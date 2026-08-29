/**
 * Phase 7B.1 — the one standard error shape every /api/v1 response uses
 * (phase7b1.txt §7). Never includes a stack trace, SQL error, provider
 * secret, internal URL, private key, JWT, or raw third-party payload.
 */

import { Response } from "express";
import { z } from "./zodOpenApi";

export const ErrorCode = {
  BAD_REQUEST: "BAD_REQUEST",
  INVALID_MINT: "INVALID_MINT",
  INVALID_ADDRESS: "INVALID_ADDRESS",
  UNAUTHORIZED: "UNAUTHORIZED",
  AUTH_NOT_CONFIGURED: "AUTH_NOT_CONFIGURED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CHALLENGE_EXPIRED: "CHALLENGE_EXPIRED",
  CHALLENGE_ALREADY_USED: "CHALLENGE_ALREADY_USED",
  WALLET_ALREADY_CLAIMED: "WALLET_ALREADY_CLAIMED",
  RATE_LIMITED: "RATE_LIMITED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const ErrorEnvelopeSchema = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      requestId: z.string(),
    }),
  })
  .openapi("ErrorEnvelope");

export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

const STATUS_FOR_CODE: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  INVALID_MINT: 400,
  INVALID_ADDRESS: 400,
  UNAUTHORIZED: 401,
  AUTH_NOT_CONFIGURED: 503,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CHALLENGE_EXPIRED: 410,
  CHALLENGE_ALREADY_USED: 409,
  WALLET_ALREADY_CLAIMED: 409,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

export function sendError(res: Response, code: ErrorCode, message: string, requestId: string, status: number = STATUS_FOR_CODE[code]): void {
  const body: ErrorEnvelope = { error: { code, message, requestId } };
  res.status(status).json(body);
}
