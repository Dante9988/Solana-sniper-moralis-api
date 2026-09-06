-- CreateTable
CREATE TABLE "PumpLifecycleEvent" (
    "id" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "emittingProgram" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "outerInstructionIndex" INTEGER NOT NULL,
    "innerPosition" INTEGER NOT NULL,
    "slot" BIGINT NOT NULL,
    "outerTxPosition" INTEGER,
    "blockTime" TIMESTAMP(3) NOT NULL,
    "eventTime" TIMESTAMP(3),
    "payloadVersion" INTEGER NOT NULL DEFAULT 1,
    "payload" JSONB NOT NULL,
    "poolAddress" TEXT,
    "bondingCurveAddress" TEXT,
    "status" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PumpLifecycleEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TokenLifecycleState" (
    "mint" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "bondingCurve" TEXT,
    "pumpswapPool" TEXT,
    "lastEventId" TEXT NOT NULL,
    "lastEventSlot" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TokenLifecycleState_pkey" PRIMARY KEY ("mint")
);

-- CreateTable
CREATE TABLE "PumpTrade" (
    "id" TEXT NOT NULL,
    "venue" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "quoteMint" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "outerInstructionIndex" INTEGER NOT NULL,
    "innerPosition" INTEGER NOT NULL,
    "emittingProgram" TEXT NOT NULL,
    "slot" BIGINT NOT NULL,
    "outerTxPosition" INTEGER,
    "blockTime" TIMESTAMP(3) NOT NULL,
    "eventTime" TIMESTAMP(3),
    "side" TEXT NOT NULL,
    "tokenAmount" DECIMAL(24,0) NOT NULL,
    "quoteAmount" DECIMAL(24,0) NOT NULL,
    "trader" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PumpTrade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PumpCandle" (
    "mint" TEXT NOT NULL,
    "resolution" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "open" DECIMAL(38,18) NOT NULL,
    "high" DECIMAL(38,18) NOT NULL,
    "low" DECIMAL(38,18) NOT NULL,
    "close" DECIMAL(38,18) NOT NULL,
    "volumeToken" DECIMAL(24,0) NOT NULL,
    "volumeQuote" DECIMAL(24,0) NOT NULL,
    "volumeUsd" DECIMAL(24,8),
    "trades" INTEGER NOT NULL,
    "uniqueTraders" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PumpCandle_pkey" PRIMARY KEY ("mint","resolution","startTime")
);

-- CreateTable
CREATE TABLE "PumpCandleRevision" (
    "id" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "resolution" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "sequence" BIGSERIAL NOT NULL,
    "revisionStatus" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PumpCandleRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SolUsdRate" (
    "id" TEXT NOT NULL,
    "feedId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "publishTime" TIMESTAMP(3) NOT NULL,
    "retrievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rawPrice" BIGINT NOT NULL,
    "exponent" INTEGER NOT NULL,
    "normalizedRate" DECIMAL(20,8) NOT NULL,
    "providerStatus" TEXT,
    "supersedesId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "SolUsdRate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PumpLifecycleEvent_mint_slot_outerTxPosition_outerInstructi_idx" ON "PumpLifecycleEvent"("mint", "slot", "outerTxPosition", "outerInstructionIndex", "innerPosition");

-- CreateIndex
CREATE UNIQUE INDEX "PumpLifecycleEvent_signature_outerInstructionIndex_innerPos_key" ON "PumpLifecycleEvent"("signature", "outerInstructionIndex", "innerPosition", "emittingProgram");

-- CreateIndex
CREATE INDEX "PumpTrade_mint_blockTime_idx" ON "PumpTrade"("mint", "blockTime");

-- CreateIndex
CREATE INDEX "PumpTrade_mint_slot_outerTxPosition_idx" ON "PumpTrade"("mint", "slot", "outerTxPosition");

-- CreateIndex
CREATE UNIQUE INDEX "PumpTrade_signature_outerInstructionIndex_innerPosition_emi_key" ON "PumpTrade"("signature", "outerInstructionIndex", "innerPosition", "emittingProgram");

-- CreateIndex
CREATE INDEX "PumpCandleRevision_mint_resolution_sequence_idx" ON "PumpCandleRevision"("mint", "resolution", "sequence");

-- CreateIndex
CREATE INDEX "SolUsdRate_provider_publishTime_idx" ON "SolUsdRate"("provider", "publishTime");

-- CreateIndex
CREATE INDEX "SolUsdRate_feedId_publishTime_idx" ON "SolUsdRate"("feedId", "publishTime");
