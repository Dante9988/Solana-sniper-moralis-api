/**
 * Phase 5D — durable worker configuration (phase5d.txt §11). Fail-closed
 * validated, same discipline as `thresholds.ts`/`forensicsConfig.ts`.
 * Defaults: worker disabled, concurrency 1, DEEP analysis disabled
 * (DEEP_FORENSICS_ENABLED is Phase 5A/thresholds.ts's existing flag).
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

function parseStrictBool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new ForensicsConfigError(`${name} must be exactly "true" or "false", got ${JSON.stringify(raw)}`);
}

export interface ForensicsWorkerConfig {
  readonly enabled: boolean;
  readonly concurrency: number;
  readonly pollMs: number;
  readonly leaseMs: number;
  readonly heartbeatMs: number;
  readonly maxAttempts: number;
  readonly baseBackoffMs: number;
}

export function loadForensicsWorkerConfig(env: NodeJS.ProcessEnv = process.env): ForensicsWorkerConfig {
  const leaseMs = parsePositiveInt(env, "FORENSICS_JOB_LEASE_MS", 120_000);
  const heartbeatMs = parsePositiveInt(env, "FORENSICS_JOB_HEARTBEAT_MS", 30_000);
  if (heartbeatMs >= leaseMs) {
    throw new ForensicsConfigError(
      `FORENSICS_JOB_HEARTBEAT_MS (${heartbeatMs}) must be shorter than FORENSICS_JOB_LEASE_MS (${leaseMs})`
    );
  }
  return Object.freeze({
    enabled: parseStrictBool(env, "FORENSICS_WORKER_ENABLED", false),
    concurrency: parsePositiveInt(env, "FORENSICS_WORKER_CONCURRENCY", 1),
    pollMs: parsePositiveInt(env, "FORENSICS_JOB_POLL_MS", 5_000),
    leaseMs,
    heartbeatMs,
    maxAttempts: parsePositiveInt(env, "FORENSICS_JOB_MAX_ATTEMPTS", 5),
    baseBackoffMs: parsePositiveInt(env, "FORENSICS_JOB_BASE_BACKOFF_MS", 5_000),
  });
}
