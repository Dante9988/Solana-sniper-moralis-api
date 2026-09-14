-- CreateEnum
CREATE TYPE "EvidenceSnapshotKind" AS ENUM ('QUOTE', 'SIMULATION');

-- CreateTable
CREATE TABLE "EvidenceSnapshot" (
    "id" TEXT NOT NULL,
    "kind" "EvidenceSnapshotKind" NOT NULL,
    "status" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "parentId" TEXT,
    "blockNumber" BIGINT,
    "blockHash" TEXT,
    "blockTimestamp" TIMESTAMP(3),
    "observedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "calculationVersion" TEXT,
    "policyVersion" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "payloadSha256" TEXT NOT NULL,
    "sourceReferences" JSONB NOT NULL,
    "missingEvidence" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidenceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaperPosition" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "venue" TEXT NOT NULL,
    "fillBasis" TEXT NOT NULL,
    "inputCurrency" TEXT NOT NULL,
    "inputSymbol" TEXT,
    "inputDecimals" INTEGER NOT NULL,
    "inputAmount" DECIMAL(78,0) NOT NULL,
    "outputCurrency" TEXT NOT NULL,
    "outputSymbol" TEXT,
    "outputDecimals" INTEGER NOT NULL,
    "outputAmount" DECIMAL(78,0) NOT NULL,
    "minimumOutput" DECIMAL(78,0) NOT NULL,
    "quoteSnapshotId" TEXT NOT NULL,
    "simulationSnapshotId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaperPosition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TokenImageCache" (
    "id" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "contentType" TEXT,
    "bytes" BYTEA,
    "byteLength" INTEGER,
    "sha256" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3),
    "fetchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TokenImageCache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EvidenceSnapshot_chain_tokenAddress_createdAt_idx" ON "EvidenceSnapshot"("chain", "tokenAddress", "createdAt");

-- CreateIndex
CREATE INDEX "EvidenceSnapshot_parentId_idx" ON "EvidenceSnapshot"("parentId");

-- CreateIndex
CREATE INDEX "PaperPosition_userId_createdAt_idx" ON "PaperPosition"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "PaperPosition_userId_chain_tokenAddress_idx" ON "PaperPosition"("userId", "chain", "tokenAddress");

-- CreateIndex
CREATE UNIQUE INDEX "PaperPosition_userId_idempotencyKey_key" ON "PaperPosition"("userId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "TokenImageCache_status_nextAttemptAt_idx" ON "TokenImageCache"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "TokenImageCache_chain_tokenAddress_sourceUrl_key" ON "TokenImageCache"("chain", "tokenAddress", "sourceUrl");

-- AddForeignKey
ALTER TABLE "EvidenceSnapshot" ADD CONSTRAINT "EvidenceSnapshot_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "EvidenceSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaperPosition" ADD CONSTRAINT "PaperPosition_quoteSnapshotId_fkey" FOREIGN KEY ("quoteSnapshotId") REFERENCES "EvidenceSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaperPosition" ADD CONSTRAINT "PaperPosition_simulationSnapshotId_fkey" FOREIGN KEY ("simulationSnapshotId") REFERENCES "EvidenceSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Phase 7D.3.2 §6 — evidence snapshots are immutable.
--
-- Enforced in the database, not only in application code, so no future code path, script
-- or ad-hoc query can rewrite the numbers a saved paper position was based on. A corrected
-- result is inserted as a new snapshot.
CREATE OR REPLACE FUNCTION evidence_snapshot_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'EvidenceSnapshot rows are immutable (attempted % on %)', TG_OP, OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "EvidenceSnapshot_immutable"
  BEFORE UPDATE OR DELETE ON "EvidenceSnapshot"
  FOR EACH ROW EXECUTE FUNCTION evidence_snapshot_reject_mutation();
