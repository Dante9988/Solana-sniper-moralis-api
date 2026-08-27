import { Connection, PublicKey } from "@solana/web3.js";
import { getTokenMarketData } from "../../services/tokenDataService";
import { fetchPumpFunFrontendData } from "../../services/pumpFunSocialClient";
import { verifyPumpFunMigration } from "../../services/pumpswapService";
import { TokenDiscoveryEvent, TokenIntelligenceReport, WorkerResult } from "../types";

type MetadataResult = TokenIntelligenceReport["token"];

export async function metadataResearcher(
  event: TokenDiscoveryEvent
): Promise<WorkerResult<MetadataResult>> {
  const errors: string[] = [];
  const data: MetadataResult = {};

  const [moralisResult, pumpFunResult] = await Promise.allSettled([
    getTokenMarketData(event.mint),
    fetchPumpFunFrontendData(event.mint),
  ]);

  if (moralisResult.status === "fulfilled" && moralisResult.value) {
    const meta = moralisResult.value.metadata;
    data.name = meta.name !== "Unknown" ? meta.name : undefined;
    data.symbol = meta.symbol !== "Unknown" ? meta.symbol : undefined;
    data.imageUrl = meta.logo || undefined;
    data.metadataUri = meta.metaplex?.metadataUri || undefined;
  } else {
    errors.push("Moralis metadata unavailable");
    if (moralisResult.status === "rejected") {
      errors.push(`Moralis error: ${moralisResult.reason}`);
    }
  }

  if (pumpFunResult.status === "fulfilled" && pumpFunResult.value) {
    const p = pumpFunResult.value;
    data.name = data.name ?? p.name;
    data.symbol = data.symbol ?? p.symbol;
    data.imageUrl = data.imageUrl ?? p.image_uri;
    data.creator = p.creator;
    if (p.created_timestamp) {
      data.creationTime = new Date(p.created_timestamp);
    }
  } else {
    errors.push("pump.fun frontend metadata unavailable");
  }

  // On-chain corroboration for pool/migration events only — a plain new-mint
  // discovery has no pool/bonding-curve state worth checking yet.
  if (event.source === "PUMPSWAP" || event.source === "MIGRATION") {
    try {
      const heliusRpc = process.env.HELIUS_HTTPS_URI;
      if (heliusRpc) {
        const connection = new Connection(heliusRpc);
        const mintPubkey = new PublicKey(event.mint);
        const logs = Array.isArray((event.rawPayload as any)?.logs)
          ? ((event.rawPayload as any).logs as string[])
          : [];
        if (logs.length > 0) {
          const migrationVerified = await verifyPumpFunMigration(connection, logs, mintPubkey);
          if (!migrationVerified) {
            errors.push("On-chain migration verification did not confirm bonding curve completion");
          }
        }
      }
    } catch (err) {
      errors.push(`On-chain metadata corroboration failed: ${err}`);
    }
  }

  if (!data.name && !data.symbol) {
    return {
      data,
      errors,
      fatal: "No metadata source returned usable token identity",
    };
  }

  return { data, errors };
}
