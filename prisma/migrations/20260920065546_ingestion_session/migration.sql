-- Phase 7D.5 — local live-head observation sessions.
--
-- Additive only: no existing table is touched, so durable ChainIngestionCheckpoint rows and
-- every historical record are preserved. `resume` mode never writes here.
CREATE TABLE "IngestionSession" (
    "id" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "startBlock" BIGINT NOT NULL,
    "startHash" TEXT NOT NULL,
    "startTimestamp" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "IngestionSession_pkey" PRIMARY KEY ("id")
);

-- The active-session lookup: newest row for a chain with endedAt IS NULL.
CREATE INDEX "IngestionSession_chain_endedAt_createdAt_idx" ON "IngestionSession"("chain", "endedAt", "createdAt");
