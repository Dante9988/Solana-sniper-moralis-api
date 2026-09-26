/**
 * Phase 7E.4 §11/§12 — run the real classifier and scorer against live Robinhood Chain data.
 *
 * Evaluates "as of" the newest indexed trade rather than wall-clock now, so a stopped local
 * worker does not make every token look stale and hide what the gates actually do.
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { loadTrendingConfig } from "../src/pons/market/trendingConfig";
import { classifyEligibility, liquidityRatioBps, type RiskClassification } from "../src/pons/market/trendingEligibility";
import { buildCohort, scoreToken, type TrendingMetrics } from "../src/pons/market/trendingRank";

const db = new PrismaClient();
const config = loadTrendingConfig();
const fm = (n: number | null) => (n === null ? "—" : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(2)}`);
const pct = (a: number[], f: number) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.round(f * (s.length - 1)))] : null; };

interface Row {
  tokenAddress: string; symbol: string | null;
  v5m: number; v1h: number; vPrev: number; prevTrades: number;
  trades1h: number; traders1h: number; lastTrade: Date;
  mc: number | null; liq: number | null; snapshotAt: Date | null; change1h: number | null;
  quoteDecimals: number | null; liquidityQuote: number | null;
}

/**
 * Raw `quoteAmount` is an integer in the pair asset's base units. Turning it into USD needs
 * the asset's decimals AND its USD rate — omitting either produces numbers like
 * "$33282333879527.32M", which is how this script was wrong on its first run.
 *
 * The rate is derived from the token's own snapshot (liquidityUsd against liquidityQuote)
 * rather than a rate provider, so the validation stays self-consistent with the very row it
 * is judging and needs no extra service wired up.
 */
function usdRate(row: Row): number | null {
  if (row.liq === null || row.liquidityQuote === null || row.quoteDecimals === null) return null;
  const quote = row.liquidityQuote / 10 ** row.quoteDecimals;
  if (!(quote > 0)) return null;
  return row.liq / quote;
}

function toUsd(raw: number, row: Row): number | null {
  const rate = usdRate(row);
  if (rate === null || row.quoteDecimals === null) return null;
  return (raw / 10 ** row.quoteDecimals) * rate;
}

