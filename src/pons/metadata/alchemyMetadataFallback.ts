/**
 * Phase 7D.4 §2 — optional Alchemy metadata fallback for tokens whose standard ERC-20 name()/symbol()
 * reads produced nothing.
 *
 * Capability, verified 2026-09-15 on Robinhood Chain: `alchemy_getTokenMetadata` exists only on
 * Alchemy endpoints (the public default RPC answers -32601) and returns name, symbol and decimals
 * with `logo` always null, so it can never supply artwork. Of the 12 Pons V2 tokens then lacking a
 * name or symbol, it named 1.
 *
 * It is provider-specific, so it is deliberately not part of generic RPC failover: only endpoints on
 * an Alchemy host are tried, each is probed once, and "method not found" disables it for that
 * endpoint. It fills only fields that are null, records per-field provenance, retries a token at
 * most once a day, and never changes decimals: a disagreement is recorded as a conflict.
 */

import type { Prisma, PrismaClient } from "@prisma/client";

import { resolveHttpEndpoints } from "../rpcEndpoints";

const DAY_MS = 86_400_000;

export interface AlchemyTokenMetadata {
  name: string | null;
  symbol: string | null;
  decimals: number | null;
}

export type Fetcher = (url: string, body: unknown) => Promise<{ result?: { name?: string | null; symbol?: string | null; decimals?: number | null }; error?: { code: number; message: string } }>;

const defaultFetcher: Fetcher = async (url, body) => {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  return (await res.json()) as Awaited<ReturnType<Fetcher>>;
};

export function alchemyEndpoints(env: NodeJS.ProcessEnv = process.env): string[] {
  return resolveHttpEndpoints(env)
    .filter((e) => /(^|\.)alchemy\.com$/i.test(e.host))
    .map((e) => e.url);
}

const clean = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, 80) : null);

export async function fillMissingTokenMetadata(
  db: PrismaClient,
  options: { env?: NodeJS.ProcessEnv; fetcher?: Fetcher; limit?: number; now?: () => Date; log?: (msg: string, meta?: object) => void } = {}
): Promise<{ attempted: number; filled: number; endpoint: "NONE" | "UNSUPPORTED" | "OK" }> {
  const endpoints = alchemyEndpoints(options.env);
  if (endpoints.length === 0) return { attempted: 0, filled: 0, endpoint: "NONE" };
  const fetcher = options.fetcher ?? defaultFetcher;
  const now = options.now?.() ?? new Date();
  const cutoff = new Date(now.getTime() - DAY_MS).toISOString();

  const rows = await db.$queryRaw<Array<{ id: string; tokenAddress: string; name: string | null; symbol: string | null; tokenDecimals: number | null; metadataProvenance: Prisma.JsonValue }>>`
    SELECT id, "tokenAddress", name, symbol, "tokenDecimals", "metadataProvenance" FROM "DiscoveredToken"
    WHERE chain = 'robinhood' AND "canonicalStatus" = 'CANONICAL' AND "enrichmentStatus" = 'COMPLETE'
      AND (name IS NULL OR symbol IS NULL)
      AND ("metadataProvenance" IS NULL OR COALESCE("metadataProvenance"->>'alchemyAttemptedAt', '') < ${cutoff})
    ORDER BY "sourceHeight" DESC
    LIMIT ${options.limit ?? 25}`;
  if (rows.length === 0) return { attempted: 0, filled: 0, endpoint: "OK" };

  let usable = [...endpoints];
  let filled = 0;
  for (const row of rows) {
    let meta: AlchemyTokenMetadata | null = null;
    while (usable.length > 0 && !meta) {
      const response = await fetcher(usable[0], { jsonrpc: "2.0", id: 1, method: "alchemy_getTokenMetadata", params: [row.tokenAddress] }).catch(() => null);
      if (response?.error?.code === -32601) {
        usable = usable.slice(1); // this endpoint does not offer the method at all
        continue;
      }
      if (!response || response.error || !response.result) break; // per-token failure: try again tomorrow
      meta = { name: clean(response.result.name), symbol: clean(response.result.symbol), decimals: typeof response.result.decimals === "number" ? response.result.decimals : null };
    }
    if (usable.length === 0) {
      options.log?.("[metadata] alchemy_getTokenMetadata is not supported by the configured Alchemy endpoints");
      return { attempted: rows.indexOf(row), filled, endpoint: "UNSUPPORTED" };
    }

    const provenance = { ...((row.metadataProvenance as Record<string, unknown>) ?? {}), alchemyAttemptedAt: now.toISOString() } as Record<string, unknown>;
    const data: Prisma.DiscoveredTokenUpdateInput = {};
    if (meta) {
      if (!row.name && meta.name) {
        data.name = meta.name;
        provenance.name = { source: "alchemy_getTokenMetadata", observedAt: now.toISOString() };
      }
      if (!row.symbol && meta.symbol) {
        data.symbol = meta.symbol;
        provenance.symbol = { source: "alchemy_getTokenMetadata", observedAt: now.toISOString() };
      }
      if (row.tokenDecimals !== null && meta.decimals !== null && meta.decimals !== row.tokenDecimals) {
        provenance.decimalsConflict = { chain: row.tokenDecimals, alchemy: meta.decimals, observedAt: now.toISOString() };
      }
    }
    // Only fields that are still null are written, so a concurrent enrichment is never overwritten.
    await db.discoveredToken.updateMany({
      where: { id: row.id, ...(data.name ? { name: null } : {}), ...(data.symbol ? { symbol: null } : {}) },
      data: { ...data, metadataProvenance: provenance as Prisma.InputJsonValue },
    });
    if (data.name || data.symbol) filled += 1;
  }
  return { attempted: rows.length, filled, endpoint: "OK" };
}
