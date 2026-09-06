-- CreateEnum
CREATE TYPE "ChainFactStatus" AS ENUM ('CANONICAL', 'ORPHANED');

-- CreateEnum
CREATE TYPE "EnrichmentStatus" AS ENUM ('COMPLETE', 'PENDING');

-- AlterTable
ALTER TABLE "ChainIngestionCheckpoint" ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "lastErrorAt" TIMESTAMP(3),
ADD COLUMN     "lastObservedChainHeight" BIGINT,
ADD COLUMN     "lastPollAt" TIMESTAMP(3),
ADD COLUMN     "lastReorgAt" TIMESTAMP(3),
ADD COLUMN     "lastSuccessAt" TIMESTAMP(3),
ADD COLUMN     "reorgUnresolvedAt" TIMESTAMP(3),
ADD COLUMN     "reorgUnresolvedReason" TEXT;

-- AlterTable
ALTER TABLE "ChainTrade" ADD COLUMN     "canonicalStatus" "ChainFactStatus" NOT NULL DEFAULT 'CANONICAL',
ADD COLUMN     "orphanedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "DiscoveredToken" ADD COLUMN     "canonicalStatus" "ChainFactStatus" NOT NULL DEFAULT 'CANONICAL',
ADD COLUMN     "enrichmentAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "enrichmentStatus" "EnrichmentStatus" NOT NULL DEFAULT 'COMPLETE',
ADD COLUMN     "lastEnrichmentAttemptAt" TIMESTAMP(3),
ADD COLUMN     "lastEnrichmentError" TEXT,
ADD COLUMN     "orphanedAt" TIMESTAMP(3),
ALTER COLUMN "supply" DROP NOT NULL,
ALTER COLUMN "isToken0" DROP NOT NULL,
ALTER COLUMN "poolFee" DROP NOT NULL;

-- CreateTable
CREATE TABLE "ChainBlockCheckpoint" (
    "chain" TEXT NOT NULL,
    "height" BIGINT NOT NULL,
    "hash" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChainBlockCheckpoint_pkey" PRIMARY KEY ("chain","height")
);

-- CreateIndex
CREATE INDEX "ChainBlockCheckpoint_chain_height_idx" ON "ChainBlockCheckpoint"("chain", "height");

-- CreateIndex
CREATE INDEX "ChainTrade_chain_canonicalStatus_sourceHeight_idx" ON "ChainTrade"("chain", "canonicalStatus", "sourceHeight");

-- CreateIndex
CREATE INDEX "DiscoveredToken_chain_canonicalStatus_sourceHeight_idx" ON "DiscoveredToken"("chain", "canonicalStatus", "sourceHeight");

-- CreateIndex
CREATE INDEX "DiscoveredToken_chain_enrichmentStatus_sourceHeight_idx" ON "DiscoveredToken"("chain", "enrichmentStatus", "sourceHeight");
