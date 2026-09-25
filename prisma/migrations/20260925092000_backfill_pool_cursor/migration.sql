ALTER TABLE "TokenTradeBackfill" ADD COLUMN "poolCursor" BIGINT;
-- Previous COMPLETE rows did not prove pool coverage. Leave their pool cursor null.
