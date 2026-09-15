import { describe, expect, it } from "vitest";

import { createCoinGeckoClient, plainDecimal, type Fetcher } from "../coingecko";

const BTC = { id: "bitcoin", symbol: "btc", name: "Bitcoin", image: "https://coin-images.coingecko.com/coins/images/1/large/bitcoin.png", current_price: 76341, market_cap: 1532590746900, market_cap_rank: 1, fully_diluted_valuation: 1532592425637, total_volume: 32790189647, price_change_percentage_24h_in_currency: -2.80079, price_change_percentage_1h_in_currency: 0.1, price_change_percentage_7d_in_currency: 3, circulating_supply: 20084731, last_updated: "2026-09-15T14:19:10.000Z" };
const SPY = { ...BTC, id: "spdr-s-p-500-etf-trust-robinhood-tokenized-stock", symbol: "spy", name: "SPY", current_price: 758.39, market_cap: 25000003, market_cap_rank: 900 };
const TINY = { ...BTC, id: "tiny", current_price: 0.000000012345, image: "javascript:alert(1)" };

function scripted() {
  const calls: string[] = [];
  let fail = false;
  const fetcher: Fetcher = async (url, init) => {
    calls.push(url + (init.headers["x-cg-demo-api-key"] ? " [key]" : ""));
    if (fail) return { ok: false, status: 429, json: async () => ({}) };
    if (url.includes("/coins/list")) return { ok: true, status: 200, json: async () => [{ id: SPY.id, platforms: { robinhood: "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD", ethereum: "0x1" } }, { id: "bitcoin", platforms: {} }] };
    const category = new URL(url).searchParams.get("category");
    return { ok: true, status: 200, json: async () => (category === "robinhood-chain-stocks-ecosystem" ? [SPY] : [BTC, TINY]) };
  };
  return { calls, fetcher, setFail: (v: boolean) => (fail = v) };
}

describe("CoinGecko market lists (Phase 7D.4)", () => {
  it("ranks crypto by market cap and stocks from the Robinhood Chain stocks category, with Robinhood Chain addresses", async () => {
    const s = scripted();
    const cg = createCoinGeckoClient({ fetcher: s.fetcher });
    const crypto = await cg.list("crypto", 1, 50);
    expect(crypto.rows[0]).toMatchObject({ rank: 1, symbol: "BTC", priceUsd: "76341", marketCapUsd: "1532590746900", change24hPct: "-2.80079", robinhoodChainAddress: null });
    expect(s.calls[0]).toContain("order=market_cap_desc");
    expect(s.calls[0]).not.toContain("category=");
    const stocks = await cg.list("stocks", 2, 50);
    expect(stocks.rows[0]).toMatchObject({ rank: 51, symbol: "SPY", robinhoodChainAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" });
    expect(s.calls.some((c) => c.includes("category=robinhood-chain-stocks-ecosystem"))).toBe(true);
  });

  it("never emits exponent notation and drops non-https images", async () => {
    const s = scripted();
    const rows = (await createCoinGeckoClient({ fetcher: s.fetcher }).list("crypto", 1, 50)).rows;
    expect(rows[1].priceUsd).toBe("0.000000012345");
    expect(rows[1].imageUrl).toBeNull();
    expect(plainDecimal(1e21)).toBe("1000000000000000000000");
    expect(plainDecimal(Number.NaN)).toBeNull();
  });

  it("calls upstream once per minute per list, serves a flagged stale list on failure, and reports unavailable with nothing cached", async () => {
    const s = scripted();
    let t = 0;
    const cg = createCoinGeckoClient({ fetcher: s.fetcher, now: () => t, apiKey: "demo" });
    await cg.list("crypto", 1, 50);
    await cg.list("crypto", 1, 50);
    expect(s.calls.filter((c) => c.includes("/coins/markets"))).toHaveLength(1);
    expect(s.calls[0]).toContain("[key]");
    t = 61_000;
    s.setFail(true);
    const stale = await cg.list("crypto", 1, 50);
    expect(stale).toMatchObject({ status: "AVAILABLE", stale: true, reason: "CoinGecko responded 429" });
    const none = await cg.list("stocks", 1, 50);
    expect(none).toMatchObject({ status: "UNAVAILABLE", rows: [] });
  });
});
