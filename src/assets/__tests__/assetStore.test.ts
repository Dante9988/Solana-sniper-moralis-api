import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ assetUpsert: vi.fn(), observationUpsert: vi.fn() }));
vi.mock("../../services/prismaClient", () => ({
  prisma: { asset: { upsert: mocks.assetUpsert }, assetObservation: { upsert: mocks.observationUpsert } },
}));

import { resolveAsset } from "../assetResolver";
import { saveResearchObservation, upsertAsset } from "../assetStore";
import { AssetIdentity, ResearchAssetObservation } from "../types";

const EVM_ADDRESS = `0xAb${"0".repeat(38)}`;
const identity = (chain: "ETHEREUM" | "BNB_SMART_CHAIN"): AssetIdentity => {
  const result = resolveAsset({ address: EVM_ADDRESS, chain });
  if (result.status !== "RESOLVED") throw new Error("fixture failed");
  return result.asset;
};
const observation = (observationKey = "provider:event:1", observedAt = new Date("2026-08-25T00:00:00Z")): ResearchAssetObservation => ({
  type: "MARKET", source: "provider-feed", observationKey, observedAt, priceUsd: 1,
});

beforeEach(() => {
  mocks.assetUpsert.mockReset(); mocks.observationUpsert.mockReset();
  mocks.assetUpsert.mockImplementation(({ create }: any) => Promise.resolve({ id: `${create.chainId}:asset`, ...create }));
  mocks.observationUpsert.mockImplementation(({ create }: any) => Promise.resolve({ id: `${create.assetId}:${create.observationKey}`, ...create }));
});

describe("assetStore", () => {
  it("upserts canonical assets by chainId and normalizedAddress, never metadata", async () => {
    const asset = identity("ETHEREUM");
    await upsertAsset({ ...asset, symbol: "TOKEN", name: "Token" });
    expect(mocks.assetUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { chainId_normalizedAddress: { chainId: "1", normalizedAddress: EVM_ADDRESS.toLowerCase() } },
    }));
  });

  it("keeps the same EVM address distinct across Ethereum and BNB", async () => {
    await upsertAsset(identity("ETHEREUM")); await upsertAsset(identity("BNB_SMART_CHAIN"));
    expect(mocks.assetUpsert.mock.calls[0][0].where.chainId_normalizedAddress.chainId).toBe("1");
    expect(mocks.assetUpsert.mock.calls[1][0].where.chainId_normalizedAddress.chainId).toBe("56");
  });

  it("uses assetId + source + observationKey for retry idempotency", async () => {
    const asset = identity("ETHEREUM");
    const first = await saveResearchObservation(asset, observation());
    const retry = await saveResearchObservation(asset, observation("provider:event:1", new Date("2026-08-25T00:05:00Z")));
    expect(first.id).toBe(retry.id);
    expect(mocks.observationUpsert.mock.calls[0][0].where).toEqual(mocks.observationUpsert.mock.calls[1][0].where);
  });

  it("allows equal timestamps when stable observation keys differ", async () => {
    const asset = identity("ETHEREUM"); const timestamp = new Date("2026-08-25T00:00:00Z");
    const first = await saveResearchObservation(asset, observation("event:1", timestamp));
    const second = await saveResearchObservation(asset, observation("event:2", timestamp));
    expect(first.id).not.toBe(second.id);
  });

  it("rejects POSITION and does not call Prisma observation persistence", async () => {
    await expect(saveResearchObservation(identity("ETHEREUM"), { ...observation(), type: "POSITION" } as any)).rejects.toThrow("POSITION");
    expect(mocks.observationUpsert).not.toHaveBeenCalled();
  });

  it("propagates Prisma errors instead of reporting success", async () => {
    mocks.assetUpsert.mockRejectedValue(new Error("database unavailable"));
    await expect(saveResearchObservation(identity("ETHEREUM"), observation())).rejects.toThrow("database unavailable");
  });
});
