-- Phase 7D.5.1 — MoonPay checkout orders and webhook idempotency.
--
-- Additive only. Two tables because they answer different questions: what the user started,
-- and which provider events we have already applied.
CREATE TABLE "MoonPayOrder" (
    "id" TEXT NOT NULL,
    -- Supabase user. A checkout always belongs to someone; anonymous orders cannot be reconciled.
    "userId" TEXT NOT NULL,
    -- Our own id, passed to MoonPay as externalTransactionId so their events map back to us.
    "externalTransactionId" TEXT NOT NULL,
    -- MoonPay's id, unknown until their first event arrives.
    "providerTransactionId" TEXT,
    "environment" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "baseCurrencyCode" TEXT NOT NULL,
    "baseCurrencyAmount" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    -- Delivery, once the provider reports it. Separate from payment status on purpose.
    "cryptoTransactionId" TEXT,
    "deliveredAmount" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MoonPayOrder_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MoonPayOrder_externalTransactionId_key" ON "MoonPayOrder"("externalTransactionId");
CREATE INDEX "MoonPayOrder_userId_createdAt_idx" ON "MoonPayOrder"("userId", "createdAt");
CREATE INDEX "MoonPayOrder_providerTransactionId_idx" ON "MoonPayOrder"("providerTransactionId");

-- Every accepted webhook, recorded before it is applied. The unique key is what makes
-- redelivery a no-op rather than a second state change.
CREATE TABLE "MoonPayWebhookEvent" (
    "id" TEXT NOT NULL,
    "signatureTimestamp" BIGINT NOT NULL,
    -- Hash of the raw body. MoonPay sends no event id, so identity is the payload itself.
    "payloadHash" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "providerTransactionId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MoonPayWebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MoonPayWebhookEvent_payloadHash_key" ON "MoonPayWebhookEvent"("payloadHash");
