/**
 * Phase 7B.5B §8/§15 — candle worker/health configuration. Same fail-closed
 * loader discipline as src/pons/config.ts; deliberately independent of it
 * (this module has no dependency on Pons/RPC settings) so a read-only API
 * process can serve `candleHealth.ts`'s projection without needing the
 * settings only the worker process requires — same reasoning as
 * `loadPonsHealthThresholds` in src/pons/config.ts.
 */

export class CandleConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CandleConfigError";
  }
}

function parsePositiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) throw new CandleConfigError(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new CandleConfigError(`${name} must be a positive safe integer, got ${trimmed}`);
  return parsed;
}

export interface CandleWorkerConfig {
  readonly pollIntervalMs: number;
  readonly maxInvalidationTokensPerTick: number;
  readonly maxForwardTokensPerTick: number;
  readonly tradePageCap: number;
  readonly healthStaleMs: number;
  readonly healthErrorWindowMs: number;
  readonly healthLaggingMs: number;
}

export function loadCandleWorkerConfig(env: NodeJS.ProcessEnv = process.env): CandleWorkerConfig {
  return Object.freeze({
    pollIntervalMs: parsePositiveInt(env, "CANDLES_POLL_INTERVAL_MS", 5_000),
    maxInvalidationTokensPerTick: parsePositiveInt(env, "CANDLES_MAX_INVALIDATION_TOKENS_PER_TICK", 25),
    maxForwardTokensPerTick: parsePositiveInt(env, "CANDLES_MAX_FORWARD_TOKENS_PER_TICK", 100),
    tradePageCap: parsePositiveInt(env, "CANDLES_TRADE_PAGE_CAP", 5_000),
    healthStaleMs: parsePositiveInt(env, "CANDLES_HEALTH_STALE_MS", 120_000),
    healthErrorWindowMs: parsePositiveInt(env, "CANDLES_HEALTH_ERROR_WINDOW_MS", 60_000),
    healthLaggingMs: parsePositiveInt(env, "CANDLES_HEALTH_LAGGING_MS", 30_000),
  });
}

export type CandleHealthThresholds = Pick<CandleWorkerConfig, "healthStaleMs" | "healthErrorWindowMs" | "healthLaggingMs">;

export function loadCandleHealthThresholds(env: NodeJS.ProcessEnv = process.env): CandleHealthThresholds {
  return Object.freeze({
    healthStaleMs: parsePositiveInt(env, "CANDLES_HEALTH_STALE_MS", 120_000),
    healthErrorWindowMs: parsePositiveInt(env, "CANDLES_HEALTH_ERROR_WINDOW_MS", 60_000),
    healthLaggingMs: parsePositiveInt(env, "CANDLES_HEALTH_LAGGING_MS", 30_000),
  });
}
