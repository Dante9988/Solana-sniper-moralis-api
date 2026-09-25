-- CreateTable
CREATE TABLE "RealtimeTicket" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RealtimeTicket_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RealtimeTicket_expiresAt_idx" ON "RealtimeTicket"("expiresAt");
