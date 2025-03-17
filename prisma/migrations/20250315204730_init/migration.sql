-- CreateTable
CREATE TABLE "PumpFunToken" (
    "mint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "alerted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "PumpFunToken_pkey" PRIMARY KEY ("mint")
);

-- CreateTable
CREATE TABLE "TokenAlert" (
    "id" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "tokenSymbol" TEXT,
    "tokenName" TEXT,
    "initialMarketCap" DOUBLE PRECISION NOT NULL,
    "initialPrice" DOUBLE PRECISION NOT NULL,
    "bundlePercentage" DOUBLE PRECISION,
    "alertTimestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checked" BOOLEAN NOT NULL DEFAULT false,
    "pnlAlerted" BOOLEAN NOT NULL DEFAULT false,
    "pnlPercentage" DOUBLE PRECISION,
    "currentMarketCap" DOUBLE PRECISION,
    "currentPrice" DOUBLE PRECISION,
    "checkTimestamp" TIMESTAMP(3),

    CONSTRAINT "TokenAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TokenAlert_tokenAddress_idx" ON "TokenAlert"("tokenAddress");

-- CreateIndex
CREATE INDEX "TokenAlert_checked_idx" ON "TokenAlert"("checked");

-- CreateIndex
CREATE INDEX "TokenAlert_alertTimestamp_idx" ON "TokenAlert"("alertTimestamp");
