/**
 * Phase 7B.5B §2 — verified token/quote decimals, resolved lazily by the
 * candle worker itself rather than folded into discoveryListener.ts's
 * existing launch-enrichment step (supply/isToken0/poolFee,
 * `EnrichmentStatus`).
 *
 * This is a deliberate architectural choice, not an oversight: Phase
 * 7B.5A's discovery enrichment pipeline (bounded-concurrency batch
 * enrichment, PENDING-row retry, the trade-listener barrier — see
 * ARCHITECTURE.md §20.4) is already implemented and thoroughly tested
 * end-to-end. Coupling decimals() resolution into that exact machinery
 * would change `EnrichmentStatus`'s meaning (today: "getLaunchedToken()
 * succeeded") and risk regressing that proven pipeline for a concern
 * (candle normalization) that pipeline was never designed around. Instead,
 * decimals resolution is its own small, independent, idempotent read/cache
 * step — the "Robinhood/Pons-specific enrichment... at the adapter
 * boundary" phase7b5b.txt §4 describes — that only the candle worker needs
 * and only the candle worker runs. discoveryListener.ts/tradeListener.ts
 * are untouched by this file.
 *
 * Never assumes 18 decimals (phase7b5b.txt §2). A resolution failure
 * (reverted/missing decimals() call) leaves the token's persisted
 * decimals columns null and this function returns null — the candle feed
 * (src/pons/candleFeed.ts) treats that as DECIMALS_UNAVAILABLE and skips
 * the token for that tick, fail closed, never defaulting.
 */

import type { PrismaClient } from "@prisma/client";
import type { ChainReader } from "../pons/chainClient";
import { ERC20_ABI } from "../pons/abi";

export interface ResolvedDecimals {
  readonly tokenDecimals: number;
  readonly quoteDecimals: number;
}

async function readDecimals(chainClient: ChainReader, address: string): Promise<number | null> {
  const result = await chainClient.readContract<number>({ address, abi: ERC20_ABI, functionName: "decimals", args: [] });
  if (result.status === "UNAVAILABLE") return null;
  const value = Number(result.data);
  if (!Number.isInteger(value) || value < 0 || value > 255) return null; // uint8 sanity — never trust a malformed response
  return value;
}

/**
 * Per-process quote-decimals cache: nearly every Pons token shares the same
 * `quoteAddress` (WETH_QUOTE), so this avoids re-reading it once per token
 * per tick — still always DB-cache-checked first (see below), this is only
 * a same-tick in-memory speedup.
 */
const quoteDecimalsMemo = new Map<string, number>();

/** Test-only: clears the in-process quote-decimals memo between test cases. */
export function resetDecimalsResolverMemo(): void {
  quoteDecimalsMemo.clear();
}

export async function resolveTokenDecimals(chainClient: ChainReader, db: PrismaClient, chain: string, tokenAddress: string, quoteAddress: string): Promise<ResolvedDecimals | null> {
  const existing = await db.discoveredToken.findUnique({
    where: { chain_tokenAddress: { chain, tokenAddress } },
    select: { tokenDecimals: true, quoteDecimals: true },
  });
  if (!existing) return null; // no DiscoveredToken row to persist resolved decimals onto — nothing to do
  if (existing.tokenDecimals !== null && existing.quoteDecimals !== null) {
    return { tokenDecimals: existing.tokenDecimals, quoteDecimals: existing.quoteDecimals };
  }

  const memoKey = `${chain}:${quoteAddress}`;
  let quoteDecimals = existing.quoteDecimals ?? quoteDecimalsMemo.get(memoKey) ?? null;
  if (quoteDecimals === null) {
    quoteDecimals = await readDecimals(chainClient, quoteAddress);
    if (quoteDecimals !== null) quoteDecimalsMemo.set(memoKey, quoteDecimals);
  }

  const tokenDecimals = existing.tokenDecimals ?? (await readDecimals(chainClient, tokenAddress));

  if (tokenDecimals === null || quoteDecimals === null) {
    return null;
  }

  await db.discoveredToken.update({
    where: { chain_tokenAddress: { chain, tokenAddress } },
    data: { tokenDecimals, quoteDecimals },
  });

  return { tokenDecimals, quoteDecimals };
}
