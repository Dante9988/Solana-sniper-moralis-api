-- CreateTable
CREATE TABLE "PracticePortfolio" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PracticePortfolio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PracticeBalance" (
    "portfolioId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL,
    "startingAmount" DECIMAL(78,0) NOT NULL,
    "amount" DECIMAL(78,0) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PracticeBalance_pkey" PRIMARY KEY ("portfolioId","currency")
);

-- CreateTable
CREATE TABLE "PracticeHolding" (
    "portfolioId" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "quoteCurrency" TEXT NOT NULL,
    "amount" DECIMAL(78,0) NOT NULL,
    "costBasis" DECIMAL(78,0) NOT NULL,
    "realizedPnl" DECIMAL(78,0) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PracticeHolding_pkey" PRIMARY KEY ("portfolioId","chain","tokenAddress")
);

-- CreateTable
CREATE TABLE "PracticePlan" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "portfolioId" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "thesis" TEXT NOT NULL,
    "sizeNote" TEXT,
    "exitNote" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "idempotencyKey" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "PracticePlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PracticeTrade" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "portfolioId" TEXT NOT NULL,
    "planId" TEXT,
    "chain" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "venue" TEXT NOT NULL,
    "fillBasis" TEXT NOT NULL,
    "quoteCurrency" TEXT NOT NULL,
    "inputAmount" DECIMAL(78,0) NOT NULL,
    "outputAmount" DECIMAL(78,0) NOT NULL,
    "minimumOutput" DECIMAL(78,0) NOT NULL,
    "allInCostBps" INTEGER NOT NULL,
    "realizedPnl" DECIMAL(78,0),
    "quoteSnapshotId" TEXT NOT NULL,
    "simulationSnapshotId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PracticeTrade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PracticeReview" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "notes" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PracticeReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PracticeJournalEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "portfolioId" TEXT,
    "planId" TEXT,
    "tradeId" TEXT,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PracticeJournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PracticeLessonProgress" (
    "userId" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "steps" TEXT[],
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PracticeLessonProgress_pkey" PRIMARY KEY ("userId","lessonId")
);

-- CreateTable
CREATE TABLE "PracticeAchievement" (
    "userId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "awardedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PracticeAchievement_pkey" PRIMARY KEY ("userId","code")
);

-- CreateIndex
CREATE INDEX "PracticePortfolio_userId_createdAt_idx" ON "PracticePortfolio"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PracticePortfolio_userId_idempotencyKey_key" ON "PracticePortfolio"("userId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "PracticePlan_userId_portfolioId_createdAt_idx" ON "PracticePlan"("userId", "portfolioId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PracticePlan_userId_idempotencyKey_key" ON "PracticePlan"("userId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "PracticeTrade_userId_portfolioId_createdAt_idx" ON "PracticeTrade"("userId", "portfolioId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PracticeTrade_userId_idempotencyKey_key" ON "PracticeTrade"("userId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "PracticeReview_planId_key" ON "PracticeReview"("planId");

-- CreateIndex
CREATE INDEX "PracticeJournalEntry_userId_createdAt_idx" ON "PracticeJournalEntry"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "PracticeBalance" ADD CONSTRAINT "PracticeBalance_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "PracticePortfolio"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeHolding" ADD CONSTRAINT "PracticeHolding_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "PracticePortfolio"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticePlan" ADD CONSTRAINT "PracticePlan_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "PracticePortfolio"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeTrade" ADD CONSTRAINT "PracticeTrade_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "PracticePortfolio"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeTrade" ADD CONSTRAINT "PracticeTrade_planId_fkey" FOREIGN KEY ("planId") REFERENCES "PracticePlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeReview" ADD CONSTRAINT "PracticeReview_planId_fkey" FOREIGN KEY ("planId") REFERENCES "PracticePlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Phase 7D.4 §5 — the database itself refuses overspending paper cash or overselling a holding,
-- whatever the application code does.
ALTER TABLE "PracticeBalance" ADD CONSTRAINT "practice_balance_non_negative" CHECK ("amount" >= 0 AND "startingAmount" >= 0);
ALTER TABLE "PracticeHolding" ADD CONSTRAINT "practice_holding_non_negative" CHECK ("amount" >= 0 AND "costBasis" >= 0);
ALTER TABLE "PracticeTrade" ADD CONSTRAINT "practice_trade_side" CHECK ("side" IN ('buy', 'sell'));
