/**
 * Phase 7E.4.4 — the chain-neutral token catalog: serialization and the discovery query, shared by
 * `/api/v1/tokens/robinhood`, `/api/v1/tokens/solana` and the chain-neutral `/api/v1/tokens`.
 *
 * Moved here from routes/robinhoodTokens.ts rather than copied, so there is one filter → eligibility
 * → ordering → pagination path for every chain (§1). What differs by chain is data, not code paths:
 *
 *   - Addresses: EVM addresses are stored lowercase; Solana mints are base58 and CASE-SENSITIVE, so
 *     nothing here lowercases a Solana address (§14).
 *   - USD: Robinhood values in USD through verified Chainlink feeds. Solana has no trusted SOL/USD
 *     source, so a request that needs USD (a USD filter, a USD ordering across chains, Trending)
 *     cannot include Solana. It is excluded AND reported in `excludedChains` — never silently mixed
 *     into an ordering it has no value for (§6/§12/§17).
 */

import { Prisma, type ChainTrade, type DiscoveredToken, type PrismaClient, type TokenMarketSnapshot } from "@prisma/client";

import { enqueueTokenLogos, logoStatuses, logoUrlFor, type ImageStatus } from "../media/tokenImageCache";
import { formatScaled } from "../pons/market/marketSnapshot";
import { trendingCoverage } from "../pons/market/trendingVolume";
import { lookupQuoteAsset } from "../pons/usd/chainlinkQuoteUsdRateProvider";
import { SOL_QUOTE_ADDRESSES, solanaQuoteAsset } from "../solana/solanaQuoteAssets";
import { logger } from "./lib/logger";

export type CatalogChain = "robinhood" | "solana";
export const CATALOG_CHAINS: readonly CatalogChain[] = ["robinhood", "solana"];

/**
 * Prisma.Decimal#toString() renders large integers in scientific notation (e.g. "1e+27");
 * #toFixed() with no argument is the full digit string. Every Decimal crossing into JSON goes
 * through this helper, never a bare .toString().
 */
export function decimalToString(value: Prisma.Decimal | null): string | null {
  return value === null ? null : value.toFixed();
}

function quoteAssetRef(chain: string, address: string) {
  if (chain === "solana") {
    const asset = solanaQuoteAsset(address);
    return asset
      ? { identified: true, symbol: asset.symbol, name: asset.name, decimals: asset.decimals, kind: asset.kind, usdFeed: null }
      : { identified: false, symbol: null, name: null, decimals: null, kind: null, usdFeed: null };
  }
  const asset = lookupQuoteAsset(address);
  return asset
    ? { identified: true, symbol: asset.symbol, name: asset.name, decimals: asset.decimals, kind: asset.kind as "native" | "wrapped-native" | "stablecoin" | "stock-token", usdFeed: asset.feed?.name ?? null }
    : { identified: false, symbol: null, name: null, decimals: null, kind: null, usdFeed: null };
}

const TEN = 10n;

function liquidityBasisFor(venue: string | null) {
  if (venue === "UNISWAP_V4_POOL") return "POOL_FULL_RANGE_EQUIVALENT" as const;
  // Phase 7E.4.4 — the pool's quote-side vault balance: what a seller could be paid from.
  if (venue === "PUMPSWAP_POOL") return "POOL_QUOTE_RESERVE" as const;
  return "CURVE_REAL_QUOTE" as const;
}

