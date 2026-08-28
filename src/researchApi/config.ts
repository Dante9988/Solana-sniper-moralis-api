/**
 * Phase 6/7B.1 — HTTP API configuration (phase6.txt §5, phase7b1.txt §4-9).
 * Fail-closed validated, same discipline as `forensics/thresholds.ts`. All
 * names are additive to `.env`; nothing here is a secret except `API_KEYS`
 * and `SUPABASE_JWT_SECRET`, neither of which is ever logged.
 */

export class ApiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiConfigError";
  }
}

function parsePositiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) throw new ApiConfigError(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ApiConfigError(`${name} must be a positive safe integer, got ${trimmed}`);
  }
  return parsed;
}

function parseStrictBool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new ApiConfigError(`${name} must be exactly "true" or "false", got ${JSON.stringify(raw)}`);
}

function parseApiKeys(env: NodeJS.ProcessEnv): ReadonlySet<string> {
  const raw = env.API_KEYS;
  if (raw === undefined || raw.trim() === "") return new Set();
  return new Set(
    raw
      .split(",")
      .map((key) => key.trim())
      .filter((key) => key.length > 0)
  );
}

function parseOriginList(raw: string | undefined): ReadonlySet<string> {
  if (raw === undefined || raw.trim() === "") return new Set();
  return new Set(
    raw
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0)
  );
}

export interface SupabaseAuthConfig {
  /** e.g. https://<project-ref>.supabase.co — no trailing slash. */
  readonly projectUrl: string;
  /** The `iss` claim Supabase issues: `${projectUrl}/auth/v1`. */
  readonly issuer: string;
  /** Supabase's well-known JWKS endpoint, for the modern ES256/RS256 signing keys. */
  readonly jwksUrl: string;
  /** Legacy shared HS256 secret (Supabase project Settings -> API -> JWT Settings), optional. */
  readonly hsSecret?: string;
  /** Expected `aud` claim, e.g. "authenticated". Only checked when set. */
  readonly audience?: string;
}

export interface CorsConfig {
  /** Explicit production/staging origin allowlist — never a wildcard. */
  readonly allowedOrigins: ReadonlySet<string>;
  /** Additional localhost/dev origins, only ever honored outside production. */
  readonly devOrigins: ReadonlySet<string>;
  readonly isProduction: boolean;
}

export type RateLimitBackend = "memory" | "redis";

export interface RateLimitConfig {
  readonly backend: RateLimitBackend;
  readonly redisUrl?: string;
}

export type RealtimeBackend = "memory" | "redis";

export interface RealtimeConfig {
  /** Backs both the event bus (job lifecycle pub/sub) and the WebSocket ticket store — both need to work across API/worker processes, so they share one backend choice. */
  readonly backend: RealtimeBackend;
  readonly redisUrl?: string;
  readonly ticketTtlMs: number;
  readonly maxMessageBytes: number;
  readonly maxSubscriptionsPerConnection: number;
  readonly maxConnectionsPerUser: number;
  readonly idleTimeoutMs: number;
}

export interface ApiConfig {
  readonly port: number;
  readonly apiKeys: ReadonlySet<string>;
  readonly publicReads: boolean;
  readonly rateLimitPerMinute: number;
  readonly scanEnqueueLimitPerHour: number;
  readonly supabase: SupabaseAuthConfig | null;
  readonly cors: CorsConfig;
  readonly rateLimit: RateLimitConfig;
  readonly realtime: RealtimeConfig;
}

const DEFAULT_DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:19006", "http://localhost:8081"];

function loadSupabaseConfig(env: NodeJS.ProcessEnv): SupabaseAuthConfig | null {
  const projectUrlRaw = env.SUPABASE_URL?.trim();
  if (!projectUrlRaw) return null; // Supabase auth is an opt-in feature: unset -> not configured, see requireSupabaseUser().

  const projectUrl = projectUrlRaw.replace(/\/+$/, "");
  try {
    // eslint-disable-next-line no-new
    new URL(projectUrl);
  } catch {
    throw new ApiConfigError(`SUPABASE_URL must be a valid URL, got ${JSON.stringify(projectUrlRaw)}`);
  }

  const hsSecret = env.SUPABASE_JWT_SECRET?.trim() || undefined;
  const audience = env.SUPABASE_JWT_AUDIENCE?.trim() || undefined;

  return Object.freeze({
    projectUrl,
    issuer: `${projectUrl}/auth/v1`,
    jwksUrl: `${projectUrl}/auth/v1/.well-known/jwks.json`,
    hsSecret,
    audience,
  });
}

