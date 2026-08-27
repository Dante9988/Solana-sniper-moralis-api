import { Asset, AssetObservation, Prisma } from "@prisma/client";
import { prisma } from "../services/prismaClient";
import { resolveAsset } from "./assetResolver";
import { validateResearchObservation } from "./marketObservation";
import { AssetIdentity, ResearchAssetObservation } from "./types";

export class AssetStoreValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetStoreValidationError";
  }
}

function validateIdentity(identity: AssetIdentity): void {
  const resolved = resolveAsset({ address: identity.address, chain: identity.chain });
  if (resolved.status !== "RESOLVED") {
    const reason = "reason" in resolved ? resolved.reason : `Unexpected resolution status: ${resolved.status}`;
    throw new AssetStoreValidationError(`Invalid canonical asset identity: ${reason}`);
  }
  if (resolved.asset.chainId !== identity.chainId || resolved.asset.normalizedAddress !== identity.normalizedAddress) {
    throw new AssetStoreValidationError("Asset chainId or normalizedAddress does not match canonical resolution");
  }
}

export async function upsertAsset(identity: AssetIdentity): Promise<Asset> {
  validateIdentity(identity);
  const metadata = {
    ...(identity.symbol === undefined ? {} : { symbol: identity.symbol }),
    ...(identity.name === undefined ? {} : { name: identity.name }),
  };
  return prisma.asset.upsert({
    where: { chainId_normalizedAddress: { chainId: identity.chainId, normalizedAddress: identity.normalizedAddress } },
    create: {
      chain: identity.chain,
      chainId: identity.chainId,
      address: identity.address,
      normalizedAddress: identity.normalizedAddress,
      ...metadata,
    },
    update: { address: identity.address, ...metadata },
  });
}

export async function saveResearchObservation(
  identity: AssetIdentity,
  observation: ResearchAssetObservation
): Promise<AssetObservation> {
  validateIdentity(identity);
  validateResearchObservation(observation);
  const asset = await upsertAsset(identity);
  const values = {
    type: observation.type,
    observedAt: observation.observedAt,
    provider: observation.provider,
    priceUsd: observation.priceUsd,
    estimatedBuyPriceUsd: observation.estimatedBuyPriceUsd,
    estimatedSellPriceUsd: observation.estimatedSellPriceUsd,
    liquidityUsd: observation.liquidityUsd,
    marketCapUsd: observation.marketCapUsd,
    fdvUsd: observation.fdvUsd,
    volume24hUsd: observation.volume24hUsd,
    rawPayload: observation.rawPayload as Prisma.InputJsonValue | undefined,
  };
  return prisma.assetObservation.upsert({
    where: {
      assetId_source_observationKey: {
        assetId: asset.id,
        source: observation.source,
        observationKey: observation.observationKey,
      },
    },
    create: {
      assetId: asset.id,
      source: observation.source,
      observationKey: observation.observationKey,
      ...values,
    },
    update: values,
  });
}
