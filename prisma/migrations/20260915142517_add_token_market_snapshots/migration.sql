-- CreateTable
CREATE TABLE "TokenMarketSnapshot" (
    "id" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "venue" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "lastError" TEXT,
    "blockNumber" BIGINT,
    "blockTimestamp" TIMESTAMP(3),
    "quoteAddress" TEXT,
    "quoteDecimals" INTEGER,
    "tokenDecimals" INTEGER,
    "totalSupply" DECIMAL(78,0),
    "priceQuoteX36" DECIMAL(78,0),
    "marketCapQuote" DECIMAL(78,0),
    "liquidityQuote" DECIMAL(78,0),
    "priceUsd" DECIMAL(60,30),
    "marketCapUsd" DECIMAL(38,6),
    "liquidityUsd" DECIMAL(38,6),
    "usdRateSource" TEXT,
    "bondingProgressBps" INTEGER,
    "quoteRaised" DECIMAL(78,0),
    "graduationThreshold" DECIMAL(78,0),
    "graduated" BOOLEAN NOT NULL DEFAULT false,
    "readyToGraduate" BOOLEAN NOT NULL DEFAULT false,
    "marketCapChange1hUsd" DECIMAL(38,6),
    "marketCapChange1hPct" DECIMAL(20,6),
    "unchangedReads" INTEGER NOT NULL DEFAULT 0,
    "nextRefreshAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TokenMarketSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TokenMarketSample" (
    "id" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "marketCapUsd" DECIMAL(38,6),
    "priceQuoteX36" DECIMAL(78,0),

    CONSTRAINT "TokenMarketSample_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TokenMarketSnapshot_chain_status_nextRefreshAt_idx" ON "TokenMarketSnapshot"("chain", "status", "nextRefreshAt");

-- CreateIndex
CREATE INDEX "TokenMarketSnapshot_chain_bondingProgressBps_idx" ON "TokenMarketSnapshot"("chain", "bondingProgressBps");

-- CreateIndex
CREATE INDEX "TokenMarketSnapshot_chain_marketCapUsd_idx" ON "TokenMarketSnapshot"("chain", "marketCapUsd");

-- CreateIndex
CREATE INDEX "TokenMarketSnapshot_chain_liquidityUsd_idx" ON "TokenMarketSnapshot"("chain", "liquidityUsd");

-- CreateIndex
CREATE INDEX "TokenMarketSnapshot_chain_marketCapChange1hUsd_idx" ON "TokenMarketSnapshot"("chain", "marketCapChange1hUsd");

-- CreateIndex
CREATE UNIQUE INDEX "TokenMarketSnapshot_chain_tokenAddress_key" ON "TokenMarketSnapshot"("chain", "tokenAddress");

-- CreateIndex
CREATE INDEX "TokenMarketSample_chain_tokenAddress_at_idx" ON "TokenMarketSample"("chain", "tokenAddress", "at");

-- CreateIndex
CREATE INDEX "TokenMarketSample_at_idx" ON "TokenMarketSample"("at");

-- Phase 7D.4 — invariants for market snapshots.
ALTER TABLE "TokenMarketSnapshot" ADD CONSTRAINT "snapshot_status_valid" CHECK ("status" IN ('PENDING', 'OK', 'FAILED', 'UNSUPPORTED'));
ALTER TABLE "TokenMarketSnapshot" ADD CONSTRAINT "snapshot_progress_range" CHECK ("bondingProgressBps" IS NULL OR "bondingProgressBps" BETWEEN 0 AND 10000);
ALTER TABLE "TokenMarketSnapshot" ADD CONSTRAINT "snapshot_amounts_non_negative" CHECK (COALESCE("priceQuoteX36", 0) >= 0 AND COALESCE("marketCapQuote", 0) >= 0 AND COALESCE("liquidityQuote", 0) >= 0 AND COALESCE("totalSupply", 0) >= 0);
