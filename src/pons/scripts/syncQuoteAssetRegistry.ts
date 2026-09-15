/**
 * Phase 7D.4 §3 — regenerate src/pons/usd/quoteAssetRegistry.robinhood-mainnet.json.
 *
 * Identity comes only from official address lists; a symbol alone never identifies an asset
 * (anyone can deploy a token called "USDG"):
 *   - WETH, USDG: https://docs.robinhood.com/chain/contracts/ (Robinhood Chain docs)
 *   - Stock Tokens: https://api.robinhood.com/rhj/assets (named by
 *     https://docs.robinhood.com/chain/stock-tokens/)
 *   - native ETH: the zero address Pons uses for native-paired launches
 * USD feeds: Chainlink's Robinhood mainnet directory,
 *   https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json
 * matched to an identified asset by the feed's baseAsset. The provider re-checks every feed's
 * description() and decimals() on chain before using it.
 *
 *   npx ts-node src/pons/scripts/syncQuoteAssetRegistry.ts
 */

import { writeFileSync } from "fs";
import path from "path";

const ROBINHOOD_ASSETS_URL = "https://api.robinhood.com/rhj/assets";
const CHAINLINK_FEEDS_URL = "https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json";
const CHAIN_ID = 4663;

/** From https://docs.robinhood.com/chain/contracts/ (accessed 2026-09-15). Decimals re-verified on chain by the provider. */
const DOCS_ASSETS = [
  { address: "0x0bd7d308f8e1639fab988df18a8011f41eacad73", symbol: "WETH", name: "Wrapped Ether", decimals: 18, kind: "wrapped-native", feedBase: "ETH", source: "https://docs.robinhood.com/chain/contracts/" },
  { address: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", symbol: "USDG", name: "Global Dollar", decimals: 6, kind: "stablecoin", feedBase: "USDG", source: "https://docs.robinhood.com/chain/contracts/" },
];

interface ChainlinkFeed {
  name: string;
  proxyAddress: string;
  decimals: number;
  heartbeat: number;
  threshold: number;
  docs?: { baseAsset?: string; quoteAsset?: string; marketHours?: string; assetClass?: string };
}

async function main(): Promise<void> {
  const [assetsRes, feedsRes] = await Promise.all([fetch(ROBINHOOD_ASSETS_URL), fetch(CHAINLINK_FEEDS_URL)]);
  if (!assetsRes.ok || !feedsRes.ok) throw new Error(`fetch failed: assets ${assetsRes.status}, feeds ${feedsRes.status}`);
  const assets = ((await assetsRes.json()) as { assets: Array<{ tokenSymbol: string; tokenName: string; tokenDecimals: number; status: string; isin?: string; deployments: Array<{ contractAddress: string; chainId: number }> }> }).assets;
  const feeds = (await feedsRes.json()) as ChainlinkFeed[];

  // Only feeds quoted in USD, keyed by base asset. Several entries can share a base (e.g. exchange-rate feeds); keep the USD one.
  const usdFeeds = new Map<string, ChainlinkFeed>();
  for (const f of feeds) {
    const base = f.docs?.baseAsset?.toUpperCase();
    if (!base || f.docs?.quoteAsset !== "USD") continue;
    usdFeeds.set(base, f);
  }
  const feedFor = (base: string) => {
    const f = usdFeeds.get(base.toUpperCase());
    return f ? { name: f.name, proxy: f.proxyAddress.toLowerCase(), decimals: f.decimals, heartbeatSec: f.heartbeat, deviationPct: f.threshold, marketHours: f.docs?.marketHours ?? null, basis: base.toUpperCase() } : null;
  };

  const entries = [
    { address: "0x0000000000000000000000000000000000000000", symbol: "ETH", name: "Ether (native)", decimals: 18, kind: "native", source: "Pons V2 TokenLaunched.pairToken == address(0) for native launches", feed: feedFor("ETH") },
    ...DOCS_ASSETS.map(({ feedBase, ...a }) => ({ ...a, feed: feedFor(feedBase) })),
    ...assets.flatMap((a) =>
      a.deployments
        .filter((d) => d.chainId === CHAIN_ID)
        .map((d) => ({
          address: d.contractAddress.toLowerCase(),
          symbol: a.tokenSymbol,
          name: a.tokenName,
          decimals: a.tokenDecimals,
          kind: "stock-token",
          status: a.status,
          isin: a.isin ?? null,
          source: ROBINHOOD_ASSETS_URL,
          feed: feedFor(a.tokenSymbol),
        }))
    ),
  ];

  const out = {
    chainId: CHAIN_ID,
    generatedAt: new Date().toISOString(),
    sources: { robinhoodAssets: ROBINHOOD_ASSETS_URL, robinhoodContracts: "https://docs.robinhood.com/chain/contracts/", chainlinkFeeds: CHAINLINK_FEEDS_URL },
    notes: [
      "Stock-token feeds price one token including its uiMultiplier (https://docs.chain.link/data-feeds/tokenized-equity-feeds/robinhood); they are 24/5 and publish no heartbeat off-hours.",
      "Robinhood docs recommend a sequencer uptime check, but Chainlink does not publish an L2 Sequencer Uptime Feed for Robinhood Chain (https://docs.chain.link/data-feeds/l2-sequencer-feeds, accessed 2026-09-15). The provider uses chain liveness (latest block age) instead.",
    ],
    assets: entries,
  };
  const target = path.join(__dirname, "..", "usd", "quoteAssetRegistry.robinhood-mainnet.json");
  writeFileSync(target, JSON.stringify(out, null, 2) + "\n");
  console.log(`wrote ${entries.length} assets (${entries.filter((e) => e.feed).length} with a USD feed) to ${path.relative(process.cwd(), target)}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
