-- CreateTable
CREATE TABLE "WalletChallenge" (
    "id" TEXT NOT NULL,
    "challengeHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "network" TEXT NOT NULL DEFAULT 'solana:mainnet',
    "domain" TEXT NOT NULL,
    "uri" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerifiedWallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "network" TEXT NOT NULL DEFAULT 'solana:mainnet',
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerifiedWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserScanRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "jobKey" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserScanRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WalletChallenge_challengeHash_key" ON "WalletChallenge"("challengeHash");

-- CreateIndex
CREATE INDEX "WalletChallenge_userId_idx" ON "WalletChallenge"("userId");

-- CreateIndex
CREATE INDEX "WalletChallenge_expiresAt_idx" ON "WalletChallenge"("expiresAt");

-- CreateIndex
CREATE INDEX "VerifiedWallet_userId_idx" ON "VerifiedWallet"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "VerifiedWallet_network_address_key" ON "VerifiedWallet"("network", "address");

-- CreateIndex
CREATE INDEX "UserScanRequest_jobKey_idx" ON "UserScanRequest"("jobKey");

-- CreateIndex
CREATE INDEX "UserScanRequest_userId_idx" ON "UserScanRequest"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserScanRequest_userId_jobKey_key" ON "UserScanRequest"("userId", "jobKey");
