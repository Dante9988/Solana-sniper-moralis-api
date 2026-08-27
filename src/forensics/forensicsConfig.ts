/**
 * Phase 5B client runtime configuration. Separate from `thresholds.ts`
 * (analysis policy) — this module governs HTTP/RPC mechanics only: timeouts,
 * deadlines, response-size limits, and retry bounds. Fails closed on invalid
 * input, same as `thresholds.ts`.
 */

import { ForensicsConfigError } from "./thresholds";

function parsePositiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new ForensicsConfigError(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ForensicsConfigError(`${name} must be a positive safe integer, got ${trimmed}`);
  }
  return parsed;
}

export interface ForensicsClientRuntimeConfig {
  readonly requestTimeoutMs: number;
  readonly totalDeadlineMs: number;
  readonly maxResponseBytes: number;
  readonly maxRetries: number;
  readonly baseRetryDelayMs: number;
  readonly maxRetryDelayMs: number;
}

export function loadForensicsClientRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env
): ForensicsClientRuntimeConfig {
  return Object.freeze({
    requestTimeoutMs: parsePositiveInt(env, "FORENSICS_REQUEST_TIMEOUT_MS", 8_000),
    totalDeadlineMs: parsePositiveInt(env, "FORENSICS_TOTAL_DEADLINE_MS", 15_000),
    maxResponseBytes: parsePositiveInt(env, "FORENSICS_MAX_RESPONSE_BYTES", 2 * 1024 * 1024),
    maxRetries: parsePositiveInt(env, "FORENSICS_MAX_RETRIES", 3),
    baseRetryDelayMs: parsePositiveInt(env, "FORENSICS_BASE_RETRY_DELAY_MS", 200),
    maxRetryDelayMs: parsePositiveInt(env, "FORENSICS_MAX_RETRY_DELAY_MS", 4_000),
  });
}

/** Eagerly resolved at module load from real `process.env`; fails closed on invalid configuration. */
export const RESOLVED_FORENSICS_CLIENT_CONFIG = loadForensicsClientRuntimeConfig();

/**
 * Resolves the Helius RPC URL. The returned string embeds the API key in its
 * query string (this project's existing `HELIUS_HTTPS_URI` convention) and
 * exists ONLY to be used internally when constructing an outbound request.
 * Callers must never log, persist, echo, or include this value in any
 * client result, error, evidence record, or configuration snapshot.
 */
export function resolveHeliusRpcUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.HELIUS_HTTPS_URI;
  if (!raw || raw.trim() === "") return undefined;
  return raw;
}