/** Phase 7D.4 — the live snapshot in whole units. Never a bare Decimal.toString() (exponent form). */
export function serializeMarket(s: TokenMarketSnapshot | null | undefined) {
  if (!s) return null;
  const big = (d: Prisma.Decimal | null) => (d === null ? null : BigInt(d.toFixed(0)));
  const whole = (raw: bigint | null, decimals: number | null) => (raw === null || decimals === null ? null : formatScaled(raw, decimals));
  const priceX36 = big(s.priceQuoteX36);
  const priceQuote =
    priceX36 === null || s.tokenDecimals === null || s.quoteDecimals === null
      ? null
      : formatScaled((priceX36 * TEN ** BigInt(s.tokenDecimals)) / TEN ** BigInt(s.quoteDecimals), 36);
  const ok = s.status === "OK";
  return {
    status: s.status as "PENDING" | "OK" | "FAILED" | "UNSUPPORTED",
    reason: s.status === "OK" ? null : s.status === "PENDING" ? "not read yet" : s.lastError,
    venue: (s.venue as "PONS_V2_BONDING_CURVE" | "UNISWAP_V4_POOL" | "PUMPFUN_BONDING_CURVE" | "PUMPSWAP_POOL" | null) ?? null,
    blockNumber: s.blockNumber?.toString() ?? null,
    asOf: s.blockTimestamp?.toISOString() ?? null,
    priceQuote: ok ? priceQuote : null,
    priceUsd: ok ? decimalToString(s.priceUsd) : null,
    marketCapQuote: ok ? whole(big(s.marketCapQuote), s.quoteDecimals) : null,
    marketCapUsd: ok ? decimalToString(s.marketCapUsd) : null,
    liquidityQuote: ok ? whole(big(s.liquidityQuote), s.quoteDecimals) : null,
    liquidityUsd: ok ? decimalToString(s.liquidityUsd) : null,
    liquidityBasis: !ok ? null : liquidityBasisFor(s.venue),
    bondingProgressPct: ok && s.bondingProgressBps !== null ? s.bondingProgressBps / 100 : null,
    quoteRaised: ok ? whole(big(s.quoteRaised), s.quoteDecimals) : null,
    graduationThreshold: ok ? whole(big(s.graduationThreshold), s.quoteDecimals) : null,
    readyToGraduate: ok && s.readyToGraduate,
    marketCapChange1hUsd: ok ? decimalToString(s.marketCapChange1hUsd) : null,
    marketCapChange1hPct: ok ? decimalToString(s.marketCapChange1hPct) : null,
    volume5mUsd: decimalToString(s.volume5mUsd),
    volume1hUsd: decimalToString(s.volume1hUsd),
    // Phase 7E.4.4 — whole quote units, for chains without a trusted USD rate.
    volume5mQuote: whole(big(s.volume5mQuote), s.quoteDecimals),
    volume1hQuote: whole(big(s.volume1hQuote), s.quoteDecimals),
    activityAsOf: (s.trendingComputedAt ?? s.activityComputedAt)?.toISOString() ?? null,
    volumeBaselineHourlyUsd: decimalToString(s.volumeBaselineHourlyUsd),
    volumeSurge: decimalToString(s.volumeSurge),
    trades1h: s.trades1h,
    buys1h: s.buys1h,
    sells1h: s.sells1h,
    traders1h: s.traders1h,
    trendingScore: decimalToString(s.trendingScore),
    // Phase 7E.4 §10 — the evidence behind an exclusion, so a UI can explain rather than
    // silently drop a token the user was looking for. Never a "safe" boolean.
    riskClassification: s.riskClassification ?? null,
    riskReasons: Array.isArray(s.riskReasons) ? (s.riskReasons as string[]) : [],
    liquidityRatioBps: s.liquidityRatioBps ?? null,
    valuationBasis: s.valuationBasis ?? null,
    usdSource: ok ? s.usdRateSource : null,
  };
}

/**
 * Phase 7E.4.4 — one lifecycle vocabulary for every chain and launchpad.
 *
 *   bonding            trading on its launch curve
 *   bonding_complete   the curve sold out, but no destination pool is proven yet (Pump.fun's
 *                      CompleteEvent; Pons' readyToGraduate). NOT graduated.
 *   graduated          a destination pool is proven by the chain (Pons' PoolGraduated;
 *                      Pump.fun's CompletePumpAmmMigrationEvent naming the pool)
 */
export type LifecyclePhase = "bonding" | "bonding_complete" | "graduated" | "unknown";

const SOLANA_PHASES: Record<string, LifecyclePhase> = {
  bonding_curve: "bonding",
  bonding_complete: "bonding_complete",
  migrating: "bonding_complete",
  pumpswap: "graduated",
};

