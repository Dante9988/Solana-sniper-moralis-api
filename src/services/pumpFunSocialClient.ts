import axios from "axios";

/**
 * Read-only pump.fun frontend-API client, extracted from
 * src/discord/discord-pumpfun.ts's inline metadata fetch (that module
 * instantiates a live discord.js Client at import time, so it must never be
 * imported by the intelligence layer). Same endpoint as the original; this
 * single call carries both metadata and socials fields, which is why
 * metadataResearcher and socialResearcher both read from it.
 */

export interface PumpFunFrontendData {
  name?: string;
  symbol?: string;
  image_uri?: string;
  metadata_uri?: string;
  creator?: string;
  created_timestamp?: number;
  website?: string;
  twitter?: string;
  telegram?: string;
  complete?: boolean;
  [key: string]: unknown;
}

export async function fetchPumpFunFrontendData(
  tokenMint: string
): Promise<PumpFunFrontendData | null> {
  try {
    const response = await axios.get<PumpFunFrontendData>(
      `https://frontend-api-v3.pump.fun/coins/${tokenMint}`,
      { timeout: 10000 }
    );
    return response.data ?? null;
  } catch (error) {
    console.error(`pumpFunSocialClient: fetch failed for ${tokenMint}:`, error);
    return null;
  }
}
