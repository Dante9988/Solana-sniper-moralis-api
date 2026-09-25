-- CreateEnum
CREATE TYPE "ExecutionState" AS ENUM ('QUOTE_READY', 'SIMULATING', 'SIMULATION_FAILED', 'READY_FOR_REVIEW', 'AWAITING_SIGNATURE', 'USER_REJECTED', 'SUBMITTED', 'CONFIRMING', 'CONFIRMED', 'REVERTED', 'DROPPED', 'REPLACED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "ExecutionIntent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "venue" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "routeTarget" TEXT NOT NULL,
    "inputCurrency" TEXT NOT NULL,
    "inputSymbol" TEXT,
    "inputDecimals" INTEGER NOT NULL,
    "inputAmount" DECIMAL(78,0) NOT NULL,
    "outputCurrency" TEXT NOT NULL,
    "outputSymbol" TEXT,
    "outputDecimals" INTEGER NOT NULL,
    "expectedOutput" DECIMAL(78,0) NOT NULL,
    "minimumOutput" DECIMAL(78,0) NOT NULL,
    "slippageBps" INTEGER NOT NULL,
    "deadline" BIGINT,
    "calldata" TEXT NOT NULL,
    "callValue" DECIMAL(78,0) NOT NULL,
    "calldataVersion" TEXT NOT NULL,
    "quoteSnapshotId" TEXT NOT NULL,
    "simulationSnapshotId" TEXT,
    "state" "ExecutionState" NOT NULL DEFAULT 'READY_FOR_REVIEW',
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExecutionIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubmittedExecution" (
    "id" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "transactionHash" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "observedFromBlock" BIGINT,
    "reconcileAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastReconciledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubmittedExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutionReceipt" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "status" "ExecutionState" NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "blockHash" TEXT NOT NULL,
    "gasUsed" DECIMAL(78,0) NOT NULL,
    "effectiveGasPrice" DECIMAL(78,0),
    "actualInput" DECIMAL(78,0),
    "actualOutput" DECIMAL(78,0),
    "matchedWallet" BOOLEAN NOT NULL DEFAULT false,
    "failureReason" TEXT,
    "reconciledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExecutionReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExecutionIntent_userId_createdAt_idx" ON "ExecutionIntent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ExecutionIntent_userId_state_idx" ON "ExecutionIntent"("userId", "state");

-- CreateIndex
CREATE INDEX "ExecutionIntent_chain_tokenAddress_idx" ON "ExecutionIntent"("chain", "tokenAddress");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionIntent_userId_idempotencyKey_key" ON "ExecutionIntent"("userId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "SubmittedExecution_intentId_idx" ON "SubmittedExecution"("intentId");

-- CreateIndex
CREATE INDEX "SubmittedExecution_lastReconciledAt_idx" ON "SubmittedExecution"("lastReconciledAt");

-- CreateIndex
CREATE UNIQUE INDEX "SubmittedExecution_chain_transactionHash_key" ON "SubmittedExecution"("chain", "transactionHash");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionReceipt_submissionId_key" ON "ExecutionReceipt"("submissionId");

-- CreateIndex
CREATE INDEX "ExecutionReceipt_blockNumber_idx" ON "ExecutionReceipt"("blockNumber");

-- AddForeignKey
ALTER TABLE "ExecutionIntent" ADD CONSTRAINT "ExecutionIntent_quoteSnapshotId_fkey" FOREIGN KEY ("quoteSnapshotId") REFERENCES "EvidenceSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionIntent" ADD CONSTRAINT "ExecutionIntent_simulationSnapshotId_fkey" FOREIGN KEY ("simulationSnapshotId") REFERENCES "EvidenceSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmittedExecution" ADD CONSTRAINT "SubmittedExecution_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "ExecutionIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionReceipt" ADD CONSTRAINT "ExecutionReceipt_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "SubmittedExecution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

