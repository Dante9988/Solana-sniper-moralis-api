/**
 * Phase 7D.3.2 §6 — asynchronous token logo cache, served from OnlyPump's own origin.
 *
 * Flow: a token read enqueues a PENDING row for its logo URL (never blocking the read) → a
 * background worker claims rows, fetches them safely, keeps only verified image bytes →
 * GET /api/v1/media/token-logos/robinhood/:token serves them with strict headers.
 *
 * A missing, slow, broken or hostile logo can therefore never block discovery or opening a
 * token: the API answers immediately, the UI shows a placeholder until the logo is READY.
 */

import { createHash } from "node:crypto";

import type { PrismaClient, TokenImageCache } from "@prisma/client";

import { planImageFetch, sniffImage } from "./imageSafety";
import { ImageFetchError, fetchImageBytes } from "./safeImageFetch";

export type ImageStatus = "NONE" | "PENDING" | "READY" | "FAILED" | "REJECTED";

export const DEFAULT_IPFS_GATEWAYS = ["https://ipfs.io/ipfs/", "https://dweb.link/ipfs/"] as const;

const MAX_ATTEMPTS = 6;
const CLAIM_LEASE_MS = 60_000;

export function ipfsGateways(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.TOKEN_IMAGE_IPFS_GATEWAYS;
  const list = raw && raw.trim() ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [...DEFAULT_IPFS_GATEWAYS];
  return list.filter((g) => g.startsWith("https://")).map((g) => (g.endsWith("/") ? g : `${g}/`));
}

