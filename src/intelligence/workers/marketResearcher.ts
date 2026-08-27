import { getTokenMarketData, getTokenVolumeAndLiquidity } from "../../services/tokenDataService";
import { TokenDiscoveryEvent, TokenIntelligenceReport, WorkerResult } from "../types";

type MarketResult = TokenIntelligenceReport["market"];

export async function marketResearcher(
  event: TokenDiscoveryEvent
): Promise<WorkerResult<MarketResult>> {
  const errors: string[] = [];
  const pools: unknown[] = [];
  const sources: unknown[] = [];

  const moralisData = await getTokenMarketData(event.mint).catch((err) => {
    errors.push(`Moralis market data failed: ${err}`);
    return null;
  });

  if (!moralisData) {
    return {
      data: { pools, sources },
      errors,
      fatal: "No market data source returned usable data",
    };
  }

  sources.push({ source: "moralis", fetchedAt: new Date().toISOString(), raw: moralisData });

  const data: MarketResult = {
    price: moralisData.price || undefined,
    marketCap: moralisData.marketCap || undefined,
    fdv: moralisData.metadata.fullyDilutedValue
      ? Number(moralisData.metadata.fullyDilutedValue)
      : undefined,
    liquidity: moralisData.liquidity || undefined,
    volume24h: moralisData.volume24h || undefined,
    pools,
    sources,
  };

  // Birdeye enrichment/fallback for volume+liquidity, matching the existing
  // fallback chain pattern used elsewhere in the repo.
  if (!data.volume24h || !data.liquidity) {
    try {
      const birdeye = await getTokenVolumeAndLiquidity(event.mint);
      if (birdeye) {
        sources.push({ source: "birdeye", fetchedAt: new Date().toISOString(), raw: birdeye });
      }
    } catch (err) {
      errors.push(`Birdeye volume/liquidity fallback failed: ${err}`);
    }
  }

  return { data, errors };
}
