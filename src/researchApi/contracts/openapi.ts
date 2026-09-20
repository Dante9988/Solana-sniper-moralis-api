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
import { RobinhoodTokenListQuerySchema, DiscoveryChainsResponseSchema,
  RobinhoodTokenAddressParamSchema,
  RobinhoodTokenDetailResponseSchema,
  RobinhoodTokenListResponseSchema,
  RobinhoodStatusResponseSchema,
  TokenHistoryBackfillSchema,
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
import {
  CompareSizesRequestSchema,
  CreatePracticePlanRequestSchema,
  CreatePracticePortfolioRequestSchema,
  CreatePracticeTradeRequestSchema,
  LessonStepRequestSchema,
  PracticeLessonResponseSchema,
  PracticeOverviewResponseSchema,
  PracticePlanResponseSchema,
  PracticePortfolioResponseSchema,
  PracticeTradeResponseSchema,
  ReviewPracticePlanRequestSchema,
} from "./practice";
import { ActiveVanityReservationResponseSchema, ConsumeVanityResponseSchema, ReserveVanityRequestSchema, VanityAvailabilityResponseSchema, VanityChainQuerySchema, VanityReservationResponseSchema } from "./vanity";
import { MarketListQuerySchema, MarketListResponseSchema, MarketSegmentParamSchema } from "./markets";
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
  summary: "Recently discovered Pons/Robinhood Chain tokens, newest first (Phase 7B.4). Phase 7D.4: server-side lifecycle (all, bonding, graduated, almost-bonded, trending) and search filters with a filtered total, sorting by newest, market cap, liquidity, bonding progress or 1h market-cap change, a verified quote asset and the live on-chain market snapshot per row.",
  tags: ["robinhood-chain"],
  security: [{ [bearerAuth.name]: [] }],
  request: { query: RobinhoodTokenListQuerySchema },
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
  method: "post",
  path: "/api/v1/tokens/robinhood/{tokenAddress}/history",
  summary:
    "Phase 7D.5 — fetch this token's trade history on demand. An address-filtered log query the node answers from an index, not the chain-wide indexer scan: measured 2026-09-20, a token with 5.1M blocks of history returned all 9,784 trades in 11 requests. Idempotent, resumable and bounded.",
  tags: ["robinhood-chain"],
  security: [{ [bearerAuth.name]: [] }],
  request: { params: RobinhoodTokenAddressParamSchema },
  responses: {
    200: { description: "Backfill outcome", content: { "application/json": { schema: TokenHistoryBackfillSchema } } },
    400: errorResponse,
    401: errorResponse,
    404: errorResponse,
    429: errorResponse,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/tokens/robinhood/{tokenAddress}/history",
  summary: "Phase 7D.5 — what has been backfilled for this token, including which venues the history does NOT cover.",
  tags: ["robinhood-chain"],
  security: [{ [bearerAuth.name]: [] }],
  request: { params: RobinhoodTokenAddressParamSchema },
  responses: {
    200: { description: "Backfill state", content: { "application/json": { schema: TokenHistoryBackfillSchema } } },
    400: errorResponse,
    401: errorResponse,
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
  path: "/api/v1/discovery/chains",
  summary: "Which chains and launch providers have discovery in this deployment (Phase 7D.4).",
  tags: ["robinhood-chain"],
  security: [{ [bearerAuth.name]: [] }],
  responses: { 200: { description: "Discovery capabilities", content: { "application/json": { schema: DiscoveryChainsResponseSchema } } }, 401: errorResponse },
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

// Phase 7D.4 §5/§6 — Practice (paper money, live market data). Signed-in users only.
const practiceIdem = z.object({ "Idempotency-Key": z.string().regex(/^[A-Za-z0-9_-]{8,128}$/) });
const practiceErrors = {
  400: errorResponse,
  401: errorResponse,
  404: errorResponse,
  409: { description: "INSUFFICIENT_PAPER_BALANCE, INSUFFICIENT_PAPER_HOLDING, NO_PAPER_BALANCE_IN_CURRENCY, QUOTE_EXPIRED, PLAN_MISMATCH, PLAN_NOT_CLOSEABLE or ALREADY_REVIEWED", content: { "application/json": { schema: ErrorEnvelopeSchema } } },
  422: { description: "IDEMPOTENCY_KEY_REUSED", content: { "application/json": { schema: ErrorEnvelopeSchema } } },
};
registry.registerPath({
  method: "get",
  path: "/api/v1/me/practice",
  summary: "The signed-in user's practice portfolios (paper balances, holdings, trades, plans) and intro-lesson progress with achievements. Never a wallet balance.",
  tags: ["practice"],
  security: [{ [bearerAuth.name]: [] }],
  responses: { 200: { description: "Practice overview", content: { "application/json": { schema: PracticeOverviewResponseSchema } } }, 401: errorResponse },
});
registry.registerPath({
  method: "post",
  path: "/api/v1/me/practice/portfolios",
  summary: "Start a practice portfolio with explicit paper balances in verified quote assets. Idempotent per Idempotency-Key.",
  tags: ["practice"],
  security: [{ [bearerAuth.name]: [] }],
  request: { headers: practiceIdem, body: { content: { "application/json": { schema: CreatePracticePortfolioRequestSchema } } } },
  responses: { 200: { description: "Replayed", content: { "application/json": { schema: PracticePortfolioResponseSchema } } }, 201: { description: "Created", content: { "application/json": { schema: PracticePortfolioResponseSchema } } }, ...practiceErrors },
});
registry.registerPath({
  method: "get",
  path: "/api/v1/me/practice/portfolios/{portfolioId}",
  summary: "One of the signed-in user's practice portfolios.",
  tags: ["practice"],
  security: [{ [bearerAuth.name]: [] }],
  request: { params: z.object({ portfolioId: z.string() }) },
  responses: { 200: { description: "Portfolio", content: { "application/json": { schema: PracticePortfolioResponseSchema } } }, 401: errorResponse, 404: errorResponse },
});
registry.registerPath({
  method: "post",
  path: "/api/v1/me/practice/portfolios/{portfolioId}/plans",
  summary: "Record a trade plan: why, how much, and exit notes. Exit notes are never executed automatically.",
  tags: ["practice"],
  security: [{ [bearerAuth.name]: [] }],
  request: { params: z.object({ portfolioId: z.string() }), headers: practiceIdem, body: { content: { "application/json": { schema: CreatePracticePlanRequestSchema } } } },
  responses: { 200: { description: "Replayed", content: { "application/json": { schema: PracticePlanResponseSchema } } }, 201: { description: "Created", content: { "application/json": { schema: PracticePlanResponseSchema } } }, ...practiceErrors },
});
registry.registerPath({
  method: "post",
  path: "/api/v1/me/practice/portfolios/{portfolioId}/trades",
  summary:
    "Place a paper entry or exit from an unexpired quote and, optionally, its successful simulation. Buys need paper cash in the pair's currency; sells need the tokens. The real pool is not changed.",
  tags: ["practice"],
  security: [{ [bearerAuth.name]: [] }],
  request: { params: z.object({ portfolioId: z.string() }), headers: practiceIdem, body: { content: { "application/json": { schema: CreatePracticeTradeRequestSchema } } } },
  responses: { 200: { description: "Replayed", content: { "application/json": { schema: PracticeTradeResponseSchema } } }, 201: { description: "Filled on paper", content: { "application/json": { schema: PracticeTradeResponseSchema } } }, ...practiceErrors },
});
registry.registerPath({
  method: "post",
  path: "/api/v1/me/practice/plans/{planId}/review",
  summary: "Review a plan after its practice entry and exit.",
  tags: ["practice"],
  security: [{ [bearerAuth.name]: [] }],
  request: { params: z.object({ planId: z.string() }), body: { content: { "application/json": { schema: ReviewPracticePlanRequestSchema } } } },
  responses: { 201: { description: "Reviewed", content: { "application/json": { schema: PracticeLessonResponseSchema } } }, ...practiceErrors },
});
registry.registerPath({
  method: "get",
  path: "/api/v1/me/practice/lesson",
  summary: "Intro lesson progress, derived from what the user has actually done, and learning achievements.",
  tags: ["practice"],
  security: [{ [bearerAuth.name]: [] }],
  responses: { 200: { description: "Lesson", content: { "application/json": { schema: PracticeLessonResponseSchema } } }, 401: errorResponse },
});
registry.registerPath({
  method: "post",
  path: "/api/v1/me/practice/lesson/compare-sizes",
  summary: "Record a comparison of two quotes for the same token and side at different sizes.",
  tags: ["practice"],
  security: [{ [bearerAuth.name]: [] }],
  request: { body: { content: { "application/json": { schema: CompareSizesRequestSchema } } } },
  responses: { 200: { description: "Lesson", content: { "application/json": { schema: PracticeLessonResponseSchema } } }, 400: errorResponse, 401: errorResponse, 404: errorResponse },
});
registry.registerPath({
  method: "post",
  path: "/api/v1/me/practice/lesson/steps",
  summary: "Mark a reading step (preview-costs, track) as done. Other steps complete by doing them.",
  tags: ["practice"],
  security: [{ [bearerAuth.name]: [] }],
  request: { body: { content: { "application/json": { schema: LessonStepRequestSchema } } } },
  responses: { 200: { description: "Lesson", content: { "application/json": { schema: PracticeLessonResponseSchema } } }, 400: errorResponse, 401: errorResponse },
});

// Phase 7D.4 §7 — vanity address handoff. Reservation is not deployment; nothing here broadcasts.
const vanityErrors = { 400: errorResponse, 401: errorResponse, 404: errorResponse, 409: errorResponse };
registry.registerPath({
  method: "get",
  path: "/api/v1/vanity/availability",
  summary: "How many vanity mint addresses can be reserved on a chain, or why the chain has none.",
  tags: ["vanity"],
  request: { query: VanityChainQuerySchema },
  responses: { 200: { description: "Availability", content: { "application/json": { schema: VanityAvailabilityResponseSchema } } }, 400: errorResponse },
});
registry.registerPath({
  method: "get",
  path: "/api/v1/me/vanity/reservation",
  summary: "The caller's live (or consumed) reservation on a chain, if any.",
  tags: ["vanity"],
  security: [{ [bearerAuth.name]: [] }],
  request: { query: VanityChainQuerySchema },
  responses: { 200: { description: "Reservation or null", content: { "application/json": { schema: ActiveVanityReservationResponseSchema } } }, 401: errorResponse },
});
registry.registerPath({
  method: "post",
  path: "/api/v1/me/vanity/reservations",
  summary: "Reserve a vanity mint address for 15 minutes. Idempotent on the Idempotency-Key header; one live reservation per user.",
  tags: ["vanity"],
  security: [{ [bearerAuth.name]: [] }],
  request: { headers: z.object({ "idempotency-key": z.string() }), body: { content: { "application/json": { schema: ReserveVanityRequestSchema } } } },
  responses: { 200: { description: "Existing reservation", content: { "application/json": { schema: VanityReservationResponseSchema } } }, 201: { description: "Reserved", content: { "application/json": { schema: VanityReservationResponseSchema } } }, ...vanityErrors },
});
registry.registerPath({
  method: "delete",
  path: "/api/v1/me/vanity/reservations/{reservationId}",
  summary: "Release a reservation back to stock. A consumed address cannot be released.",
  tags: ["vanity"],
  security: [{ [bearerAuth.name]: [] }],
  request: { params: z.object({ reservationId: z.string() }) },
  responses: { 204: { description: "Released" }, ...vanityErrors },
});
registry.registerPath({
  method: "post",
  path: "/api/v1/internal/vanity/reservations/{reservationId}/consume",
  summary: "Internal launch service only: mark a reserved address as taken. Idempotent. Signs and broadcasts nothing.",
  tags: ["vanity"],
  security: [{ [bearerAuth.name]: [] }],
  request: { headers: z.object({ "idempotency-key": z.string() }), params: z.object({ reservationId: z.string() }) },
  responses: { 200: { description: "Replayed", content: { "application/json": { schema: ConsumeVanityResponseSchema } } }, 201: { description: "Consumed", content: { "application/json": { schema: ConsumeVanityResponseSchema } } }, ...vanityErrors },
});

// Phase 7D.4 — ranked market lists from CoinGecko.
registry.registerPath({
  method: "get",
  path: "/api/v1/markets/{segment}",
  summary: "Crypto ranked by market cap, or Robinhood Chain stock tokens, from CoinGecko (cached one minute; stale lists are flagged).",
  tags: ["markets"],
  request: { params: MarketSegmentParamSchema, query: MarketListQuerySchema },
  responses: { 200: { description: "Market list", content: { "application/json": { schema: MarketListResponseSchema } } }, 400: errorResponse },
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
