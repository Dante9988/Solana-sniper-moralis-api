/**
 * Phase 7B.1 — shared request/response building blocks (phase7b1.txt §7).
 */

import { z } from "./zodOpenApi";

export const MintParamSchema = z
  .object({
    mint: z.string().min(32).max(64).openapi({ example: "So11111111111111111111111111111111111111112" }),
  })
  .openapi("MintParam");

export const JobKeyParamSchema = z
  .object({
    jobKey: z.string().min(1),
  })
  .openapi("JobKeyParam");

export const HealthResponseSchema = z
  .object({
    status: z.enum(["ok", "degraded"]),
    db: z.enum(["reachable", "unreachable"]),
  })
  .openapi("HealthResponse");

export const ReadyResponseSchema = z
  .object({
    status: z.enum(["ready", "not_ready"]),
    checks: z.object({
      database: z.enum(["ok", "error"]),
    }),
  })
  .openapi("ReadyResponse");

export const MeResponseSchema = z
  .object({
    userId: z.string().uuid(),
    email: z.string().email().optional(),
  })
  .openapi("MeResponse");

export const ScanAcceptedResponseSchema = z
  .object({
    jobKey: z.string(),
    status: z.string(),
  })
  .openapi("ScanAcceptedResponse");