function loadCorsConfig(env: NodeJS.ProcessEnv): CorsConfig {
  const isProduction = env.NODE_ENV === "production";
  const allowedOrigins = parseOriginList(env.CORS_ALLOWED_ORIGINS);
  for (const origin of allowedOrigins) {
    if (origin === "*") {
      throw new ApiConfigError("CORS_ALLOWED_ORIGINS must not contain \"*\" — an explicit allowlist is required (phase7b1.txt §8).");
    }
  }

  // Dev origins are only ever consulted outside production (see corsMiddleware) —
  // computing the set here is just where the config lives, not a hole in prod.
  const explicitDevOrigins = env.CORS_DEV_ORIGINS?.trim();
  const devOrigins =
    explicitDevOrigins !== undefined && explicitDevOrigins !== ""
      ? parseOriginList(explicitDevOrigins)
      : new Set(DEFAULT_DEV_ORIGINS);

  return Object.freeze({ allowedOrigins, devOrigins, isProduction });
}

function loadRateLimitConfig(env: NodeJS.ProcessEnv): RateLimitConfig {
  const isProduction = env.NODE_ENV === "production";
  const raw = env.RATE_LIMIT_BACKEND?.trim().toLowerCase();

  if (isProduction && !raw) {
    // Fail closed rather than silently pretending an in-memory limiter is
    // distributed (phase7b1.txt §9) — production must say so explicitly.
    throw new ApiConfigError(
      'RATE_LIMIT_BACKEND must be explicitly set to "memory" or "redis" in production (NODE_ENV=production) — refusing to silently default to an in-memory limiter that will not be shared across instances.'
    );
  }

  const backend: RateLimitBackend = raw === "redis" ? "redis" : "memory";
  if (raw !== undefined && raw !== "memory" && raw !== "redis") {
    throw new ApiConfigError(`RATE_LIMIT_BACKEND must be "memory" or "redis", got ${JSON.stringify(env.RATE_LIMIT_BACKEND)}`);
  }

  const redisUrl = env.REDIS_URL?.trim() || undefined;
  if (backend === "redis" && !redisUrl) {
    throw new ApiConfigError('RATE_LIMIT_BACKEND=redis requires REDIS_URL to be set — refusing to start without it.');
  }

  return Object.freeze({ backend, redisUrl });
}

function loadRealtimeConfig(env: NodeJS.ProcessEnv): RealtimeConfig {
  const isProduction = env.NODE_ENV === "production";
  const raw = env.REALTIME_BACKEND?.trim().toLowerCase();

  if (isProduction && !raw) {
    // Same fail-closed rule as RATE_LIMIT_BACKEND (phase7b1.txt §9,
    // phase7b2.txt §6) — an in-memory event bus/ticket store only works
    // within one process; production must say so explicitly rather than
    // silently losing events/tickets across instances.
    throw new ApiConfigError(
      'REALTIME_BACKEND must be explicitly set to "memory" or "redis" in production (NODE_ENV=production) — the event bus and WebSocket ticket store both need to work across processes, which an in-memory default cannot do.'
    );
  }

  const backend: RealtimeBackend = raw === "redis" ? "redis" : "memory";
  if (raw !== undefined && raw !== "memory" && raw !== "redis") {
    throw new ApiConfigError(`REALTIME_BACKEND must be "memory" or "redis", got ${JSON.stringify(env.REALTIME_BACKEND)}`);
  }

  const redisUrl = env.REDIS_URL?.trim() || undefined;
  if (backend === "redis" && !redisUrl) {
    throw new ApiConfigError("REALTIME_BACKEND=redis requires REDIS_URL to be set — refusing to start without it.");
  }

  return Object.freeze({
    backend,
    redisUrl,
    ticketTtlMs: parsePositiveInt(env, "WS_TICKET_TTL_MS", 45_000),
    maxMessageBytes: parsePositiveInt(env, "WS_MAX_MESSAGE_BYTES", 8_192),
    maxSubscriptionsPerConnection: parsePositiveInt(env, "WS_MAX_SUBSCRIPTIONS_PER_CONNECTION", 20),
    maxConnectionsPerUser: parsePositiveInt(env, "WS_MAX_CONNECTIONS_PER_USER", 5),
    idleTimeoutMs: parsePositiveInt(env, "WS_IDLE_TIMEOUT_MS", 60_000),
  });
}

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return Object.freeze({
    port: parsePositiveInt(env, "API_PORT", 8787),
    apiKeys: parseApiKeys(env),
    publicReads: parseStrictBool(env, "API_PUBLIC_READS", false),
    rateLimitPerMinute: parsePositiveInt(env, "PRESENTATION_RATE_LIMIT_PER_MIN", 30),
    scanEnqueueLimitPerHour: parsePositiveInt(env, "SCAN_ENQUEUE_LIMIT_PER_HOUR", 6),
    supabase: loadSupabaseConfig(env),
    cors: loadCorsConfig(env),
    rateLimit: loadRateLimitConfig(env),
    realtime: loadRealtimeConfig(env),
  });
}
