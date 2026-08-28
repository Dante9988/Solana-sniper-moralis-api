/**
 * Phase 7B.2 — real-database integration checks (phase7b2.txt §11: atomic
 * challenge consumption under real concurrency, and the real unique-
 * constraint enforcement behind "prevent cross-account wallet claims").
 *
 * Opt-in only: skipped unless `WALLET_RUN_DB_TESTS=true`, so the default
 * `npx vitest run` stays fully hermetic (no network/DB), matching every
 * other test in this project and the identical convention already used by
 * src/forensics/__tests__/forensicsJobService.dbIntegration.test.ts. Run
 * explicitly against a real (ideally disposable) PostgreSQL 16 instance —
 * never a production or otherwise shared database:
 *
 *   WALLET_RUN_DB_TESTS=true DATABASE_URL=postgresql://... npx vitest run src/services/__tests__/walletVerificationService.dbIntegration.test.ts
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";

const RUN_DB_TESTS = process.env.WALLET_RUN_DB_TESTS === "true";

function sign(message: string, wallet: Keypair): string {
  return bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), wallet.secretKey));
}

describe.skipIf(!RUN_DB_TESTS)("walletVerificationService — real Postgres integration", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let createWalletChallenge: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let verifyWalletChallenge: any;
  const testUserIds: string[] = [];

  beforeAll(async () => {
    const { prisma: p } = await import("../prismaClient");
    const service = await import("../walletVerificationService");
    prisma = p;
    createWalletChallenge = service.createWalletChallenge;
    verifyWalletChallenge = service.verifyWalletChallenge;
  });

  afterAll(async () => {
    // Clean up only the rows this test file created — every user id used
    // here is a randomUUID minted below, never a real account.
    if (prisma && testUserIds.length > 0) {
      await prisma.verifiedWallet.deleteMany({ where: { userId: { in: testUserIds } } });
      await prisma.walletChallenge.deleteMany({ where: { userId: { in: testUserIds } } });
    }
    await prisma?.$disconnect();
  });

  it("atomic consumption under real concurrency: two simultaneous verify calls for the same challenge — exactly one succeeds", async () => {
    const userId = randomUUID();
    testUserIds.push(userId);
    const wallet = Keypair.generate();
    const { challengeId, message } = await createWalletChallenge(prisma, {
      userId,
      address: wallet.publicKey.toBase58(),
      domain: "onlypump.me",
      uri: "https://onlypump.me",
    });
    const signature = sign(message, wallet);

    const results = await Promise.allSettled([
      verifyWalletChallenge(prisma, { userId, challengeId, address: wallet.publicKey.toBase58(), signature }),
      verifyWalletChallenge(prisma, { userId, challengeId, address: wallet.publicKey.toBase58(), signature }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const row = await prisma.walletChallenge.findFirst({ where: { userId, address: wallet.publicKey.toBase58() } });
    expect(row?.consumedAt).not.toBeNull();
  });

  it("real unique-constraint enforcement: a second account cannot claim an address already verified by a different account", async () => {
    const userA = randomUUID();
    const userB = randomUUID();
    testUserIds.push(userA, userB);
    const wallet = Keypair.generate();

    const a = await createWalletChallenge(prisma, { userId: userA, address: wallet.publicKey.toBase58(), domain: "onlypump.me", uri: "https://onlypump.me" });
    await verifyWalletChallenge(prisma, { userId: userA, challengeId: a.challengeId, address: wallet.publicKey.toBase58(), signature: sign(a.message, wallet) });

    const b = await createWalletChallenge(prisma, { userId: userB, address: wallet.publicKey.toBase58(), domain: "onlypump.me", uri: "https://onlypump.me" });
    await expect(
      verifyWalletChallenge(prisma, { userId: userB, challengeId: b.challengeId, address: wallet.publicKey.toBase58(), signature: sign(b.message, wallet) })
    ).rejects.toMatchObject({ code: "ADDRESS_ALREADY_CLAIMED" });

    const owners = await prisma.verifiedWallet.findMany({ where: { address: wallet.publicKey.toBase58() } });
    expect(owners).toHaveLength(1);
    expect(owners[0].userId).toBe(userA);
  });
});
