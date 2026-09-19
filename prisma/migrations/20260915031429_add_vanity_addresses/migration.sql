-- CreateTable
CREATE TABLE "VanityAddress" (
    "id" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "generationType" TEXT NOT NULL,
    "suffix" TEXT NOT NULL,
    "secretRef" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "retiredReason" TEXT,
    "reservationId" TEXT,
    "reservedBy" TEXT,
    "reservedAt" TIMESTAMP(3),
    "reservationExpiresAt" TIMESTAMP(3),
    "reserveIdempotencyKey" TEXT,
    "consumedAt" TIMESTAMP(3),
    "consumeIdempotencyKey" TEXT,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VanityAddress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VanityAddress_address_key" ON "VanityAddress"("address");

-- CreateIndex
CREATE UNIQUE INDEX "VanityAddress_reservationId_key" ON "VanityAddress"("reservationId");

-- CreateIndex
CREATE INDEX "VanityAddress_chain_status_reservationExpiresAt_idx" ON "VanityAddress"("chain", "status", "reservationExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "VanityAddress_reservedBy_reserveIdempotencyKey_key" ON "VanityAddress"("reservedBy", "reserveIdempotencyKey");

-- Phase 7D.4 §7 — state machine invariants enforced by the database.
ALTER TABLE "VanityAddress" ADD CONSTRAINT "vanity_status_valid" CHECK ("status" IN ('AVAILABLE', 'RESERVED', 'CONSUMED', 'RETIRED'));
ALTER TABLE "VanityAddress" ADD CONSTRAINT "vanity_reserved_has_reservation" CHECK ("status" NOT IN ('RESERVED', 'CONSUMED') OR ("reservationId" IS NOT NULL AND "reservedBy" IS NOT NULL));
ALTER TABLE "VanityAddress" ADD CONSTRAINT "vanity_consumed_has_time" CHECK ("status" <> 'CONSUMED' OR "consumedAt" IS NOT NULL);
