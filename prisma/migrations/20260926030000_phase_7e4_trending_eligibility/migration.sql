-- AlterTable
ALTER TABLE "TokenMarketSnapshot" ADD COLUMN     "liquidityRatioBps" INTEGER,
ADD COLUMN     "riskClassification" TEXT,
ADD COLUMN     "riskReasons" JSONB,
ADD COLUMN     "scoreComponents" JSONB,
ADD COLUMN     "valuationBasis" TEXT;

