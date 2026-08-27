import { TokenMarketData } from "../interfaces/responseDto";
import { fetchBirdeyeWithRetry } from "../utils/apiUtils";
import { getMoralisMetadata, getMoralisPrice, getMoralisSwaps } from "./moralisClient";

const tokenDataCache: Record<string, { data: TokenMarketData; timestamp: number }> = {};
const CACHE_TTL = 15_000;
const PUMPFUN_TOTAL_SUPPLY = 1_000_000_000;

export async function getTokenMarketData(tokenMint: string): Promise<TokenMarketData | null> {
  const cached = tokenDataCache[tokenMint];
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.data;
  const [priceResult, metadataResult] = await Promise.all([getMoralisPrice(tokenMint), getMoralisMetadata(tokenMint)]);
  if (priceResult.status === "UNAVAILABLE" && metadataResult.status === "UNAVAILABLE") return null;
  const priceData = priceResult.status === "AVAILABLE" ? priceResult.data : undefined;
  const metadata = metadataResult.status === "AVAILABLE" ? metadataResult.data : undefined;
  let price = priceData?.usdPrice ?? undefined;
  if (price === undefined || price === null || price <= 0) {
    const swaps = await getMoralisSwaps(tokenMint, 10);
    if (swaps.status === "AVAILABLE") {
      for (const swap of swaps.data.result) {
        if (swap.bought?.address?.toLowerCase() === tokenMint.toLowerCase() && (swap.bought.usdPrice ?? 0) > 0) { price = swap.bought.usdPrice ?? undefined; break; }
        if (swap.sold?.address?.toLowerCase() === tokenMint.toLowerCase() && (swap.sold.usdPrice ?? 0) > 0) { price = swap.sold.usdPrice ?? undefined; break; }
      }
    }
  }
  const isPumpToken = tokenMint.toLowerCase().endsWith("pump");
  const parsedSupply = metadata?.totalSupplyFormatted ? Number(metadata.totalSupplyFormatted) : undefined;
  const totalSupply = isPumpToken ? PUMPFUN_TOTAL_SUPPLY : Number.isFinite(parsedSupply) ? parsedSupply! : 0;
  const numericPrice = price ?? 0;
  const marketCap = numericPrice > 0 && totalSupply > 0 ? numericPrice * totalSupply : 0;
  const tokenData: TokenMarketData = {
    metadata: {
      mint: metadata?.mint ?? tokenMint, standard: metadata?.standard ?? "", name: metadata?.name ?? priceData?.name ?? "Unknown",
      symbol: metadata?.symbol ?? priceData?.symbol ?? "Unknown", logo: metadata?.logo ?? priceData?.logo ?? "", decimals: metadata?.decimals ?? "0",
      metaplex: { metadataUri: metadata?.metaplex?.metadataUri ?? "", masterEdition: metadata?.metaplex?.masterEdition ?? false,
        isMutable: metadata?.metaplex?.isMutable ?? false, sellerFeeBasisPoints: metadata?.metaplex?.sellerFeeBasisPoints ?? 0,
        updateAuthority: metadata?.metaplex?.updateAuthority ?? "", primarySaleHappened: metadata?.metaplex?.primarySaleHappened ?? 0 },
      fullyDilutedValue: metadata?.fullyDilutedValue ?? "0", totalSupply: metadata?.totalSupply ?? String(totalSupply),
      totalSupplyFormatted: metadata?.totalSupplyFormatted ?? String(totalSupply), links: metadata?.links ?? null, description: metadata?.description ?? null,
    },
    price: numericPrice, totalSupply, marketCap, volume24h: 0, liquidity: 0,
    priceChangePercentage24h: priceData?.usdPrice24hrPercentChange ?? 0,
  };
  tokenDataCache[tokenMint] = { data: tokenData, timestamp: Date.now() };
  return tokenData;
}

export function formatPrice(price: number): string {
  if (price >= 1) return `$${price.toFixed(2)}`;
  if (price >= 0.01) return `$${price.toFixed(4)}`;
  if (price >= 0.0001) return `$${price.toFixed(6)}`;
  return `$${price.toExponential(2)}`;
}
export const formatMarketCap = (value: number) => value >= 1_000_000 ? `$${(value / 1_000_000).toFixed(2)}M` : value >= 1_000 ? `$${(value / 1_000).toFixed(2)}K` : `$${value.toFixed(2)}`;
export const formatVolume = formatMarketCap;
export const formatLiquidity = formatMarketCap;
const formatCurrency = (value: number) => `$${(Number.isFinite(value) ? value : 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

export async function getTokenPriceHistory(tokenMint: string): Promise<any> {
  try { return (await fetchBirdeyeWithRetry<any>(`defi/price_history?address=${tokenMint}&type=1H&limit=168`)).data || { items: [] }; }
  catch { return { items: [] }; }
}
export async function getTokenVolumeAndLiquidity(tokenMint: string): Promise<any> {
  try {
    const response = await fetchBirdeyeWithRetry<any>(`defi/token_info?address=${tokenMint}`);
    if (response.data && response.success) return { volume24h: formatCurrency(response.data.volume24h || 0), liquidity: formatCurrency(response.data.liquidity || 0) };
    return { volume24h: "0", liquidity: "0" };
  } catch { return { volume24h: "0", liquidity: "0" }; }
}
export async function fetchLatestPrice(tokenMint: string): Promise<number> {
  try { const response = await fetchBirdeyeWithRetry<any>(`defi/token_price?address=${tokenMint}`); return response.data && response.success ? response.data.value || 0 : 0; }
  catch { return 0; }
}