async function main() {
  const [{ at }] = await db.$queryRawUnsafe<{ at: Date }[]>(`SELECT MAX("sourceTimestamp") AS at FROM "ChainTrade"`);
  const now = at;
  console.log(`evaluating as of newest indexed trade: ${now.toISOString()}\n`);

  const rows = await db.$queryRawUnsafe<Row[]>(`
    WITH w AS (SELECT * FROM "ChainTrade" WHERE chain='robinhood' AND "canonicalStatus"='CANONICAL' AND "sourceTimestamp" > $1::timestamptz - interval '7 hours' AND "sourceTimestamp" <= $1::timestamptz),
    agg AS (
      SELECT "tokenAddress",
        COALESCE(SUM("quoteAmount") FILTER (WHERE "sourceTimestamp" > $1::timestamptz - interval '5 minutes'),0)::float8 AS v5m,
        COALESCE(SUM("quoteAmount") FILTER (WHERE "sourceTimestamp" > $1::timestamptz - interval '1 hour'),0)::float8 AS v1h,
        COALESCE(SUM("quoteAmount") FILTER (WHERE "sourceTimestamp" <= $1::timestamptz - interval '1 hour'),0)::float8 AS "vPrev",
        COUNT(*) FILTER (WHERE "sourceTimestamp" <= $1::timestamptz - interval '1 hour')::int AS "prevTrades",
        COUNT(*) FILTER (WHERE "sourceTimestamp" > $1::timestamptz - interval '1 hour')::int AS "trades1h",
        COUNT(DISTINCT trader) FILTER (WHERE "sourceTimestamp" > $1::timestamptz - interval '1 hour')::int AS "traders1h",
        MAX("sourceTimestamp") AS "lastTrade"
      FROM w GROUP BY 1)
    SELECT a.*, d.symbol, s."marketCapUsd"::float8 AS mc, s."liquidityUsd"::float8 AS liq,
           s."updatedAt" AS "snapshotAt", s."marketCapChange1hPct"::float8 AS "change1h",
           s."quoteDecimals"::int AS "quoteDecimals", s."liquidityQuote"::float8 AS "liquidityQuote"
    FROM agg a
    LEFT JOIN "DiscoveredToken" d ON d."tokenAddress"=a."tokenAddress" AND d.chain='robinhood'
    LEFT JOIN "TokenMarketSnapshot" s ON s."tokenAddress"=a."tokenAddress" AND s.chain='robinhood' AND s.status='OK'
    WHERE a."trades1h" > 0`, now);

  const counts: Record<RiskClassification, number> = { ELIGIBLE: 0, CAUTION: 0, HIGH_RISK: 0, UNVERIFIED: 0 };
  const eligible: { row: Row; metrics: TrendingMetrics; ratio: number | null }[] = [];

  for (const r of rows) {
    const ratio = liquidityRatioBps(r.liq, r.mc);
    const snapshotAgeMs = r.snapshotAt ? Math.max(0, now.getTime() - r.snapshotAt.getTime()) : null;
    const lastTradeAgeMs = Math.max(0, now.getTime() - new Date(r.lastTrade).getTime());
    const cls = classifyEligibility({
      valuationUsd: r.mc, valuationBasis: "FDV", liquidityUsd: r.liq,
      trades1h: r.trades1h, traders1h: r.traders1h,
      // Snapshot freshness is measured against wall clock in production; here the worker is
      // stopped, so it is measured against the evaluation instant to isolate the gates.
      snapshotAgeMs: snapshotAgeMs === null ? null : Math.min(snapshotAgeMs, config.thresholds.maxSnapshotAgeMs),
      lastTradeAgeMs, routeVerified: true, tradingUnavailable: false,
    }, config);
    counts[cls.classification] += 1;
    if (cls.classification === "ELIGIBLE") {
      const v5 = toUsd(r.v5m, r);
      const v1 = toUsd(r.v1h, r);
      const vp = toUsd(r.vPrev, r);
      // A token whose volume cannot be valued is not ranked on an unvalued number.
      if (v5 === null || v1 === null) { counts.ELIGIBLE -= 1; counts.UNVERIFIED += 1; continue; }
      eligible.push({ row: r, ratio, metrics: {
        volume5mUsd: v5, volume1hUsd: v1,
        baselineHourlyUsd: r.prevTrades > 0 && vp !== null ? vp / 6 : null,
        trades1h: r.trades1h, traders1h: r.traders1h,
        liquidityUsd: r.liq ?? 0, liquidityRatioBps: ratio,
        valuationChange1h: r.change1h === null ? null : r.change1h / 100,
        lastTradeAgeMs, snapshotAgeMs: 0,
      } });
    }
  }

  console.log(`§11 classification of ${rows.length} tokens with trades in the last hour`);
  for (const k of ["ELIGIBLE", "CAUTION", "HIGH_RISK", "UNVERIFIED"] as const) console.log(`  ${k.padEnd(11)} ${counts[k]}`);

  if (eligible.length === 0) { console.log("\nno ELIGIBLE tokens"); await db.$disconnect(); return; }

  const show = (label: string, arr: number[], f: (n: number | null) => string) =>
    console.log(`  ${label.padEnd(16)}` + [0.1, 0.25, 0.5, 0.75, 0.9].map((x) => f(pct(arr, x)).padStart(11)).join(""));
  console.log(`\n§11 ELIGIBLE distribution (n=${eligible.length})    p10        p25        p50        p75        p90`);
  show("valuation", eligible.map((e) => e.row.mc ?? 0), fm);
  show("liquidity", eligible.map((e) => e.row.liq ?? 0), fm);
  show("liq/val %", eligible.map((e) => (e.ratio ?? 0) / 100), (n) => (n === null ? "—" : `${n.toFixed(2)}%`));
  show("volume 1h", eligible.map((e) => e.metrics.volume1hUsd), fm);
  show("trades 1h", eligible.map((e) => e.metrics.trades1h), (n) => (n === null ? "—" : String(n)));
  show("traders 1h", eligible.map((e) => e.metrics.traders1h), (n) => (n === null ? "—" : String(n)));

  const cohort = buildCohort(eligible.map((e) => e.metrics));
  const ranked = eligible
    .map((e) => ({ ...e, score: scoreToken(e.metrics, cohort, config) }))
    .sort((a, b) => b.score.finalScore - a.score.finalScore)
    .slice(0, 20);

  console.log("\n§12 top 20");
  console.log("  # symbol       valuation  liquidity  ratio    vol1h      trades traders  act  acc  brd  liq  score");
  ranked.forEach((e, i) => {
    const s = e.score;
    console.log(
      `  ${String(i + 1).padStart(2)} ${(e.row.symbol ?? "?").slice(0, 12).padEnd(12)} ${fm(e.row.mc).padStart(9)} ${fm(e.row.liq).padStart(10)} ` +
      `${(((e.ratio ?? 0) / 100).toFixed(1) + "%").padStart(7)} ${fm(e.metrics.volume1hUsd).padStart(9)} ${String(e.metrics.trades1h).padStart(6)} ${String(e.metrics.traders1h).padStart(7)}` +
      `  ${s.currentActivity.toFixed(2)} ${s.acceleration.toFixed(2)} ${s.traderBreadth.toFixed(2)} ${s.liquidityQuality.toFixed(2)} ${s.finalScore.toFixed(3)}`
    );
  });

  const shells = ranked.filter((e) => (e.row.mc ?? 0) < config.thresholds.minValuationUsd || (e.ratio ?? 0) < config.thresholds.minLiquidityRatioBps);
  console.log(`\nshells (below valuation floor or ratio floor) surviving into the top 20: ${shells.length}`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
