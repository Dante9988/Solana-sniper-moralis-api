-- AlterTable
ALTER TABLE "TokenMarketSnapshot" ADD COLUMN     "buys1h" INTEGER,
ADD COLUMN     "sells1h" INTEGER,
ADD COLUMN     "traders1h" INTEGER,
ADD COLUMN     "trades1h" INTEGER,
ADD COLUMN     "trendingComputedAt" TIMESTAMP(3),
ADD COLUMN     "trendingScore" DECIMAL(38,6),
ADD COLUMN     "volume1hUsd" DECIMAL(38,6),
ADD COLUMN     "volume5mUsd" DECIMAL(38,6),
ADD COLUMN     "volumeBaselineHourlyUsd" DECIMAL(38,6),
ADD COLUMN     "volumeSurge" DECIMAL(20,6);

-- CreateIndex
CREATE INDEX "TokenMarketSnapshot_chain_trendingScore_idx" ON "TokenMarketSnapshot"("chain", "trendingScore");