export function retryDelayMs(attempts: number): number {
  return Math.min(6 * 60 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
}

/** Idempotent; safe to call on every read. Rows are keyed by the exact source URL. */
export async function enqueueTokenLogos(db: PrismaClient, tokens: { tokenAddress: string; logoUrl: string | null }[]): Promise<void> {
  const data = tokens
    .filter((t) => t.logoUrl)
    .map((t) => {
      const plan = planImageFetch(t.logoUrl);
      return {
        chain: "robinhood",
        tokenAddress: t.tokenAddress.toLowerCase(),
        sourceUrl: t.logoUrl!,
        status: plan.kind === "rejected" ? "REJECTED" : "PENDING",
        lastError: plan.kind === "rejected" ? plan.reason : null,
      };
    });
  if (data.length === 0) return;
  await db.tokenImageCache.createMany({ data, skipDuplicates: true });
}

export async function logoStatuses(db: PrismaClient, tokens: { tokenAddress: string; logoUrl: string | null }[]): Promise<Map<string, ImageStatus>> {
  const withLogo = tokens.filter((t) => t.logoUrl);
  const rows = withLogo.length
    ? await db.tokenImageCache.findMany({
        where: { chain: "robinhood", OR: withLogo.map((t) => ({ tokenAddress: t.tokenAddress.toLowerCase(), sourceUrl: t.logoUrl! })) },
        select: { tokenAddress: true, sourceUrl: true, status: true },
      })
    : [];
  const byKey = new Map(rows.map((r) => [`${r.tokenAddress}|${r.sourceUrl}`, r.status as ImageStatus]));
  return new Map(tokens.map((t) => [t.tokenAddress.toLowerCase(), t.logoUrl ? (byKey.get(`${t.tokenAddress.toLowerCase()}|${t.logoUrl}`) ?? "PENDING") : "NONE"]));
}

export function logoUrlFor(tokenAddress: string): string {
  return `/api/v1/media/token-logos/robinhood/${tokenAddress.toLowerCase()}`;
}

export interface ImageFetcher {
  (url: string): Promise<Uint8Array>;
}

async function obtain(row: TokenImageCache, fetcher: ImageFetcher, gateways: string[]): Promise<{ bytes: Uint8Array; contentType: string }> {
  const plan = planImageFetch(row.sourceUrl);
  if (plan.kind === "rejected") throw new ImageFetchError(plan.reason, true);
  const candidates = plan.kind === "ipfs" ? gateways.map((g) => `${g}${plan.path}`) : [plan.url];

  let lastError: ImageFetchError | null = null;
  for (const url of candidates) {
    try {
      const bytes = await fetcher(url);
      const contentType = sniffImage(bytes);
      if (!contentType) throw new ImageFetchError("content is not a PNG, JPEG, GIF or WebP image", true);
      return { bytes, contentType };
    } catch (error) {
      lastError = error instanceof ImageFetchError ? error : new ImageFetchError((error as Error).message, false);
      // Bad content is bad from every gateway; a network error is worth trying the next one.
      if (lastError.permanent && plan.kind === "https") break;
      if (lastError.message.startsWith("content is not")) break;
    }
  }
  if (lastError && plan.kind === "ipfs" && !lastError.message.startsWith("content is not")) {
    // A gateway 404 for a CID usually means "not propagated yet", not "never" — retry later.
    throw new ImageFetchError(lastError.message, false);
  }
  throw lastError ?? new ImageFetchError("no gateway configured", false);
}

/**
 * Claim and process up to `limit` due rows. Claiming bumps `attempts` and sets a lease with
 * a conditional update, so several API processes never fetch the same logo at once.
 */
export async function processDueImages(
  db: PrismaClient,
  options: { limit?: number; now?: () => Date; fetcher?: ImageFetcher; gateways?: string[] } = {}
): Promise<{ claimed: number; ready: number; failed: number; rejected: number }> {
  const now = options.now ?? (() => new Date());
  const fetcher = options.fetcher ?? ((url: string) => fetchImageBytes(url));
  const gateways = options.gateways ?? ipfsGateways();
  const due = await db.tokenImageCache.findMany({
    where: { status: { in: ["PENDING", "FAILED"] }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now() } }] },
    orderBy: { createdAt: "asc" },
    take: options.limit ?? 5,
  });

  const stats = { claimed: 0, ready: 0, failed: 0, rejected: 0 };
  for (const row of due) {
    const claim = await db.tokenImageCache.updateMany({
      where: { id: row.id, attempts: row.attempts, status: row.status },
      data: { attempts: { increment: 1 }, nextAttemptAt: new Date(now().getTime() + CLAIM_LEASE_MS) },
    });
    if (claim.count !== 1) continue;
    stats.claimed += 1;
    const attempts = row.attempts + 1;

    try {
      const { bytes, contentType } = await obtain(row, fetcher, gateways);
      await db.tokenImageCache.update({
        where: { id: row.id },
        data: {
          status: "READY",
          contentType,
          bytes: Buffer.from(bytes),
          byteLength: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          fetchedAt: now(),
          lastError: null,
          nextAttemptAt: null,
        },
      });
      stats.ready += 1;
    } catch (error) {
      const e = error instanceof ImageFetchError ? error : new ImageFetchError((error as Error).message, false);
      const rejected = e.permanent;
      await db.tokenImageCache.update({
        where: { id: row.id },
        data: {
          status: rejected ? "REJECTED" : "FAILED",
          lastError: e.message.slice(0, 300),
          nextAttemptAt: rejected ? null : new Date(now().getTime() + (attempts >= MAX_ATTEMPTS ? retryDelayMs(MAX_ATTEMPTS + 4) : retryDelayMs(attempts))),
        },
      });
      if (rejected) stats.rejected += 1;
      else stats.failed += 1;
    }
  }
  return stats;
}

/** Background loop for the API process. Returns a stop function; never throws into the event loop. */
export function startTokenImageWorker(db: PrismaClient, log: (msg: string, meta?: object) => void, intervalMs = 5_000): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    processDueImages(db)
      .then((s) => s.claimed > 0 && log("[token-images] processed", s))
      .catch((e) => log("[token-images] tick failed", { error: (e as Error).message }))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
