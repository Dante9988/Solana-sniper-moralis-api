-- AlterTable
ALTER TABLE "ExecutionIntent" ADD COLUMN     "hookAddress" TEXT,
ADD COLUMN     "poolId" TEXT;

-- AlterTable
ALTER TABLE "ExecutionReceipt" DROP COLUMN "actualOutput",
ADD COLUMN     "grossVenueOutput" DECIMAL(78,0),
ADD COLUMN     "hookFeeAmount" DECIMAL(78,0),
ADD COLUMN     "netWalletOutput" DECIMAL(78,0);

