/**
 * Phase X — X (Twitter) API capability-checkpoint configuration.
 *
 * Read-only capability checkpoint only. This module never starts streaming,
 * never mutates stream rules, and has zero import-time side effects (no
 * network, no timers, no client construction) — it only parses
 * `process.env` when a caller explicitly calls `loadXConfig()`. Fails closed
 * on any malformed or unknown configuration value; never silently falls back
 * to an unsafe default or leaves streaming ambiguously enabled.
 */

export class XConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XConfigError";
  }
}

const DEFAULT_BASE_URL = "https://api.x.com/2";
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;

function parseStrictBool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new XConfigError(`${name} must be exactly "true" or "false", got ${JSON.stringify(raw)}`);
}

function parseHttpsUrl(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = env[name];
  const candidate = raw === undefined || raw.trim() === "" ? fallback : raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new XConfigError(`${name} must be a valid URL, got ${JSON.stringify(candidate)}`);
  }
  if (parsed.protocol !== "https:") {
    throw new XConfigError(`${name} must use https, got ${JSON.stringify(candidate)}`);
  }
  // Strip any trailing slash so path construction never risks a double slash.
  return candidate.replace(/\/+$/, "");
}

function parsePositiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new XConfigError(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new XConfigError(`${name} must be a positive safe integer, got ${trimmed}`);
  }
  return parsed;
}

export interface XConfig {
  readonly baseUrl: string;
  readonly streamEnabled: boolean;
  readonly requestTimeoutMs: number;
  /**
   * Present only when `X_BEARER_TOKEN` is a non-empty value in the provided
   * env. Never logged, printed, hashed, or included in any error/result —
   * callers must only ever use it as a request header value.
   */
  readonly bearerToken: string | undefined;
}

/**
 * Absence of `X_BEARER_TOKEN` is NOT a configuration error here — this
 * checkpoint's config may load in contexts (tests, future checks) that never
 * need the token. `xApiClient.ts` reports a distinct `NOT_CONFIGURED` result
 * when a caller actually attempts a request without one (phaseX.txt: "token
 * is present only when the explicit smoke command runs").
 */
export function loadXConfig(env: NodeJS.ProcessEnv = process.env): XConfig {
  const baseUrl = parseHttpsUrl(env, "X_API_BASE_URL", DEFAULT_BASE_URL);
  const streamEnabled = parseStrictBool(env, "X_STREAM_ENABLED", false);
  const requestTimeoutMs = parsePositiveInt(env, "X_REQUEST_TIMEOUT_MS", DEFAULT_REQUEST_TIMEOUT_MS);
  const rawToken = env.X_BEARER_TOKEN;
  const bearerToken = rawToken !== undefined && rawToken.trim() !== "" ? rawToken : undefined;
  return Object.freeze({ baseUrl, streamEnabled, requestTimeoutMs, bearerToken });
}
