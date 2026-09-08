-- CreateEnum
CREATE TYPE "CandleResolution" AS ENUM ('S1', 'S5', 'S15', 'M1', 'M5', 'M15', 'H1');

-- CreateEnum
CREATE TYPE "CandleStatus" AS ENUM ('PROVISIONAL', 'FINAL');

-- AlterTable
ALTER TABLE "ChainIngestionCheckpoint" ADD COLUMN     "lastHeightTimestamp" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ChainTrade" ADD COLUMN     "sourceTimestamp" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "DiscoveredToken" ADD COLUMN     "quoteDecimals" INTEGER,
ADD COLUMN     "tokenDecimals" INTEGER;

-- CreateTable
CREATE TABLE "MarketCandle" (
    "id" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "venue" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "quoteAddress" TEXT NOT NULL,
    "resolution" "CandleResolution" NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "open" DECIMAL(60,18) NOT NULL,
    "high" DECIMAL(60,18) NOT NULL,
    "low" DECIMAL(60,18) NOT NULL,
    "close" DECIMAL(60,18) NOT NULL,
    "volumeToken" DECIMAL(78,18) NOT NULL,
    "volumeQuote" DECIMAL(78,18) NOT NULL,
    "volumeUsd" DECIMAL(38,8),
    "tradeCount" INTEGER NOT NULL,
    "uniqueTraders" INTEGER NOT NULL,
    "status" "CandleStatus" NOT NULL,
    "firstSourceHeight" BIGINT NOT NULL,
    "lastSourceHeight" BIGINT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketCandle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandleInvalidation" (
    "id" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "invalidatedFromTimestamp" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "CandleInvalidation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandleAggregationCheckpoint" (
    "chain" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "lastSourceHeight" BIGINT NOT NULL,
    "lastSourceIndex" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CandleAggregationCheckpoint_pkey" PRIMARY KEY ("chain","tokenAddress")
);

-- CreateTable
CREATE TABLE "CandleWorkerRunState" (
    "chain" TEXT NOT NULL,
    "lastTickAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "lastTokensProcessed" INTEGER,
    "lastCandlesWritten" INTEGER,
    "lastBucketsRecomputed" INTEGER,
    "lastInvalidationsProcessed" INTEGER,
    "lastTickDurationMs" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CandleWorkerRunState_pkey" PRIMARY KEY ("chain")
);

-- CreateIndex
CREATE INDEX "MarketCandle_chain_tokenAddress_resolution_bucketStart_idx" ON "MarketCandle"("chain", "tokenAddress", "resolution", "bucketStart");

-- CreateIndex
CREATE UNIQUE INDEX "MarketCandle_chain_tokenAddress_resolution_bucketStart_key" ON "MarketCandle"("chain", "tokenAddress", "resolution", "bucketStart");

-- CreateIndex
CREATE INDEX "CandleInvalidation_chain_processedAt_idx" ON "CandleInvalidation"("chain", "processedAt");

-- CreateIndex
CREATE INDEX "CandleInvalidation_chain_tokenAddress_processedAt_idx" ON "CandleInvalidation"("chain", "tokenAddress", "processedAt");

-- CreateIndex
CREATE INDEX "ChainTrade_chain_tokenAddress_canonicalStatus_sourceHeight__idx" ON "ChainTrade"("chain", "tokenAddress", "canonicalStatus", "sourceHeight", "sourceIndex");
