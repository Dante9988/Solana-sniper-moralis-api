-- Version 2 fixes V4 trade direction. The bounded repair script upgrades only
-- old V4 rows; new/replayed rows are stamped by the corrected decoder callers.
ALTER TABLE "ChainTrade" ADD COLUMN "normalizationVersion" INTEGER NOT NULL DEFAULT 1;
