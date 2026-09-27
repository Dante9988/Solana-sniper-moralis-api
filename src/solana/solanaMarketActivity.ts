/**
 * Phase 7E.4.4 — rolling trade activity for Solana tokens, onto their `TokenMarketSnapshot` rows.
 *
 * Robinhood gets these windows from its Trending pass (src/pons/market/trendingVolume.ts), which
 * values every trade in USD through a Chainlink feed. Solana has no trusted SOL/USD source here, so
 * this pass counts the same things in the quote asset instead and writes them to the quote columns.
 * It deliberately never touches `trendingScore`/`trendingComputedAt`: Solana Trending needs its own
 * eligibility and scoring, and until that exists the Trending query must not see these tokens.
 *
 * Summing quote amounts across trades is only valid at one decimal scale. Persistence refuses any
 * trade whose quote scale differs from its token's (§14), so every stored trade of a token shares it.
 */

import type { PrismaClient } from "@prisma/client";

export interface SolanaActivitySummary {
  readonly tokensUpdated: number;
  readonly computedAt: string;
}

export async function refreshSolanaMarketActivity(db: PrismaClient, now: Date = new Date()): Promise<SolanaActivitySummary> {
  const hourAgo = new Date(now.getTime() - 60 * 60_000);
  const fiveMinutesAgo = new Date(now.getTime() - 5 * 60_000);

  // Every Solana snapshot that traded in the last hour, plus any that still shows activity from an
  // earlier pass — those must drop to zero rather than keep a stale count forever.
  const tokensUpdated = await db.$executeRaw`
    WITH act AS (
      SELECT t."tokenAddress",
             count(*)::int                                                   AS trades,
             count(*) FILTER (WHERE t.side = 'buy')::int                      AS buys,
             count(*) FILTER (WHERE t.side = 'sell')::int                     AS sells,
             count(DISTINCT t.trader)::int                                    AS traders,
             sum(t."quoteAmount")                                             AS vol1h,
             COALESCE(sum(t."quoteAmount") FILTER (WHERE t."sourceTimestamp" >= ${fiveMinutesAgo}), 0) AS vol5m
      FROM "ChainTrade" t
      WHERE t.chain = 'solana' AND t."canonicalStatus" = 'CANONICAL' AND t."sourceTimestamp" >= ${hourAgo}
      GROUP BY t."tokenAddress"
    ),
    target AS (
      SELECT s.id, act.trades, act.buys, act.sells, act.traders, act.vol1h, act.vol5m
      FROM "TokenMarketSnapshot" s
      LEFT JOIN act ON act."tokenAddress" = s."tokenAddress"
      WHERE s.chain = 'solana'
        AND (act."tokenAddress" IS NOT NULL OR COALESCE(s.trades1h, 0) > 0 OR s."activityComputedAt" IS NULL)
    )
    UPDATE "TokenMarketSnapshot" s SET
      trades1h = COALESCE(target.trades, 0),
      buys1h = COALESCE(target.buys, 0),
      sells1h = COALESCE(target.sells, 0),
      traders1h = COALESCE(target.traders, 0),
      "volume1hQuote" = COALESCE(target.vol1h, 0),
      "volume5mQuote" = COALESCE(target.vol5m, 0),
      "activityComputedAt" = ${now},
      "updatedAt" = now()
    FROM target
    WHERE s.id = target.id`;

  return { tokensUpdated, computedAt: now.toISOString() };
}
