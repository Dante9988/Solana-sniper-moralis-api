/**
 * Phase 5E — intelligence-integration feature flags (phase5e.txt §3).
 * Fail-closed validated, same discipline as every other config module here.
 * All three default to disabled; enabling any of them never starts live
 * Helius/RPC work by itself — only the standalone worker
 * (FORENSICS_WORKER_ENABLED) ever runs the expensive analyzer.
 */

import { ForensicsConfigError } from "./thresholds";

function parseStrictBool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new ForensicsConfigError(`${name} must be exactly "true" or "false", got ${JSON.stringify(raw)}`);
}

export function isForensicsEnqueueEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseStrictBool(env, "FORENSICS_ENQUEUE_ENABLED", false);
}

export function isForensicsReconciliationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseStrictBool(env, "FORENSICS_RECONCILIATION_ENABLED", false);
}

export function isForensicsAiResynthesisEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseStrictBool(env, "FORENSICS_AI_RESYNTHESIS_ENABLED", false);
}
