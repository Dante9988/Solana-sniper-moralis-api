-- CreateTable
CREATE TABLE "DiscoveredToken" (
    "id" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "venue" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "deployer" TEXT NOT NULL,
    "poolAddress" TEXT,
    "quoteAddress" TEXT NOT NULL,
    "supply" DECIMAL(78,0) NOT NULL,
    "initialBuyAmount" DECIMAL(78,0) NOT NULL,
    "sourceHeight" BIGINT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "sourceTxHash" TEXT NOT NULL,
    "sourceIndex" INTEGER NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "graduated" BOOLEAN NOT NULL DEFAULT false,
    "graduationPairedPrincipal" DECIMAL(78,0),
    "graduationThreshold" DECIMAL(78,0),
    "graduationCheckedAt" TIMESTAMP(3),

    CONSTRAINT "DiscoveredToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChainTrade" (
    "id" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "venue" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "poolAddress" TEXT,
    "side" TEXT NOT NULL,
    "tokenAmount" DECIMAL(78,0) NOT NULL,
    "quoteAmount" DECIMAL(78,0) NOT NULL,
    "quoteAddress" TEXT NOT NULL,
    "priceQuote" DECIMAL(60,18) NOT NULL,
    "trader" TEXT NOT NULL,
    "sourceHeight" BIGINT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "sourceTxHash" TEXT NOT NULL,
    "sourceIndex" INTEGER NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChainTrade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChainIngestionCheckpoint" (
    "source" TEXT NOT NULL,
    "lastHeight" BIGINT NOT NULL,
    "lastHash" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChainIngestionCheckpoint_pkey" PRIMARY KEY ("source")
);

-- CreateIndex
CREATE INDEX "DiscoveredToken_chain_observedAt_idx" ON "DiscoveredToken"("chain", "observedAt");

-- CreateIndex
CREATE INDEX "DiscoveredToken_chain_graduated_idx" ON "DiscoveredToken"("chain", "graduated");

-- CreateIndex
CREATE UNIQUE INDEX "DiscoveredToken_chain_tokenAddress_key" ON "DiscoveredToken"("chain", "tokenAddress");

-- CreateIndex
CREATE INDEX "ChainTrade_chain_tokenAddress_sourceHeight_idx" ON "ChainTrade"("chain", "tokenAddress", "sourceHeight");

-- CreateIndex
CREATE UNIQUE INDEX "ChainTrade_chain_sourceTxHash_sourceIndex_key" ON "ChainTrade"("chain", "sourceTxHash", "sourceIndex");
