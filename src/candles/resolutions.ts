/**
 * Phase 7B.5B §5/§13 — the chart resolution set, matching the existing
 * frontend contract verbatim (only-pump-me/src/features/token-terminal/
 * contracts/candle.ts's CandleResolution/CANDLE_RESOLUTIONS). Kept as plain
 * string literals here — the Prisma `CandleResolution` enum
 * (S1/S5/S15/M1/M5/M15/H1, not legal starting with a digit) is a storage
 * detail; every other layer of the candle domain, the API, and eventually
 * the frontend use these exact strings.
 */

import { CandleResolution as DbCandleResolution } from "@prisma/client";

export type CandleResolutionId = "1s" | "5s" | "15s" | "1m" | "5m" | "15m" | "1h";

export const CANDLE_RESOLUTIONS: readonly CandleResolutionId[] = ["1s", "5s", "15s", "1m", "5m", "15m", "1h"];

/** Deterministic Unix/UTC bucket width — no local timezone math anywhere in this domain (phase7b5b.txt §5). */
export const RESOLUTION_SECONDS: Readonly<Record<CandleResolutionId, number>> = {
  "1s": 1,
  "5s": 5,
  "15s": 15,
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
};

/** The coarsest supported resolution — used to align a recompute/backfill window's start so every finer bucket boundary within it is also covered (src/candles/recompute.ts). */
export const COARSEST_RESOLUTION_SECONDS = RESOLUTION_SECONDS["1h"];

const ID_TO_DB: Readonly<Record<CandleResolutionId, DbCandleResolution>> = {
  "1s": DbCandleResolution.S1,
  "5s": DbCandleResolution.S5,
  "15s": DbCandleResolution.S15,
  "1m": DbCandleResolution.M1,
  "5m": DbCandleResolution.M5,
  "15m": DbCandleResolution.M15,
  "1h": DbCandleResolution.H1,
};

const DB_TO_ID: Readonly<Record<DbCandleResolution, CandleResolutionId>> = {
  [DbCandleResolution.S1]: "1s",
  [DbCandleResolution.S5]: "5s",
  [DbCandleResolution.S15]: "15s",
  [DbCandleResolution.M1]: "1m",
  [DbCandleResolution.M5]: "5m",
  [DbCandleResolution.M15]: "15m",
  [DbCandleResolution.H1]: "1h",
};

export function resolutionIdToDb(id: CandleResolutionId): DbCandleResolution {
  return ID_TO_DB[id];
}

export function resolutionDbToId(db: DbCandleResolution): CandleResolutionId {
  return DB_TO_ID[db];
}

export function isCandleResolutionId(value: string): value is CandleResolutionId {
  return (CANDLE_RESOLUTIONS as readonly string[]).includes(value);
}

/** Deterministic Unix/UTC bucket boundary (phase7b5b.txt §5): `floor(timestamp / intervalSeconds) * intervalSeconds`. `unixSeconds` must be an integer number of seconds, never a Date or ms value. */
export function bucketStartFor(unixSeconds: number, resolution: CandleResolutionId): number {
  const interval = RESOLUTION_SECONDS[resolution];
  return Math.floor(unixSeconds / interval) * interval;
}
