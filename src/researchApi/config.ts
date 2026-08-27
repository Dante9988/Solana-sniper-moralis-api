/**
 * Phase 6 — HTTP API configuration (phase6.txt §5). Fail-closed validated,
 * same discipline as `forensics/thresholds.ts`. All names are additive to
 * `.env`; nothing here is a secret except `API_KEYS`, which is never logged.
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

export interface ApiConfig {
  readonly port: number;
  readonly apiKeys: ReadonlySet<string>;
  readonly publicReads: boolean;
  readonly rateLimitPerMinute: number;
  readonly scanEnqueueLimitPerHour: number;
}

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return Object.freeze({
    port: parsePositiveInt(env, "API_PORT", 8787),
    apiKeys: parseApiKeys(env),
    publicReads: parseStrictBool(env, "API_PUBLIC_READS", false),
    rateLimitPerMinute: parsePositiveInt(env, "PRESENTATION_RATE_LIMIT_PER_MIN", 30),
    scanEnqueueLimitPerHour: parsePositiveInt(env, "SCAN_ENQUEUE_LIMIT_PER_HOUR", 6),
  });
}
