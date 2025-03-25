-- CreateTable
CREATE TABLE "Wallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "walletPk" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserConfig" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "autoBuy" BOOLEAN NOT NULL DEFAULT false,
    "buyAmount" DOUBLE PRECISION NOT NULL DEFAULT 0.1,
    "takeProfit" DOUBLE PRECISION NOT NULL DEFAULT 50,
    "stopLoss" DOUBLE PRECISION NOT NULL DEFAULT 25,
    "autoSell" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "UserConfig_pkey" PRIMARY KEY ("id")
);

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

-- CreateTable
CREATE TABLE "WalletTransaction" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "tokenMint" TEXT NOT NULL,
    "tokenAmount" DOUBLE PRECISION NOT NULL,
    "solAmount" DOUBLE PRECISION NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "txHash" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL,
    "error" TEXT,

    CONSTRAINT "WalletTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletBalance" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "tokenMint" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "lastUpdated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletBalance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_userId_key" ON "Wallet"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_walletAddress_key" ON "Wallet"("walletAddress");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_walletPk_key" ON "Wallet"("walletPk");

-- CreateIndex
CREATE UNIQUE INDEX "UserConfig_userId_key" ON "UserConfig"("userId");

-- CreateIndex
CREATE INDEX "TokenAlert_tokenAddress_idx" ON "TokenAlert"("tokenAddress");

-- CreateIndex
CREATE INDEX "TokenAlert_checked_idx" ON "TokenAlert"("checked");

-- CreateIndex
CREATE INDEX "TokenAlert_alertTimestamp_idx" ON "TokenAlert"("alertTimestamp");

-- CreateIndex
CREATE INDEX "WalletTransaction_walletId_idx" ON "WalletTransaction"("walletId");

-- CreateIndex
CREATE INDEX "WalletTransaction_tokenMint_idx" ON "WalletTransaction"("tokenMint");

-- CreateIndex
CREATE INDEX "WalletTransaction_timestamp_idx" ON "WalletTransaction"("timestamp");

-- CreateIndex
CREATE INDEX "WalletBalance_walletId_idx" ON "WalletBalance"("walletId");

-- CreateIndex
CREATE INDEX "WalletBalance_tokenMint_idx" ON "WalletBalance"("tokenMint");

-- CreateIndex
CREATE UNIQUE INDEX "WalletBalance_walletId_tokenMint_key" ON "WalletBalance"("walletId", "tokenMint");

-- AddForeignKey
ALTER TABLE "UserConfig" ADD CONSTRAINT "UserConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Wallet"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletTransaction" ADD CONSTRAINT "WalletTransaction_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletBalance" ADD CONSTRAINT "WalletBalance_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
