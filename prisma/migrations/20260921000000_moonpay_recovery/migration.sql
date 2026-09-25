ALTER TABLE "MoonPayOrder"
 ADD COLUMN "idempotencyKey" TEXT,
 ADD COLUMN "redirectUrl" TEXT,
 ADD COLUMN "providerUpdatedAt" TIMESTAMP(3),
 ADD COLUMN "quotedAmount" TEXT,
 ADD COLUMN "lastReconciledAt" TIMESTAMP(3),
 ADD COLUMN "reconciliationError" TEXT;
-- Earlier code stored the provider quote as delivered. Preserve it under the correct name.
UPDATE "MoonPayOrder" SET "quotedAmount" = "deliveredAmount", "deliveredAmount" = NULL;
CREATE UNIQUE INDEX "MoonPayOrder_providerTransactionId_key" ON "MoonPayOrder"("providerTransactionId");
CREATE UNIQUE INDEX "MoonPayOrder_userId_environment_idempotencyKey_key" ON "MoonPayOrder"("userId", "environment", "idempotencyKey");
CREATE INDEX "MoonPayOrder_status_lastReconciledAt_idx" ON "MoonPayOrder"("status", "lastReconciledAt");
ALTER TABLE "MoonPayWebhookEvent" ADD COLUMN "semanticHash" TEXT;
CREATE UNIQUE INDEX "MoonPayWebhookEvent_semanticHash_key" ON "MoonPayWebhookEvent"("semanticHash");
DROP INDEX "MoonPayOrder_providerTransactionId_idx";
