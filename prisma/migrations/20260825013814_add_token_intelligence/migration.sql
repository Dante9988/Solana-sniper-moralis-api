-- CreateTable
CREATE TABLE "TokenIntelligenceReport" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "tokenName" TEXT,
    "tokenSymbol" TEXT,
    "tokenImageUrl" TEXT,
    "tokenMetadataUri" TEXT,
    "tokenCreator" TEXT,
    "tokenCreationTime" TIMESTAMP(3),
    "socialWebsite" TEXT,
    "socialTwitter" TEXT,
    "socialTelegram" TEXT,
    "socialDiscord" TEXT,
    "socialFindings" JSONB NOT NULL DEFAULT '[]',
    "marketPrice" DOUBLE PRECISION,
    "marketCap" DOUBLE PRECISION,
    "marketFdv" DOUBLE PRECISION,
    "marketLiquidity" DOUBLE PRECISION,
    "marketVolume24h" DOUBLE PRECISION,
    "marketHolders" INTEGER,
    "marketPools" JSONB NOT NULL DEFAULT '[]',
    "marketSources" JSONB NOT NULL DEFAULT '[]',
    "safetyMintAuthority" TEXT,
    "safetyFreezeAuthority" TEXT,
    "safetyCreatorHoldingsPct" DOUBLE PRECISION,
    "safetyTopHolderConcentrationPct" DOUBLE PRECISION,
    "safetyRugCheck" JSONB,
    "safetySolSniffer" JSONB,
    "safetyRiskFactors" JSONB NOT NULL DEFAULT '[]',
    "safetyConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "bundleSniperPct" DOUBLE PRECISION,
    "bundleBundledPct" DOUBLE PRECISION,
    "bundleFindings" JSONB NOT NULL DEFAULT '[]',
    "bundleConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "aiNarrative" TEXT,
    "aiCategory" TEXT,
    "aiRiskLevel" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "aiConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "aiReasons" JSONB NOT NULL DEFAULT '[]',
    "aiMissingInfo" JSONB NOT NULL DEFAULT '[]',
    "aiRecommendation" TEXT NOT NULL DEFAULT 'RESEARCH_ONLY',
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TokenIntelligenceReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TokenIntelligenceEvidence" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TokenIntelligenceEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TokenIntelligenceError" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "worker" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "fatal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TokenIntelligenceError_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TokenIntelligenceReport_eventId_key" ON "TokenIntelligenceReport"("eventId");

-- CreateIndex
CREATE INDEX "TokenIntelligenceReport_mint_idx" ON "TokenIntelligenceReport"("mint");

-- CreateIndex
CREATE INDEX "TokenIntelligenceReport_status_idx" ON "TokenIntelligenceReport"("status");

-- CreateIndex
CREATE INDEX "TokenIntelligenceReport_createdAt_idx" ON "TokenIntelligenceReport"("createdAt");

-- CreateIndex
CREATE INDEX "TokenIntelligenceEvidence_reportId_idx" ON "TokenIntelligenceEvidence"("reportId");

-- CreateIndex
CREATE INDEX "TokenIntelligenceEvidence_category_idx" ON "TokenIntelligenceEvidence"("category");

-- CreateIndex
CREATE INDEX "TokenIntelligenceError_reportId_idx" ON "TokenIntelligenceError"("reportId");

-- CreateIndex
CREATE INDEX "TokenIntelligenceError_worker_idx" ON "TokenIntelligenceError"("worker");
-- AddForeignKey
ALTER TABLE "TokenIntelligenceEvidence" ADD CONSTRAINT "TokenIntelligenceEvidence_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "TokenIntelligenceReport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TokenIntelligenceError" ADD CONSTRAINT "TokenIntelligenceError_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "TokenIntelligenceReport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
