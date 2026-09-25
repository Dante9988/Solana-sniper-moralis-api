/**
 * Phase 7D.5 — ingestion modes and the local observation session.
 *
 * Local development does not want a historical backlog. Starting the stack should mean
 * "watch what the chain is doing now", and everything the product shows should be honest
 * about having only started watching a moment ago.
 *
 * Two modes:
 *
 * - **`resume`** (default): the behaviour every earlier phase had. Durable
 *   `ChainIngestionCheckpoint` rows are read and advanced, so a restart continues exactly
 *   where it stopped. This is what hosted environments keep using, and nothing about it
 *   changes here.
 *
 * - **`live-head`**: the stack agrees on one boundary — the current chain head — and every
 *   worker ingests forward from it. Checkpoints are written under a session-prefixed
 *   `source`, so the durable rows are neither read nor overwritten. No historical range is
 *   ever marked processed; it is simply not consulted.
 *
 * The boundary is shared, not per-worker. A worker that restarts mid-session rejoins the
 * existing session rather than cutting a new boundary — otherwise every reconnect would
 * silently create a gap. Only a deliberate full-stack start opens a new session.
 */

import type { PrismaClient } from "@prisma/client";

import type { ChainReader } from "./chainClient";

export type IngestionMode = "live-head" | "resume";

export const DEFAULT_INGESTION_MODE: IngestionMode = "resume";

export class IngestionModeError extends Error {}

/**
 * `PONS_INGESTION_MODE`, defaulting to `resume` so an unset environment — production
 * included — behaves exactly as it did before this phase.
 */
export function loadIngestionMode(env: NodeJS.ProcessEnv = process.env): IngestionMode {
  const raw = env.PONS_INGESTION_MODE?.trim().toLowerCase();
  if (raw === undefined || raw === "") return DEFAULT_INGESTION_MODE;
  if (raw === "live-head" || raw === "live_head" || raw === "livehead") return "live-head";
  if (raw === "resume") return "resume";
  throw new IngestionModeError(`PONS_INGESTION_MODE must be "live-head" or "resume", got ${JSON.stringify(raw)}`);
}

export interface IngestionSessionRecord {
  readonly id: string;
  readonly chain: string;
  readonly mode: string;
  /** The last block deliberately NOT processed. Ingestion starts at `startBlock + 1`. */
  readonly startBlock: bigint;
  readonly startHash: string;
  readonly startTimestamp: Date;
  readonly createdAt: Date;
}

/**
 * Where this source's checkpoint lives.
 *
 * In `resume` mode, the durable row. In `live-head`, a session-scoped row, which is the
 * single mechanism that keeps a local session from touching durable history.
 */
export function checkpointSourceFor(base: string, session: IngestionSessionRecord | null): string {
  return session === null ? base : `session:${session.id}:${base}`;
}

/** The block a session-scoped stream starts at: the first block after the boundary. */
export function sessionStartHeight(session: IngestionSessionRecord): bigint {
  return session.startBlock + 1n;
}

export async function findActiveSession(db: PrismaClient, chain: string): Promise<IngestionSessionRecord | null> {
  const row = await db.ingestionSession.findFirst({
    where: { chain, endedAt: null },
    orderBy: { createdAt: "desc" },
  });
  return row ?? null;
}

/**
 * Open a new session at the current chain head, ending any previous one.
 *
 * Called by the stack launcher, not by individual workers — see `resolveSession`.
 */
export async function openSession(
  db: PrismaClient,
  reader: ChainReader,
  chain: string
): Promise<IngestionSessionRecord> {
  const head = await reader.getBlockNumber();
  if (head.status === "UNAVAILABLE") {
    throw new IngestionModeError(`cannot open a live-head session: chain head unavailable (${head.reason})`);
  }
  const ref = await reader.getBlockRef(head.data);
  if (ref.status === "UNAVAILABLE") {
    throw new IngestionModeError(`cannot open a live-head session: block ${head.data} unavailable (${ref.reason})`);
  }

  // Ending the previous session first means `findActiveSession` can never see two.
  await db.ingestionSession.updateMany({ where: { chain, endedAt: null }, data: { endedAt: new Date() } });

  const created = await db.ingestionSession.create({
    data: {
      chain,
      mode: "live-head",
      startBlock: head.data,
      startHash: ref.data.hash,
      // The chain's own time for that block. Coverage windows are measured against this,
      // never against wall clock, so a slow local clock cannot widen apparent coverage.
      startTimestamp: new Date(Number(ref.data.timestamp) * 1000),
    },
  });
  return created;
}

/**
 * What a worker should use at startup.
 *
 * `resume` → no session. `live-head` → the active session, joined not created: a worker
 * restarting mid-session must land on the same boundary as its siblings. If none exists
 * (the launcher was skipped), one is opened so a bare `npm run pons:worker` still works.
 */
export async function resolveSession(
  db: PrismaClient,
  reader: ChainReader,
  chain: string,
  mode: IngestionMode
): Promise<IngestionSessionRecord | null> {
  if (mode === "resume") return null;
  const existing = await findActiveSession(db, chain);
  if (existing) return existing;
  return openSession(db, reader, chain);
}

/** One-line description for logs and the health projection. */
export function describeSession(mode: IngestionMode, session: IngestionSessionRecord | null): string {
  if (mode === "resume" || session === null) return "mode=resume (durable checkpoints)";
  return `mode=live-head session=${session.id} boundary=${session.startBlock} (${session.startHash.slice(0, 10)}…) at ${session.startTimestamp.toISOString()}`;
}

/**
 * The checkpoint namespace the *readers* should use — health, coverage and candle finality.
 *
 * These run in the API and candle processes, which do not own a session but must report
 * against the one that is live. Reading a durable `robinhood:*` row in `live-head` mode
 * would publish a lag measured against an abandoned historical checkpoint: on 2026-09-20
 * the durable V2 rows were 1.3M blocks behind while the session was at the tip, so the
 * status endpoint would have called a healthy stack badly degraded.
 *
 * Cached briefly because it is consulted per request; a new session becomes visible within
 * `ttlMs`, which is far shorter than any human-visible refresh.
 */
let cachedPrefix: { at: number; prefix: string } | null = null;

export function resetSessionPrefixCache(): void {
  cachedPrefix = null;
}

export async function currentSessionPrefix(
  db: PrismaClient,
  chain: string,
  options: { ttlMs?: number; now?: () => number; mode?: IngestionMode } = {}
): Promise<string> {
  const mode = options.mode ?? loadIngestionMode();
  if (mode !== "live-head") return "";
  const now = (options.now ?? Date.now)();
  const ttlMs = options.ttlMs ?? 5_000;
  if (cachedPrefix && now - cachedPrefix.at < ttlMs) return cachedPrefix.prefix;
  const session = await findActiveSession(db, chain);
  const prefix = session ? `session:${session.id}:` : "";
  cachedPrefix = { at: now, prefix };
  return prefix;
}
