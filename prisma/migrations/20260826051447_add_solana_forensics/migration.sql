-- CreateTable
CREATE TABLE "SolanaForensicsJob" (
    "id" TEXT NOT NULL,
    "jobKey" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "eventId" TEXT,
    "discoverySignature" TEXT,
    "discoverySource" TEXT NOT NULL,
    "analysisLevel" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SolanaForensicsJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SolanaForensicsRun" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "analysisLevel" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "runStatus" TEXT NOT NULL,
    "coverageStatus" TEXT NOT NULL,
    "launchSlot" INTEGER,
    "snapshotSlot" INTEGER,
    "initialBundleMetricStatus" TEXT NOT NULL,
    "currentBundleMetricStatus" TEXT NOT NULL,
    "initialBundledAcquisitionPct" DECIMAL(9,4),
    "currentBundleWalletHoldingsPct" DECIMAL(9,4),
    "directDeveloperPct" DECIMAL(9,4),
    "developerClusterPct" DECIMAL(9,4),
    "suspectedCoordinatedPct" DECIMAL(9,4),
    "insiderPct" DECIMAL(9,4),
    "initialSniperAcquisitionPct" DECIMAL(9,4),
    "currentSniperHoldingsPct" DECIMAL(9,4),
    "boundedFreshWalletHoldingsPct" DECIMAL(9,4),
    "rawTop10Pct" DECIMAL(9,4),
    "adjustedTop10Pct" DECIMAL(9,4),
    "largestNonSystemHolderPct" DECIMAL(9,4),
    "holderCount" INTEGER,
    "holderAccountsAnalyzed" INTEGER,
    "transactionsAnalyzed" INTEGER,
    "walletsAnalyzed" INTEGER,
    "estimatedCreditsUsed" INTEGER,
    "requestCount" INTEGER,
    "reachedConfiguredLimit" BOOLEAN NOT NULL DEFAULT false,
    "budgetExhausted" BOOLEAN NOT NULL DEFAULT false,
    "deadlineExceeded" BOOLEAN NOT NULL DEFAULT false,
    "reportJson" JSONB NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SolanaForensicsRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SolanaForensicsEvidence" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "evidenceKey" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "signature" TEXT,
    "slot" INTEGER,
    "wallets" JSONB NOT NULL DEFAULT '[]',
    "amounts" JSONB,
    "retrievedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SolanaForensicsEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SolanaWalletCluster" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "clusterKey" TEXT NOT NULL,
    "classification" TEXT NOT NULL,
    "confidence" DECIMAL(4,3) NOT NULL,
    "reasonCodes" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SolanaWalletCluster_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SolanaWalletClusterMember" (
    "id" TEXT NOT NULL,
    "clusterId" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SolanaWalletClusterMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SolanaTokenEligibilityAssessment" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "eligibility" TEXT NOT NULL,
    "displaySeverity" TEXT NOT NULL,
    "reasonCodes" JSONB NOT NULL DEFAULT '[]',
    "evaluatedMetrics" JSONB NOT NULL DEFAULT '{}',
    "requiredEvidenceComplete" BOOLEAN NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "evaluatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SolanaTokenEligibilityAssessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SolanaForensicsError" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SolanaForensicsError_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SolanaForensicsJob_jobKey_key" ON "SolanaForensicsJob"("jobKey");

-- CreateIndex
CREATE INDEX "SolanaForensicsJob_status_availableAt_idx" ON "SolanaForensicsJob"("status", "availableAt");

-- CreateIndex
CREATE INDEX "SolanaForensicsJob_mint_idx" ON "SolanaForensicsJob"("mint");

-- CreateIndex
CREATE INDEX "SolanaForensicsJob_assetId_idx" ON "SolanaForensicsJob"("assetId");

-- CreateIndex
CREATE INDEX "SolanaForensicsRun_jobId_idx" ON "SolanaForensicsRun"("jobId");

-- CreateIndex
CREATE INDEX "SolanaForensicsRun_assetId_idx" ON "SolanaForensicsRun"("assetId");

-- CreateIndex
CREATE INDEX "SolanaForensicsRun_mint_createdAt_idx" ON "SolanaForensicsRun"("mint", "createdAt");

-- CreateIndex
CREATE INDEX "SolanaForensicsEvidence_runId_category_idx" ON "SolanaForensicsEvidence"("runId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "SolanaForensicsEvidence_runId_evidenceKey_key" ON "SolanaForensicsEvidence"("runId", "evidenceKey");

-- CreateIndex
CREATE INDEX "SolanaWalletCluster_runId_classification_idx" ON "SolanaWalletCluster"("runId", "classification");

-- CreateIndex
CREATE UNIQUE INDEX "SolanaWalletCluster_runId_clusterKey_key" ON "SolanaWalletCluster"("runId", "clusterKey");

-- CreateIndex
CREATE INDEX "SolanaWalletClusterMember_wallet_idx" ON "SolanaWalletClusterMember"("wallet");

-- CreateIndex
CREATE UNIQUE INDEX "SolanaWalletClusterMember_clusterId_wallet_key" ON "SolanaWalletClusterMember"("clusterId", "wallet");

-- CreateIndex
CREATE UNIQUE INDEX "SolanaTokenEligibilityAssessment_runId_key" ON "SolanaTokenEligibilityAssessment"("runId");

-- CreateIndex
CREATE INDEX "SolanaTokenEligibilityAssessment_mint_createdAt_idx" ON "SolanaTokenEligibilityAssessment"("mint", "createdAt");

-- CreateIndex
CREATE INDEX "SolanaTokenEligibilityAssessment_eligibility_idx" ON "SolanaTokenEligibilityAssessment"("eligibility");

-- CreateIndex
CREATE INDEX "SolanaForensicsError_runId_idx" ON "SolanaForensicsError"("runId");

-- AddForeignKey
ALTER TABLE "SolanaForensicsJob" ADD CONSTRAINT "SolanaForensicsJob_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SolanaForensicsRun" ADD CONSTRAINT "SolanaForensicsRun_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "SolanaForensicsJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SolanaForensicsEvidence" ADD CONSTRAINT "SolanaForensicsEvidence_runId_fkey" FOREIGN KEY ("runId") REFERENCES "SolanaForensicsRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SolanaWalletCluster" ADD CONSTRAINT "SolanaWalletCluster_runId_fkey" FOREIGN KEY ("runId") REFERENCES "SolanaForensicsRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SolanaWalletClusterMember" ADD CONSTRAINT "SolanaWalletClusterMember_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "SolanaWalletCluster"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SolanaTokenEligibilityAssessment" ADD CONSTRAINT "SolanaTokenEligibilityAssessment_runId_fkey" FOREIGN KEY ("runId") REFERENCES "SolanaForensicsRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SolanaForensicsError" ADD CONSTRAINT "SolanaForensicsError_runId_fkey" FOREIGN KEY ("runId") REFERENCES "SolanaForensicsRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
