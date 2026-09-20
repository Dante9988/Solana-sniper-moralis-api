-- Phase 7D.5 — per-token, on-demand trade history backfill.
--
-- Additive only. Records what has been backfilled for one token so the work is idempotent
-- and resumable: opening a chart twice must not re-scan the chain, and an interrupted run
-- must continue rather than restart.
CREATE TABLE "TokenTradeBackfill" (
    "chain" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    -- PENDING | RUNNING | COMPLETE | PARTIAL | FAILED
    "status" TEXT NOT NULL,
    -- The range this backfill is responsible for, and how far it has got.
    "fromBlock" BIGINT NOT NULL,
    "toBlock" BIGINT NOT NULL,
    "cursor" BIGINT NOT NULL,
    "tradesWritten" INTEGER NOT NULL DEFAULT 0,
    "logsScanned" INTEGER NOT NULL DEFAULT 0,
    "requests" INTEGER NOT NULL DEFAULT 0,
    -- Set when a bounded run stopped early; the reason is shown to the user, not swallowed.
    "stoppedReason" TEXT,
    "lastError" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "TokenTradeBackfill_pkey" PRIMARY KEY ("chain","tokenAddress")
);

CREATE INDEX "TokenTradeBackfill_chain_status_idx" ON "TokenTradeBackfill"("chain", "status");
