-- AlterTable
ALTER TABLE "SolanaForensicsRun" ADD COLUMN     "reconciledAt" TIMESTAMP(3),
ADD COLUMN     "reconciliationAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reconciliationError" TEXT,
ADD COLUMN     "reconciliationStatus" TEXT NOT NULL DEFAULT 'PENDING';

-- AlterTable
ALTER TABLE "TokenIntelligenceReport" ADD COLUMN     "forensicsAdjustedTop10HoldingsPct" DECIMAL(9,4),
ADD COLUMN     "forensicsAnalysisLevel" TEXT,
ADD COLUMN     "forensicsCompletedAt" TIMESTAMP(3),
ADD COLUMN     "forensicsCurrentBundleWalletHoldingsPct" DECIMAL(9,4),
ADD COLUMN     "forensicsDeveloperClusterHoldingsPct" DECIMAL(9,4),
ADD COLUMN     "forensicsDisplaySeverity" TEXT,
ADD COLUMN     "forensicsEligibility" TEXT,
ADD COLUMN     "forensicsInitialBundledAcquisitionPct" DECIMAL(9,4),
ADD COLUMN     "forensicsInsiderHoldingsPct" DECIMAL(9,4),
ADD COLUMN     "forensicsJobId" TEXT,
ADD COLUMN     "forensicsPolicyVersion" TEXT,
ADD COLUMN     "forensicsReasonCodes" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "forensicsReconciledAt" TIMESTAMP(3),
ADD COLUMN     "forensicsRequiredEvidenceComplete" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "forensicsRunId" TEXT,
ADD COLUMN     "forensicsSniperHoldingsPct" DECIMAL(9,4),
ADD COLUMN     "forensicsStatus" TEXT NOT NULL DEFAULT 'NOT_REQUESTED',
ADD COLUMN     "forensicsSuspectedCoordinatedHoldingsPct" DECIMAL(9,4);

-- CreateIndex
CREATE INDEX "SolanaForensicsRun_reconciliationStatus_idx" ON "SolanaForensicsRun"("reconciliationStatus");

-- CreateIndex
CREATE INDEX "TokenIntelligenceReport_forensicsStatus_idx" ON "TokenIntelligenceReport"("forensicsStatus");

-- CreateIndex
CREATE INDEX "TokenIntelligenceReport_forensicsRunId_idx" ON "TokenIntelligenceReport"("forensicsRunId");
