/**
 * Phase 7B.1 — the single authoritative OpenAPI document generator
 * (phase7b1.txt §7): every path registered here is generated directly from
 * the same Zod schemas the routes validate against, so the docs, the
 * runtime validation, and (eventually) a generated TypeScript client all
 * come from one definition instead of three hand-maintained ones.
 */

import { OpenApiGeneratorV31, OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { ErrorEnvelopeSchema } from "./errors";
import { HealthResponseSchema, JobKeyParamSchema, MeResponseSchema, MintParamSchema, ReadyResponseSchema, ScanAcceptedResponseSchema } from "./common";
import { CreateChallengeRequestSchema, CreateChallengeResponseSchema, VerifiedWalletListSchema, VerifiedWalletSchema, VerifyChallengeRequestSchema } from "./wallets";
import { z } from "./zodOpenApi";

const registry = new OpenAPIRegistry();

const bearerAuth = registry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "JWT",
  description: "A Supabase access token (or, for internal/admin callers, an API_KEYS token).",
});

const errorResponse = { description: "Standard error envelope", content: { "application/json": { schema: ErrorEnvelopeSchema } } };

registry.registerPath({
  method: "get",
  path: "/api/v1/health",
  summary: "Liveness — proves the process is up. No auth, no dependency checks.",
  tags: ["operational"],
  responses: {
    200: { description: "Process is alive", content: { "application/json": { schema: HealthResponseSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/ready",
  summary: "Readiness — checks required dependencies (database) without leaking connection details.",
  tags: ["operational"],
  responses: {
    200: { description: "Ready to serve traffic", content: { "application/json": { schema: ReadyResponseSchema } } },
    503: { description: "Not ready", content: { "application/json": { schema: ReadyResponseSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/me",
  summary: "The authenticated user's minimal identity, derived from their verified Supabase token.",
  tags: ["identity"],
  security: [{ [bearerAuth.name]: [] }],
  responses: {
    200: { description: "Caller identity", content: { "application/json": { schema: MeResponseSchema } } },
    401: errorResponse,
    503: errorResponse,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/tokens/{mint}/report",
  summary: "The deterministic risk view for a token mint, if it has ever been analysed.",
  tags: ["token-intelligence"],
  security: [{ [bearerAuth.name]: [] }],
  request: { params: MintParamSchema },
  responses: {
    200: { description: "Risk view", content: { "application/json": { schema: z.object({ apiVersion: z.number(), mint: z.string(), verdict: z.string() }).passthrough() } } },
    400: errorResponse,
    401: errorResponse,
    404: errorResponse,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/tokens/{mint}/forensics",
  summary: "The latest Solana forensics run for a token mint, if one exists.",
  tags: ["token-intelligence"],
  security: [{ [bearerAuth.name]: [] }],
  request: { params: MintParamSchema },
  responses: {
    200: { description: "Forensics run", content: { "application/json": { schema: z.object({ apiVersion: z.number(), mint: z.string() }).passthrough() } } },
    400: errorResponse,
    401: errorResponse,
    404: errorResponse,
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/tokens/{mint}/scans",
  summary: "Idempotently enqueue a forensics scan for a token mint. Returns the same jobKey on repeat calls for the same mint.",
  tags: ["token-intelligence"],
  security: [{ [bearerAuth.name]: [] }],
  request: { params: MintParamSchema },
  responses: {
    202: { description: "Scan accepted (queued or already in flight)", content: { "application/json": { schema: ScanAcceptedResponseSchema } } },
    400: errorResponse,
    401: errorResponse,
    429: errorResponse,
  },
});

const walletIdParam = z.object({ walletId: z.string() }).openapi("WalletIdParam");
const ticketResponse = z.object({ ticket: z.string(), expiresInMs: z.number() }).openapi("RealtimeTicketResponse");

registry.registerPath({
  method: "post",
  path: "/api/v1/wallets/challenges",
  summary: "Create a short-lived, single-use wallet-ownership challenge for the authenticated user to sign (never a transaction).",
  tags: ["wallet-verification"],
  security: [{ [bearerAuth.name]: [] }],
  request: { body: { content: { "application/json": { schema: CreateChallengeRequestSchema } } } },
  responses: {
    200: { description: "Challenge created", content: { "application/json": { schema: CreateChallengeResponseSchema } } },
    400: errorResponse,
    401: errorResponse,
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/wallets/verify",
  summary: "Verify a detached Ed25519 signature over a previously issued challenge, linking the address to the authenticated user.",
  tags: ["wallet-verification"],
  security: [{ [bearerAuth.name]: [] }],
  request: { body: { content: { "application/json": { schema: VerifyChallengeRequestSchema } } } },
  responses: {
    200: { description: "Wallet verified", content: { "application/json": { schema: VerifiedWalletSchema } } },
    400: errorResponse,
    401: errorResponse,
    409: errorResponse,
    410: errorResponse,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/me/wallets",
  summary: "List the authenticated user's own verified wallets.",
  tags: ["wallet-verification"],
  security: [{ [bearerAuth.name]: [] }],
  responses: {
    200: { description: "Verified wallets", content: { "application/json": { schema: VerifiedWalletListSchema } } },
    401: errorResponse,
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/v1/me/wallets/{walletId}",
  summary: "Unlink one of the authenticated user's verified wallets. Never deletes blockchain history or shared token intelligence.",
  tags: ["wallet-verification"],
  security: [{ [bearerAuth.name]: [] }],
  request: { params: walletIdParam },
  responses: {
    204: { description: "Unlinked" },
    401: errorResponse,
    404: errorResponse,
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/realtime/tickets",
  summary: "Issue a short-lived, single-use ticket for connecting to the WebSocket endpoint. Never a substitute for the Supabase token itself.",
  tags: ["realtime"],
  security: [{ [bearerAuth.name]: [] }],
  responses: {
    200: { description: "Ticket issued", content: { "application/json": { schema: ticketResponse } } },
    401: errorResponse,
    503: errorResponse,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/jobs/{jobKey}",
  summary: "Poll a forensics job's status.",
  tags: ["token-intelligence"],
  security: [{ [bearerAuth.name]: [] }],
  request: { params: JobKeyParamSchema },
  responses: {
    200: { description: "Job status", content: { "application/json": { schema: z.object({ jobKey: z.string(), status: z.string() }).passthrough() } } },
    401: errorResponse,
    404: errorResponse,
  },
});

export function generateOpenApiDocument() {
  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: "OnlyPump API",
      version: "1.0.0",
      description:
        "Versioned REST gateway for the OnlyPump web and mobile applications. Read-only token intelligence today; see ARCHITECTURE.md for what's planned next.",
    },
    servers: [{ url: "https://api.onlypump.me/api/v1", description: "Production" }],
  });
}
