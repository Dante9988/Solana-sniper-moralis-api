/*
  Warnings:

  - Added the required column `isToken0` to the `DiscoveredToken` table without a default value. This is not possible if the table is not empty.
  - Added the required column `poolFee` to the `DiscoveredToken` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "DiscoveredToken" ADD COLUMN     "isToken0" BOOLEAN NOT NULL,
ADD COLUMN     "poolFee" INTEGER NOT NULL;

-- CreateIndex
CREATE INDEX "DiscoveredToken_chain_poolAddress_idx" ON "DiscoveredToken"("chain", "poolAddress");
