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
import {
  RobinhoodTokenAddressParamSchema,
  RobinhoodTokenDetailResponseSchema,
  RobinhoodTokenListResponseSchema,
  RobinhoodStatusResponseSchema,
} from "./robinhoodTokens";
import { CandleHistoryResponseSchema } from "./candles";
import { CalloutListResponseSchema } from "./callouts";
import { PoolEvidenceResponseSchema } from "./poolEvidence";
import {
  CreatePaperPositionRequestSchema,
  EvidenceSnapshotParamSchema,
  EvidenceSnapshotSchema,
  MarketEvidenceResponseSchema,
  PaperPositionListResponseSchema,
  PaperPositionResponseSchema,
  QuoteRequestSchema,
  QuoteResponseSchema,
  SimulationRequestSchema,
  SimulationResponseSchema,
} from "./paperTrading";
import { TokenMarketDataResponseSchema } from "./marketData";
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
  method: "get",
  path: "/api/v1/tokens/robinhood",
  summary: "Recently discovered Pons/Robinhood Chain tokens, newest first (Phase 7B.4).",
  tags: ["robinhood-chain"],
  security: [{ [bearerAuth.name]: [] }],
  responses: {
    200: { description: "Discovered token list", content: { "application/json": { schema: RobinhoodTokenListResponseSchema } } },
    400: errorResponse,
    401: errorResponse,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/tokens/robinhood/status",
  summary: "Backend-owned Pons/Robinhood Chain ingestion source-health projection (Phase 7B.5A) — LIVE/LAGGING/DEGRADED/REORG_RECOVERY/UNAVAILABLE, never inferred client-side.",
  tags: ["robinhood-chain"],
  security: [{ [bearerAuth.name]: [] }],
  responses: {
    200: { description: "Ingestion source health", content: { "application/json": { schema: RobinhoodStatusResponseSchema } } },
    401: errorResponse,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/tokens/robinhood/{tokenAddress}",
  summary: "One discovered Robinhood Chain token's detail with its recent trades (Phase 7B.4).",
  tags: ["robinhood-chain"],
  security: [{ [bearerAuth.name]: [] }],
  request: { params: RobinhoodTokenAddressParamSchema },
  responses: {
    200: { description: "Token detail with trades", content: { "application/json": { schema: RobinhoodTokenDetailResponseSchema } } },
    400: errorResponse,
    401: errorResponse,
    404: errorResponse,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/tokens/robinhood/{tokenAddress}/candles",
  summary: "Materialized OHLCV candle history for a Robinhood/Pons token (Phase 7B.5B) — reads PostgreSQL only, never Robinhood RPC inline.",
  tags: ["robinhood-chain", "candles"],
  security: [{ [bearerAuth.name]: [] }],
  request: { params: RobinhoodTokenAddressParamSchema },
  responses: {
    200: { description: "Candle history", content: { "application/json": { schema: CandleHistoryResponseSchema } } },
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

registry.registerPath({
  method: "get",
  path: "/api/v1/tokens/robinhood/{tokenAddress}/pool",
  deprecated: true,
  summary:
    "Deprecated by /market-evidence (Phase 7D.3.2), which is block-pinned, covers bonding curves and ERC-20 pair assets, and separates raw liquidity from depth. Live Uniswap V4 pool evidence for a graduated Pons V2 token (Phase 7D.3 §5). Native-denominated only — no USD conversion exists for this chain. Always 200: a token with no V4 pool returns status UNAVAILABLE with a reason code.",
  tags: ["robinhood-chain"],
  security: [{ [bearerAuth.name]: [] }],
  request: { params: RobinhoodTokenAddressParamSchema },
  responses: {
    200: { description: "Pool evidence, or an explicit unavailable reason", content: { "application/json": { schema: PoolEvidenceResponseSchema } } },
    400: errorResponse,
    401: errorResponse,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/callouts",
  summary: "Verified PnL callouts the tracker has already shared, best first (Phase 7F.2).",
  tags: ["callouts"],
  security: [{ [bearerAuth.name]: [] }],
  request: { query: z.object({ limit: z.coerce.number().int().min(1).max(100).optional() }) },
  responses: {
    200: { description: "Verified callout list", content: { "application/json": { schema: CalloutListResponseSchema } } },
    400: errorResponse,
    401: errorResponse,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/callouts/{mint}",
  summary: "Verified callout history for one token (Phase 7F.2).",
  tags: ["callouts"],
  security: [{ [bearerAuth.name]: [] }],
  request: { params: MintParamSchema },
  responses: {
    200: { description: "Verified callout list", content: { "application/json": { schema: CalloutListResponseSchema } } },
    401: errorResponse,
    404: errorResponse,
  },
});

// --- Phase 7D.3.2 — quotes, simulations, evidence, paper positions ---

registry.registerPath({
  method: "post",
  path: "/api/v1/tokens/robinhood/{tokenAddress}/quotes",
  summary:
    "Amount-specific quote for a Pons V2 token at one pinned block (curve formula or official V4Quoter). An estimate — not a simulation and not a fill. UNSUPPORTED and UNAVAILABLE are 200 results with a reason.",
  tags: ["paper-trading"],
  security: [{ [bearerAuth.name]: [] }],
  request: { params: RobinhoodTokenAddressParamSchema, body: { content: { "application/json": { schema: QuoteRequestSchema } } } },
  responses: {
    200: { description: "Quote, refusal, or unavailable state", content: { "application/json": { schema: QuoteResponseSchema } } },
    400: errorResponse,
    401: errorResponse,
    429: errorResponse,
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/tokens/robinhood/{tokenAddress}/simulations",
  summary:
    "Execute a quote's trade through the real route (UniversalRouter or bonding curve) at the quote's block, from a synthetic account via eth_call state override. Nothing is signed or broadcast.",
  tags: ["paper-trading"],
  security: [{ [bearerAuth.name]: [] }],
  request: { params: RobinhoodTokenAddressParamSchema, body: { content: { "application/json": { schema: SimulationRequestSchema } } } },
  responses: {
    200: { description: "Simulation result, refusal, or unavailable state", content: { "application/json": { schema: SimulationResponseSchema } } },
    400: errorResponse,
    404: errorResponse,
    409: { description: "QUOTE_EXPIRED or QUOTE_NOT_FILLABLE", content: { "application/json": { schema: ErrorEnvelopeSchema } } },
    429: errorResponse,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/tokens/robinhood/{tokenAddress}/market",
  summary:
    "Market data from OnlyPump's indexed trades: last traded price (native, and USD from a verified Chainlink feed), total supply and FDV, rolling 5m–24h windows with explicit coverage, and recent trades. Circulating market cap is not provided.",
  tags: ["robinhood-chain"],
  security: [{ [bearerAuth.name]: [] }],
  request: { params: RobinhoodTokenAddressParamSchema },
  responses: {
    200: { description: "Market data, or an explicit unavailable reason", content: { "application/json": { schema: TokenMarketDataResponseSchema } } },
    400: errorResponse,
    401: errorResponse,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/tokens/robinhood/{tokenAddress}/market-evidence",
  summary:
    "Pinned-block market evidence for a Pons V2 token on either venue: phase, pair asset, spot price, fee terms, curve progress, depth at reference sizes (curve formula or official quoter) and advanced protocol parameters. No USD.",
  tags: ["paper-trading"],
  security: [{ [bearerAuth.name]: [] }],
  request: { params: RobinhoodTokenAddressParamSchema },
  responses: {
    200: { description: "Evidence, refusal, or unavailable state", content: { "application/json": { schema: MarketEvidenceResponseSchema } } },
    400: errorResponse,
    401: errorResponse,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/evidence/{snapshotId}",
  summary: "An immutable quote or simulation evidence snapshot: pinned block/hash, timestamps, versions, sources and missing evidence.",
  tags: ["paper-trading"],
  security: [{ [bearerAuth.name]: [] }],
  request: { params: EvidenceSnapshotParamSchema },
  responses: {
    200: { description: "Evidence snapshot", content: { "application/json": { schema: EvidenceSnapshotSchema } } },
    400: errorResponse,
    404: errorResponse,
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/me/paper-positions",
  summary:
    "Save a paper fill for the signed-in user from an unexpired quote and, optionally, its successful simulation. Idempotent per Idempotency-Key: a retry returns the original (200); a new fill returns 201.",
  tags: ["paper-trading"],
  security: [{ [bearerAuth.name]: [] }],
  request: {
    headers: z.object({ "Idempotency-Key": z.string().regex(/^[A-Za-z0-9_-]{8,128}$/) }),
    body: { content: { "application/json": { schema: CreatePaperPositionRequestSchema } } },
  },
  responses: {
    200: { description: "Replayed — the original paper position", content: { "application/json": { schema: PaperPositionResponseSchema } } },
    201: { description: "Created", content: { "application/json": { schema: PaperPositionResponseSchema } } },
    400: errorResponse,
    401: errorResponse,
    404: errorResponse,
    409: { description: "QUOTE_EXPIRED, QUOTE_NOT_FILLABLE, SIMULATION_NOT_FOR_QUOTE or SIMULATION_NOT_SUCCESSFUL", content: { "application/json": { schema: ErrorEnvelopeSchema } } },
    422: { description: "IDEMPOTENCY_KEY_REUSED", content: { "application/json": { schema: ErrorEnvelopeSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/me/paper-positions",
  summary: "The signed-in user's paper positions, newest first, each with its evidence snapshots. Separate from real wallet holdings and trades.",
  tags: ["paper-trading"],
  security: [{ [bearerAuth.name]: [] }],
  responses: {
    200: { description: "Paper positions", content: { "application/json": { schema: PaperPositionListResponseSchema } } },
    401: errorResponse,
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
