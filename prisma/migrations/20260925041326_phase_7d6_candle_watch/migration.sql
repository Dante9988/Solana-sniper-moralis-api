-- CreateTable
CREATE TABLE "CandleWatch" (
    "chain" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CandleWatch_pkey" PRIMARY KEY ("chain","tokenAddress")
);

-- CreateIndex
CREATE INDEX "CandleWatch_lastSeenAt_idx" ON "CandleWatch"("lastSeenAt");
