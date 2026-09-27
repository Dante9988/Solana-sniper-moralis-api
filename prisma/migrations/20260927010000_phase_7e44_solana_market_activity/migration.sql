-- Phase 7E.4.4 — quote-denominated activity for chains without a trusted USD rate (Solana).
ALTER TABLE "TokenMarketSnapshot" ADD COLUMN "volume5mQuote" DECIMAL(78,0);
ALTER TABLE "TokenMarketSnapshot" ADD COLUMN "volume1hQuote" DECIMAL(78,0);
ALTER TABLE "TokenMarketSnapshot" ADD COLUMN "activityComputedAt" TIMESTAMP(3);
ALTER TABLE "TokenMarketSnapshot" ADD COLUMN "observationIndex" INTEGER;
