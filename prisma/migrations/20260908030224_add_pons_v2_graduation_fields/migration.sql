-- AlterTable
ALTER TABLE "DiscoveredToken" ADD COLUMN     "curveAddress" TEXT,
ADD COLUMN     "graduationPairTokenAmount" DECIMAL(78,0),
ADD COLUMN     "graduationPositionId" DECIMAL(78,0),
ADD COLUMN     "graduationSourceHash" TEXT,
ADD COLUMN     "graduationSourceHeight" BIGINT,
ADD COLUMN     "graduationSourceTxHash" TEXT,
ADD COLUMN     "graduationTokenAmount" DECIMAL(78,0);