export function lifecyclePhaseOf(row: Pick<DiscoveredToken, "chain" | "graduated">, market: TokenMarketSnapshot | null, solanaState: string | null): LifecyclePhase {
  if (row.graduated) return "graduated";
  if (row.chain === "solana") return solanaState ? SOLANA_PHASES[solanaState] ?? "unknown" : "unknown";
  if (market?.status === "OK" && market.readyToGraduate) return "bonding_complete";
  return "bonding";
}

/** Launchpad id for a DiscoveredToken.venue — the product vocabulary, not the storage value. */
function launchpadOf(venue: string): string {
  if (venue === "pumpfun") return "pumpfun";
  if (venue.startsWith("pons")) return "pons";
  return venue;
}

export interface SerializeTokenContext {
  readonly logoStatus?: ImageStatus;
  readonly market?: TokenMarketSnapshot | null;
  readonly solanaState?: string | null;
}

export function serializeToken(row: DiscoveredToken, context: SerializeTokenContext = {}) {
  const market = context.market ?? null;
  const isSolana = row.chain === "solana";
  return {
    chain: row.chain as CatalogChain,
    venue: row.venue,
    launchpad: launchpadOf(row.venue),
    lifecycle: { phase: lifecyclePhaseOf(row, market, context.solanaState ?? null) },
    tokenAddress: row.tokenAddress,
    deployer: row.deployer,
    poolAddress: row.poolAddress,
    curveAddress: row.curveAddress,
    quoteAddress: row.quoteAddress,
    quoteAsset: quoteAssetRef(row.chain, row.quoteAddress),
    // Phase 7E.4.4 — verified on-chain decimals, so a client can scale raw trade units itself.
    tokenDecimals: row.tokenDecimals,
    quoteDecimals: row.quoteDecimals,
    name: row.name,
    symbol: row.symbol,
    // The launcher's own URL, kept for provenance. Clients must render `logo.url` instead:
    // it is served from OnlyPump's origin, byte-verified, and never contacts a third party.
    logoUrl: row.logoUrl,
    logo: {
      url: row.logoUrl ? logoUrlFor(row.tokenAddress) : null,
      status: context.logoStatus ?? (row.logoUrl ? "PENDING" : "NONE"),
    },
    // Pump.fun stores its metadata URI where a description would go (it has no on-chain
    // description); that URI is surfaced as what it is, never as prose.
    description: isSolana ? null : row.description,
    metadataUri: isSolana ? row.description : null,
    socials: {
      website: row.socialWebsite,
      twitter: row.socialTwitter,
      telegram: row.socialTelegram,
      discord: row.socialDiscord,
      farcaster: row.socialFarcaster,
    },
    richMetadataStatus: row.richMetadataStatus,
    // Phase 7B.5A §4/§9 — null while enrichment is still PENDING. Never a fabricated default.
    supply: decimalToString(row.supply),
    enrichmentStatus: row.enrichmentStatus,
    initialBuyAmount: decimalToString(row.initialBuyAmount)!,
    sourceHeight: row.sourceHeight.toString(),
    sourceHash: row.sourceHash,
    sourceTxHash: row.sourceTxHash,
    sourceIndex: row.sourceIndex,
    observedAt: row.observedAt.toISOString(),
    graduated: row.graduated,
    graduationPairedPrincipal: decimalToString(row.graduationPairedPrincipal),
    graduationThreshold: decimalToString(row.graduationThreshold),
    graduationCheckedAt: row.graduationCheckedAt?.toISOString() ?? null,
    graduationPositionId: decimalToString(row.graduationPositionId),
    graduationTokenAmount: decimalToString(row.graduationTokenAmount),
    graduationPairTokenAmount: decimalToString(row.graduationPairTokenAmount),
    poolId: row.poolId,
    market: serializeMarket(market),
  };
}

export function serializeTrade(row: ChainTrade) {
  return {
    chain: row.chain as CatalogChain,
    venue: row.venue,
    tokenAddress: row.tokenAddress,
    poolAddress: row.poolAddress,
    poolId: row.poolId,
    side: row.side,
    tokenAmount: decimalToString(row.tokenAmount)!,
    quoteAmount: decimalToString(row.quoteAmount)!,
    quoteAddress: row.quoteAddress,
    priceQuote: decimalToString(row.priceQuote)!,
    trader: row.trader,
    sourceHeight: row.sourceHeight.toString(),
    sourceHash: row.sourceHash,
    sourceTxHash: row.sourceTxHash,
    sourceIndex: row.sourceIndex,
    observedAt: row.observedAt.toISOString(),
  };
}

