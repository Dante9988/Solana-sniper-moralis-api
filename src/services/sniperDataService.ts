export interface SniperAnalysis {
  totalSnipers: number;
  profitableSnipers: number;
  profitablePercentage: number;
  averageProfitPercentage: number;
  totalSnipedUsd: number;
  totalSoldUsd: number;
  totalProfitUsd: number;
  quickestSellBlocksAfter: number | null;
}

/** Moralis retired Solana pair-snipers REST on June 4, 2026. */
export async function fetchSniperData(_tokenMint: string): Promise<SniperAnalysis | null> {
  return null;
}
