-- AlterTable
ALTER TABLE "TokenIntelligenceReport"
ADD COLUMN     "aiPositiveSignals" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "aiRiskFactors" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "aiDataQualityWarnings" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "aiProvider" TEXT,
ADD COLUMN     "aiModel" TEXT,
ADD COLUMN     "aiPromptVersion" TEXT,
ADD COLUMN     "aiSchemaVersion" TEXT,
ADD COLUMN     "aiLatencyMs" INTEGER,
ADD COLUMN     "aiInputTokens" INTEGER,
ADD COLUMN     "aiOutputTokens" INTEGER,
ADD COLUMN     "aiCompletedAt" TIMESTAMP(3),
ADD COLUMN     "aiValidationStatus" TEXT,
ADD COLUMN     "aiFailureReason" TEXT;