/** Stored-address key: EVM rows are stored lowercase, Solana rows exactly as the chain wrote them. */
const keyOf = (chain: string, address: string) => `${chain}|${chain === "solana" ? address : address.toLowerCase()}`;

async function snapshotsFor(db: PrismaClient, rows: Pick<DiscoveredToken, "chain" | "tokenAddress">[]): Promise<Map<string, TokenMarketSnapshot>> {
  if (rows.length === 0) return new Map();
  try {
    const found = await db.tokenMarketSnapshot.findMany({
      where: {
        OR: CATALOG_CHAINS.map((chain) => ({
          chain,
          tokenAddress: { in: rows.filter((r) => r.chain === chain).map((r) => (chain === "solana" ? r.tokenAddress : r.tokenAddress.toLowerCase())) },
        })),
      },
    });
    return new Map(found.map((r) => [keyOf(r.chain, r.tokenAddress), r]));
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "market snapshots unavailable");
    return new Map();
  }
}

async function solanaStatesFor(db: PrismaClient, rows: Pick<DiscoveredToken, "chain" | "tokenAddress">[]): Promise<Map<string, string>> {
  const mints = rows.filter((r) => r.chain === "solana").map((r) => r.tokenAddress);
  if (mints.length === 0) return new Map();
  try {
    const states = await db.tokenLifecycleState.findMany({ where: { mint: { in: mints } }, select: { mint: true, state: true } });
    return new Map(states.map((s) => [s.mint, s.state]));
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "lifecycle states unavailable");
    return new Map();
  }
}

/**
 * Logo status is decoration: a cache failure must never fail a token read. Enqueueing is
 * fire-and-forget for the same reason. The image cache is keyed by EVM address, so only Robinhood
 * rows use it; a Solana row has no launcher logo URL yet and reports NONE.
 */
async function logoStatusesSafely(db: PrismaClient, rows: DiscoveredToken[]): Promise<Map<string, ImageStatus>> {
  const tokens = rows.filter((r) => r.chain === "robinhood").map((r) => ({ tokenAddress: r.tokenAddress, logoUrl: r.logoUrl }));
  if (tokens.length === 0) return new Map();
  enqueueTokenLogos(db, tokens).catch((err) => logger.warn({ err: (err as Error).message }, "[token-images] enqueue failed"));
  try {
    return await logoStatuses(db, tokens);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "[token-images] status lookup failed");
    return new Map();
  }
}

/** Serializes a set of rows with their snapshots, lifecycle states and logo statuses, in one pass. */
export async function serializeTokens(db: PrismaClient, rows: DiscoveredToken[]) {
  const [statuses, snapshots, states] = await Promise.all([logoStatusesSafely(db, rows), snapshotsFor(db, rows), solanaStatesFor(db, rows)]);
  return rows.map((row) =>
    serializeToken(row, {
      logoStatus: row.chain === "robinhood" ? statuses.get(row.tokenAddress.toLowerCase()) : undefined,
      market: snapshots.get(keyOf(row.chain, row.tokenAddress)) ?? null,
      solanaState: states.get(row.tokenAddress) ?? null,
    })
  );
}

// ---------------------------------------------------------------------------------------------
// The discovery query
// ---------------------------------------------------------------------------------------------

export interface TokenListFilters {
  limit: number;
  cursor?: string;
  lifecycle: "all" | "bonding" | "graduated" | "almost-bonded" | "trending";
  sort?: "new" | "marketCap" | "liquidity" | "progress" | "change1h" | "volume1h" | "trending";
  q?: string;
  fdvMin?: string; fdvMax?: string;
  liquidityMin?: string; liquidityMax?: string;
  volume5mMin?: string; volume1hMin?: string;
  txns1hMin?: number; buys1hMin?: number; sells1hMin?: number; traders1hMin?: number;
}

export class TokenListError extends Error {}

export interface ExcludedChain {
  chain: CatalogChain;
  reason: string;
}

