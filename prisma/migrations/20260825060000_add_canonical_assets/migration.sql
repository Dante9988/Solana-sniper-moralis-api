-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "normalizedAddress" TEXT NOT NULL,
    "symbol" TEXT,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetObservation" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "observationKey" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "provider" TEXT,
    "priceUsd" DECIMAL(65,30),
    "estimatedBuyPriceUsd" DECIMAL(65,30),
    "estimatedSellPriceUsd" DECIMAL(65,30),
    "liquidityUsd" DECIMAL(65,30),
    "marketCapUsd" DECIMAL(65,30),
    "fdvUsd" DECIMAL(65,30),
    "volume24hUsd" DECIMAL(65,30),
    "rawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetObservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Asset_chainId_normalizedAddress_key" ON "Asset"("chainId", "normalizedAddress");
CREATE INDEX "Asset_chain_idx" ON "Asset"("chain");
CREATE INDEX "Asset_normalizedAddress_idx" ON "Asset"("normalizedAddress");
CREATE UNIQUE INDEX "AssetObservation_assetId_source_observationKey_key" ON "AssetObservation"("assetId", "source", "observationKey");
CREATE INDEX "AssetObservation_assetId_observedAt_idx" ON "AssetObservation"("assetId", "observedAt");
CREATE INDEX "AssetObservation_type_observedAt_idx" ON "AssetObservation"("type", "observedAt");
CREATE INDEX "AssetObservation_source_observedAt_idx" ON "AssetObservation"("source", "observedAt");

-- AddForeignKey
ALTER TABLE "AssetObservation" ADD CONSTRAINT "AssetObservation_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
