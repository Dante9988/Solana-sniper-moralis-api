/**
 * Phase 7D.4 — ranked market lists (Crypto, Stocks) from CoinGecko.
 *
 * Source: CoinGecko API v3 `/coins/markets` (https://docs.coingecko.com/v3.0.1/reference/coins-markets,
 * accessed 2026-09-15): `vs_currency=usd`, `order=market_cap_desc`, `per_page` ≤ 250, optional
 * `category`, `price_change_percentage=1h,24h,7d`. Categories verified from `/coins/categories/list`
 * the same day: `robinhood-chain-stocks-ecosystem` (194 coins, matching Robinhood's 194 stock tokens)
 * and `robinhood-chain-meme`. `/asset_platforms` names Robinhood Chain (chain id 4663) `robinhood`,
 * so `/coins/list?include_platform=true` gives each coin's Robinhood Chain contract.
 *
 * The keyless public API worked on 2026-09-15; a demo key (`COINGECKO_DEMO_API_KEY`, header
 * `x-cg-demo-api-key`) raises limits. Responses are cached server-side (one upstream call per list
 * per minute, whatever the traffic) and a stale list is served, flagged, when CoinGecko fails.
 * CoinGecko numbers are floats; they are rendered as plain decimal strings, never exponent form.
 */

export type MarketSegment = "crypto" | "stocks";

export const COINGECKO_CATEGORY: Record<MarketSegment, string | null> = {
  crypto: null,
  stocks: "robinhood-chain-stocks-ecosystem",
};

const BASE = "https://api.coingecko.com/api/v3";
const LIST_TTL_MS = 60_000;
const PLATFORM_TTL_MS = 24 * 3_600_000;
const MAX_STALE_MS = 30 * 60_000;

export interface CoinGeckoMarketRow {
  id: string;
  symbol: string;
  name: string;
  image: string | null;
  current_price: number | null;
  market_cap: number | null;
  market_cap_rank: number | null;
  fully_diluted_valuation: number | null;
  total_volume: number | null;
  price_change_percentage_1h_in_currency?: number | null;
  price_change_percentage_24h_in_currency?: number | null;
  price_change_percentage_7d_in_currency?: number | null;
  price_change_percentage_24h?: number | null;
  circulating_supply: number | null;
  last_updated: string | null;
}

export interface MarketRow {
  rank: number;
  marketCapRank: number | null;
  id: string;
  symbol: string;
  name: string;
  imageUrl: string | null;
  priceUsd: string | null;
  marketCapUsd: string | null;
  fdvUsd: string | null;
  volume24hUsd: string | null;
  change1hPct: string | null;
  change24hPct: string | null;
  change7dPct: string | null;
  circulatingSupply: string | null;
  lastUpdated: string | null;
  robinhoodChainAddress: string | null;
  coingeckoUrl: string;
}

export interface MarketList {
  status: "AVAILABLE" | "UNAVAILABLE";
  segment: MarketSegment;
  page: number;
  perPage: number;
  rows: MarketRow[];
  fetchedAt: string | null;
  stale: boolean;
  reason: string | null;
}

/** A float as a plain decimal string (no exponent), or null. */
export function plainDecimal(n: number | null | undefined): string | null {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  return n.toLocaleString("en-US", { useGrouping: false, maximumSignificantDigits: 17 });
}

export type Fetcher = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export function toMarketRow(r: CoinGeckoMarketRow, index: number, page: number, perPage: number, platforms: Map<string, string>): MarketRow {
  return {
    rank: (page - 1) * perPage + index + 1,
    marketCapRank: r.market_cap_rank ?? null,
    id: r.id,
    symbol: r.symbol.toUpperCase(),
    name: r.name,
    imageUrl: typeof r.image === "string" && r.image.startsWith("https://") ? r.image : null,
    priceUsd: plainDecimal(r.current_price),
    marketCapUsd: plainDecimal(r.market_cap),
    fdvUsd: plainDecimal(r.fully_diluted_valuation),
    volume24hUsd: plainDecimal(r.total_volume),
    change1hPct: plainDecimal(r.price_change_percentage_1h_in_currency),
    change24hPct: plainDecimal(r.price_change_percentage_24h_in_currency ?? r.price_change_percentage_24h),
    change7dPct: plainDecimal(r.price_change_percentage_7d_in_currency),
    circulatingSupply: plainDecimal(r.circulating_supply),
    lastUpdated: r.last_updated,
    robinhoodChainAddress: platforms.get(r.id) ?? null,
    coingeckoUrl: `https://www.coingecko.com/en/coins/${encodeURIComponent(r.id)}`,
  };
}