const SOLANA_NO_USD = "Solana values are in SOL only — there is no trusted SOL/USD rate, so a USD filter or USD ordering cannot include Solana tokens.";
const SOLANA_NO_TRENDING = "Solana Trending is not available yet: it needs its own eligibility checks and score, and ranking unscreened tokens would not be honest.";
const SOLANA_NO_CHANGE = "Solana has no 1h market-cap change yet, so this ordering cannot include Solana tokens.";

const EVM_ADDRESS_PREFIX = /^0x[0-9a-fA-F]{2,40}$/;
/** A full base58 mint (32–44 chars). Shorter base58 strings are treated as a name search. */
const SOLANA_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CURSOR_ADDRESS = /^(0x[0-9a-f]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;

/**
 * Decides which requested chains can honestly answer this request.
 *
 * Exported for tests: this is the rule that keeps a USD-ordered or Trending page from being padded
 * with tokens that have no USD value or no Trending evaluation.
 */
export function planChains(requested: readonly CatalogChain[], filters: TokenListFilters, sort: NonNullable<TokenListFilters["sort"]>) {
  const excluded: ExcludedChain[] = [];
  let included = [...requested];
  const drop = (chain: CatalogChain, reason: string) => {
    if (!included.includes(chain)) return;
    included = included.filter((c) => c !== chain);
    excluded.push({ chain, reason });
  };
  const usdFiltered = [filters.fdvMin, filters.fdvMax, filters.liquidityMin, filters.liquidityMax, filters.volume5mMin, filters.volume1hMin].some((v) => v !== undefined);
  const solanaOnly = requested.length === 1 && requested[0] === "solana";

  if (filters.lifecycle === "trending" || sort === "trending") drop("solana", SOLANA_NO_TRENDING);
  if (usdFiltered) drop("solana", SOLANA_NO_USD);
  if (sort === "change1h") drop("solana", SOLANA_NO_CHANGE);
  // Within Solana alone, value orderings compare SOL to SOL. Mixed with Robinhood they would need
  // one unit, and USD is the only shared one.
  if (!solanaOnly && (sort === "marketCap" || sort === "liquidity" || sort === "volume1h")) drop("solana", SOLANA_NO_USD);

  return { included, excluded, solanaOnly };
}

export async function listTokens(db: PrismaClient, requested: readonly CatalogChain[], filters: TokenListFilters, now: Date = new Date()) {
  const { limit, cursor, lifecycle, q } = filters;
  for (const [min, max] of [[filters.fdvMin, filters.fdvMax], [filters.liquidityMin, filters.liquidityMax]]) {
    if (min !== undefined && max !== undefined && new Prisma.Decimal(min).gt(max)) throw new TokenListError("minimum must not exceed maximum");
  }
  const sort = filters.sort ?? (lifecycle === "almost-bonded" ? "progress" : lifecycle === "trending" ? "trending" : "new");
  const { included, excluded, solanaOnly } = planChains(requested, filters, sort);

  const trending = lifecycle === "trending" && included.includes("robinhood") ? await trendingCoverage(db, now) : undefined;
  if (included.length === 0) {
    return { tokens: [], nextCursor: null, total: 0, chains: included, excludedChains: excluded, ...(lifecycle === "trending" ? { trending: trending ?? unavailableTrending(now) } : {}), observedAt: now.toISOString() };
  }

  const conds: Prisma.Sql[] = [Prisma.sql`d.chain IN (${Prisma.join(included)})`, Prisma.sql`d."canonicalStatus" = 'CANONICAL'`];
  if (lifecycle === "graduated") conds.push(Prisma.sql`d.graduated = true`);
  if (lifecycle === "bonding") conds.push(Prisma.sql`d.graduated = false`);
  if (lifecycle === "almost-bonded") conds.push(Prisma.sql`d.graduated = false AND s.status = 'OK' AND s.graduated = false AND s."bondingProgressBps" > 0`);
  const marketFreshAfter = new Date(now.getTime() - 5 * 60_000);
  const activityFreshAfter = new Date(now.getTime() - 2 * 60_000);
  /*
   * Phase 7E.4 §3 — default Trending is ELIGIBLE only. Only an ELIGIBLE token is given a score at
   * all, so this condition is belt and braces rather than the only thing standing between a shell
   * and the front page. Solana never reaches this: planChains excluded it above.
   */
  if (lifecycle === "trending" || sort === "trending") conds.push(Prisma.sql`
    s."trendingScore" > 0 AND s.status = 'OK' AND s."riskClassification" = 'ELIGIBLE'
    AND s."blockTimestamp" >= ${marketFreshAfter} AND s."trendingComputedAt" >= ${activityFreshAfter}`);
  const marketFiltered = [filters.fdvMin, filters.fdvMax, filters.liquidityMin, filters.liquidityMax].some((v) => v !== undefined);
  const activityFiltered = [filters.volume5mMin, filters.volume1hMin, filters.txns1hMin, filters.buys1hMin, filters.sells1hMin, filters.traders1hMin].some((v) => v !== undefined);
  if (marketFiltered) conds.push(Prisma.sql`s.status = 'OK' AND s."blockTimestamp" >= ${marketFreshAfter}`);
  // Activity windows are fresh when the chain's own pass computed them recently: Robinhood's Trending
  // pass, or Solana's activity pass (which never sets trendingComputedAt).
  if (activityFiltered) conds.push(Prisma.sql`COALESCE(s."trendingComputedAt", s."activityComputedAt") >= ${activityFreshAfter}`);
  const numericFilters: Array<[string | number | undefined, Prisma.Sql, "min" | "max"]> = [
    [filters.fdvMin, Prisma.sql`s."marketCapUsd"`, "min"], [filters.fdvMax, Prisma.sql`s."marketCapUsd"`, "max"],
    [filters.liquidityMin, Prisma.sql`s."liquidityUsd"`, "min"], [filters.liquidityMax, Prisma.sql`s."liquidityUsd"`, "max"],
    [filters.volume5mMin, Prisma.sql`s."volume5mUsd"`, "min"], [filters.volume1hMin, Prisma.sql`s."volume1hUsd"`, "min"],
    [filters.txns1hMin, Prisma.sql`s."trades1h"`, "min"], [filters.buys1hMin, Prisma.sql`s."buys1h"`, "min"],
    [filters.sells1hMin, Prisma.sql`s."sells1h"`, "min"], [filters.traders1hMin, Prisma.sql`s."traders1h"`, "min"],
  ];
  for (const [value, column, bound] of numericFilters) if (value !== undefined) {
    conds.push(bound === "min" ? Prisma.sql`${column} >= ${String(value)}::numeric` : Prisma.sql`${column} <= ${String(value)}::numeric`);
  }
  if (q) {
    if (EVM_ADDRESS_PREFIX.test(q)) conds.push(Prisma.sql`d.chain = 'robinhood' AND d."tokenAddress" LIKE ${q.toLowerCase() + "%"}`);
    // §15 — a full mint finds its token whether or not its metadata ever resolved. Case-sensitive.
    else if (SOLANA_MINT.test(q)) conds.push(Prisma.sql`d.chain = 'solana' AND d."tokenAddress" = ${q}`);
    else conds.push(Prisma.sql`(d.name ILIKE ${"%" + q.replace(/[\\%_]/g, "\\$&") + "%"} OR d.symbol ILIKE ${"%" + q.replace(/[\\%_]/g, "\\$&") + "%"})`);
  }

  // Solana-only value orderings compare whole SOL, and only across SOL-quoted rows.
  const solValue = (column: Prisma.Sql) =>
    Prisma.sql`CASE WHEN s."quoteAddress" IN (${Prisma.join(SOL_QUOTE_ADDRESSES)}) THEN ${column} / power(10::numeric, s."quoteDecimals") END`;
  const order = {
    new: Prisma.sql`d."observedAt" DESC, d."tokenAddress" DESC`,
    marketCap: solanaOnly ? Prisma.sql`${solValue(Prisma.sql`s."marketCapQuote"`)} DESC NULLS LAST, d."observedAt" DESC, d."tokenAddress" DESC` : Prisma.sql`s."marketCapUsd" DESC NULLS LAST, d."observedAt" DESC, d."tokenAddress" DESC`,
    liquidity: solanaOnly ? Prisma.sql`${solValue(Prisma.sql`s."liquidityQuote"`)} DESC NULLS LAST, d."observedAt" DESC, d."tokenAddress" DESC` : Prisma.sql`s."liquidityUsd" DESC NULLS LAST, d."observedAt" DESC, d."tokenAddress" DESC`,
    progress: Prisma.sql`s."bondingProgressBps" DESC NULLS LAST, s."quoteRaised" DESC NULLS LAST, d."observedAt" DESC, d."tokenAddress" DESC`,
    change1h: Prisma.sql`s."marketCapChange1hUsd" DESC NULLS LAST, d."observedAt" DESC, d."tokenAddress" DESC`,
    volume1h: solanaOnly ? Prisma.sql`${solValue(Prisma.sql`s."volume1hQuote"`)} DESC NULLS LAST, d."observedAt" DESC, d."tokenAddress" DESC` : Prisma.sql`s."volume1hUsd" DESC NULLS LAST, d."observedAt" DESC, d."tokenAddress" DESC`,
    trending: Prisma.sql`s."trendingScore" DESC NULLS LAST, s."volume1hUsd" DESC NULLS LAST, d."observedAt" DESC, d."tokenAddress" DESC`,
  }[sort];

  // "new" pages by time so rows discovered meanwhile don't shift pages; other orders page by offset.
  const where = Prisma.join(conds, " AND ");
  let offset = 0;
  const pageConds = [...conds];
  if (cursor) {
    if (sort === "new") {
      const [at, address] = (cursor.startsWith("t:") ? cursor.slice(2) : cursor).split("|");
      if (Number.isNaN(Date.parse(at)) || (address !== undefined && !CURSOR_ADDRESS.test(address))) throw new TokenListError("invalid cursor");
      pageConds.push(address === undefined ? Prisma.sql`d."observedAt" < ${new Date(at)}` : Prisma.sql`(d."observedAt", d."tokenAddress") < (${new Date(at)}, ${address})`);
    } else {
      const m = /^o:(\d{1,6})$/.exec(cursor);
      if (!m) throw new TokenListError("invalid cursor");
      offset = Number(m[1]);
    }
  }
  const from = Prisma.sql`FROM "DiscoveredToken" d LEFT JOIN "TokenMarketSnapshot" s ON s.chain = d.chain AND s."tokenAddress" = d."tokenAddress"`;
  const [ids, counted] = await Promise.all([
    db.$queryRaw<Array<{ chain: string; tokenAddress: string; observedAt: Date }>>`SELECT d.chain, d."tokenAddress", d."observedAt" ${from} WHERE ${Prisma.join(pageConds, " AND ")} ORDER BY ${order} OFFSET ${offset} LIMIT ${limit}`,
    db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n ${from} WHERE ${where}`,
  ]);
  const found = await db.discoveredToken.findMany({
    where: { OR: included.map((chain) => ({ chain, tokenAddress: { in: ids.filter((r) => r.chain === chain).map((r) => r.tokenAddress) } })) },
  });
  const byKey = new Map(found.map((r) => [`${r.chain}|${r.tokenAddress}`, r]));
  const rows = ids.map((r) => byKey.get(`${r.chain}|${r.tokenAddress}`)).filter((r): r is DiscoveredToken => Boolean(r));

  const last = ids[ids.length - 1];
  const nextCursor = ids.length < limit || !last ? null : sort === "new" ? `t:${last.observedAt.toISOString()}|${last.tokenAddress}` : `o:${offset + ids.length}`;

  return {
    ...(lifecycle === "trending" ? { trending: trending ?? unavailableTrending(now) } : {}),
    tokens: await serializeTokens(db, rows),
    nextCursor,
    total: Number(counted[0]?.n ?? 0),
    chains: included,
    excludedChains: excluded,
    observedAt: now.toISOString(),
  };
}

function unavailableTrending(now: Date) {
  return { available: false, basis: "TRADE_VOLUME" as const, indexedUntil: null, lagSeconds: null, reason: SOLANA_NO_TRENDING, computedAt: now.toISOString() };
}
