-- This bot no longer generates, imports, or stores a private key anywhere
-- (see ARCHITECTURE.md §8) — Wallet.walletPk is never written by any code
-- path going forward. Made nullable rather than dropped so this migration
-- stays additive/non-destructive for any existing rows.
ALTER TABLE "Wallet" ALTER COLUMN "walletPk" DROP NOT NULL;