interface CacheEntry<T> {
  value: T;
  at: number;
}

export function createCoinGeckoClient(options: { apiKey?: string; fetcher?: Fetcher; now?: () => number; timeoutMs?: number } = {}) {
  const fetcher: Fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.apiKey) headers["x-cg-demo-api-key"] = options.apiKey;
  const lists = new Map<string, CacheEntry<CoinGeckoMarketRow[]>>();
  const inflight = new Map<string, Promise<CoinGeckoMarketRow[]>>();
  let platforms: CacheEntry<Map<string, string>> | null = null;
  let platformsInflight: Promise<Map<string, string>> | null = null;

  async function getJson(path: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
    try {
      const res = await fetcher(`${BASE}${path}`, { headers, signal: controller.signal });
      if (!res.ok) throw new Error(`CoinGecko responded ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function robinhoodPlatforms(): Promise<Map<string, string>> {
    if (platforms && now() - platforms.at < PLATFORM_TTL_MS) return platforms.value;
    platformsInflight ??= (async () => {
      try {
        const body = (await getJson("/coins/list?include_platform=true")) as Array<{ id: string; platforms?: Record<string, string | null> }>;
        const map = new Map<string, string>();
        for (const c of body) {
          const addr = c.platforms?.robinhood;
          if (typeof addr === "string" && /^0x[0-9a-fA-F]{40}$/.test(addr)) map.set(c.id, addr.toLowerCase());
        }
        platforms = { value: map, at: now() };
        return map;
      } catch {
        // Addresses are decoration: keep the last map, or none.
        return platforms?.value ?? new Map();
      } finally {
        platformsInflight = null;
      }
    })();
    return platformsInflight;
  }

  async function list(segment: MarketSegment, page: number, perPage: number): Promise<MarketList> {
    const category = COINGECKO_CATEGORY[segment];
    const key = `${segment}:${page}:${perPage}`;
    const cached = lists.get(key);
    const fresh = cached && now() - cached.at < LIST_TTL_MS;
    let rows = fresh ? cached.value : null;
    let stale = false;
    let reason: string | null = null;
    if (!rows) {
      const query = new URLSearchParams({ vs_currency: "usd", order: "market_cap_desc", per_page: String(perPage), page: String(page), price_change_percentage: "1h,24h,7d" });
      if (category) query.set("category", category);
      let pending = inflight.get(key);
      if (!pending) {
        pending = (getJson(`/coins/markets?${query}`) as Promise<CoinGeckoMarketRow[]>).finally(() => inflight.delete(key));
        inflight.set(key, pending);
      }
      try {
        const body = await pending;
        if (!Array.isArray(body)) throw new Error("unexpected CoinGecko response");
        lists.set(key, { value: body, at: now() });
        rows = body;
      } catch (err) {
        reason = err instanceof Error && err.name !== "AbortError" ? err.message : "CoinGecko did not respond in time";
        if (cached && now() - cached.at < MAX_STALE_MS) {
          rows = cached.value;
          stale = true;
        }
      }
    }
    const entry = lists.get(key);
    if (!rows) return { status: "UNAVAILABLE", segment, page, perPage, rows: [], fetchedAt: null, stale: false, reason };
    const map = await robinhoodPlatforms();
    return {
      status: "AVAILABLE",
      segment,
      page,
      perPage,
      rows: rows.map((r, i) => toMarketRow(r, i, page, perPage, map)),
      fetchedAt: entry ? new Date(entry.at).toISOString() : null,
      stale,
      reason: stale ? reason : null,
    };
  }

  return { list };
}

export type CoinGeckoClient = ReturnType<typeof createCoinGeckoClient>;
