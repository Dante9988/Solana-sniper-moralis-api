import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { Prisma } from "@prisma/client";
import bs58 from "bs58";
import nacl from "tweetnacl";
import {
  createWalletChallenge,
  listVerifiedWallets,
  unlinkVerifiedWallet,
  verifyWalletChallenge,
  WalletVerificationError,
} from "../walletVerificationService";

// A local, ephemeral test keypair used only to exercise Ed25519
// verification logic — never a real fund-holding wallet, and this module
// never asks for or touches its secret key beyond signing in-memory here in
// the test itself (the service under test only ever sees the PUBLIC key and
// a signature, exactly like the real wallet-adapter flow).
function testWallet() {
  return Keypair.generate();
}

function sign(message: string, wallet: Keypair): string {
  const sig = nacl.sign.detached(new TextEncoder().encode(message), wallet.secretKey);
  return bs58.encode(sig);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeDb() {
  const challenges = new Map<string, any>();
  const challengesByHash = new Map<string, string>();
  const verifiedWallets = new Map<string, any>();
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    walletChallenge: {
      create: vi.fn(async ({ data }: any) => {
        const id = nextId();
        const row = { id, consumedAt: null, ...data }; // matches the schema's nullable-with-no-default column
        challenges.set(id, row);
        challengesByHash.set(data.challengeHash, id);
        return row;
      }),
      findUnique: vi.fn(async ({ where: { challengeHash } }: any) => {
        const id = challengesByHash.get(challengeHash);
        return id ? challenges.get(id) : null;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const row = challenges.get(where.id);
        if (!row || row.consumedAt !== null) return { count: 0 };
        row.consumedAt = data.consumedAt;
        return { count: 1 };
      }),
    },
    verifiedWallet: {
      create: vi.fn(async ({ data }: any) => {
        const clash = [...verifiedWallets.values()].find((w) => w.network === data.network && w.address === data.address);
        if (clash) {
          throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "6.5.0" });
        }
        const id = nextId();
        const row = { id, ...data, verifiedAt: new Date() };
        verifiedWallets.set(id, row);
        return row;
      }),
      findUnique: vi.fn(async ({ where: { network_address } }: any) => {
        return [...verifiedWallets.values()].find((w) => w.network === network_address.network && w.address === network_address.address) ?? null;
      }),
      findMany: vi.fn(async ({ where: { userId } }: any) => [...verifiedWallets.values()].filter((w) => w.userId === userId)),
      deleteMany: vi.fn(async ({ where }: any) => {
        const row = verifiedWallets.get(where.id);
        if (!row || row.userId !== where.userId) return { count: 0 };
        verifiedWallets.delete(where.id);
        return { count: 1 };
      }),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

async function issueChallenge(db: ReturnType<typeof fakeDb>, wallet: Keypair, userId = USER_A) {
  return createWalletChallenge(db, { userId, address: wallet.publicKey.toBase58(), domain: "onlypump.me", uri: "https://onlypump.me" });
}

describe("createWalletChallenge", () => {
  it("rejects an invalid Solana address", async () => {
    const db = fakeDb();
    await expect(createWalletChallenge(db, { userId: USER_A, address: "not-an-address", domain: "onlypump.me", uri: "https://onlypump.me" })).rejects.toThrow(
      WalletVerificationError
    );
  });

  it("the returned message states it proves ownership, is for signing into OnlyPump, and never authorizes a transaction or transfers funds", async () => {
    const db = fakeDb();
    const wallet = testWallet();
    const { message } = await issueChallenge(db, wallet);
    expect(message).toMatch(/prove you own this Solana wallet/i);
    expect(message).toMatch(/signs you into|connects this wallet/i);
    expect(message).toMatch(/does not authorize any transaction/i);
    expect(message).toMatch(/does not transfer funds/i);
    // Mentions private key/seed phrase only to reassure the user it never
    // grants access to either — never actually solicits one.
    expect(message).toMatch(/does not grant access to.*private key.*seed phrase/i);
    expect(message).not.toMatch(/enter your (private key|seed phrase)/i);
  });

  it("only stores a hash of the challenge id, never the raw id itself", async () => {
    const db = fakeDb();
    const wallet = testWallet();
    const { challengeId } = await issueChallenge(db, wallet);
    const createCall = db.walletChallenge.create.mock.calls[0][0];
    expect(createCall.data.challengeHash).not.toBe(challengeId);
    expect(JSON.stringify(createCall.data)).not.toContain(challengeId);
  });

  it("sets an expiry roughly 5 minutes out", async () => {
    const db = fakeDb();
    const wallet = testWallet();
    const before = Date.now();
    const { expiresAt } = await issueChallenge(db, wallet);
    const deltaMs = expiresAt.getTime() - before;
    expect(deltaMs).toBeGreaterThan(4 * 60_000);
    expect(deltaMs).toBeLessThanOrEqual(5 * 60_000 + 1000);
  });
});

describe("verifyWalletChallenge", () => {
  it("accepts a valid signature over the exact challenge message", async () => {
    const db = fakeDb();
    const wallet = testWallet();
    const { challengeId, message } = await issueChallenge(db, wallet);
    const signature = sign(message, wallet);

    const result = await verifyWalletChallenge(db, { userId: USER_A, challengeId, address: wallet.publicKey.toBase58(), signature });
    expect(result.address).toBe(wallet.publicKey.toBase58());
  });

  it("rejects an invalid signature", async () => {
    const db = fakeDb();
    const wallet = testWallet();
    const { challengeId } = await issueChallenge(db, wallet);
    const garbageSignature = bs58.encode(new Uint8Array(64).fill(7));

    await expect(
      verifyWalletChallenge(db, { userId: USER_A, challengeId, address: wallet.publicKey.toBase58(), signature: garbageSignature })
    ).rejects.toMatchObject({ code: "SIGNATURE_INVALID" });
  });

  it("rejects a signature over an altered message (signed something else)", async () => {
    const db = fakeDb();
    const wallet = testWallet();
    const { challengeId } = await issueChallenge(db, wallet);
    const signatureOverWrongText = sign("this is not the real challenge message", wallet);

    await expect(
      verifyWalletChallenge(db, { userId: USER_A, challengeId, address: wallet.publicKey.toBase58(), signature: signatureOverWrongText })
    ).rejects.toMatchObject({ code: "SIGNATURE_INVALID" });
  });

  it("rejects when the submitted address does not match the challenge's address", async () => {
    const db = fakeDb();
    const wallet = testWallet();
    const otherWallet = testWallet();
    const { challengeId, message } = await issueChallenge(db, wallet);
    const signature = sign(message, wallet);

    await expect(
      verifyWalletChallenge(db, { userId: USER_A, challengeId, address: otherWallet.publicKey.toBase58(), signature })
    ).rejects.toMatchObject({ code: "ADDRESS_MISMATCH" });
  });

  it("rejects when the authenticated user does not match the user the challenge was issued to", async () => {
    const db = fakeDb();
    const wallet = testWallet();
    const { challengeId, message } = await issueChallenge(db, wallet, USER_A);
    const signature = sign(message, wallet);

    await expect(
      verifyWalletChallenge(db, { userId: USER_B, challengeId, address: wallet.publicKey.toBase58(), signature })
    ).rejects.toMatchObject({ code: "USER_MISMATCH" });
  });

  it("rejects an expired challenge", async () => {
    vi.useFakeTimers();
    try {
      const db = fakeDb();
      const wallet = testWallet();
      const { challengeId, message } = await issueChallenge(db, wallet);
      const signature = sign(message, wallet);

      vi.advanceTimersByTime(6 * 60_000); // past the ~5 minute TTL

      await expect(
        verifyWalletChallenge(db, { userId: USER_A, challengeId, address: wallet.publicKey.toBase58(), signature })
      ).rejects.toMatchObject({ code: "CHALLENGE_EXPIRED" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an unknown challenge id", async () => {
    const db = fakeDb();
    const wallet = testWallet();
    await expect(
      verifyWalletChallenge(db, { userId: USER_A, challengeId: "does-not-exist", address: wallet.publicKey.toBase58(), signature: bs58.encode(new Uint8Array(64)) })
    ).rejects.toMatchObject({ code: "CHALLENGE_NOT_FOUND" });
  });

  it("is atomically single-use: a replayed (second) verify with the same challenge id is rejected, even though the first succeeded", async () => {
    const db = fakeDb();
    const wallet = testWallet();
    const { challengeId, message } = await issueChallenge(db, wallet);
    const signature = sign(message, wallet);

    await verifyWalletChallenge(db, { userId: USER_A, challengeId, address: wallet.publicKey.toBase58(), signature });
    await expect(
      verifyWalletChallenge(db, { userId: USER_A, challengeId, address: wallet.publicKey.toBase58(), signature })
    ).rejects.toMatchObject({ code: "CHALLENGE_ALREADY_CONSUMED" });
  });

  it("consumption happens via a single atomic updateMany guarded by consumedAt:null, not a separate read-then-write", async () => {
    const db = fakeDb();
    const wallet = testWallet();
    const { challengeId, message } = await issueChallenge(db, wallet);
    const signature = sign(message, wallet);

    await verifyWalletChallenge(db, { userId: USER_A, challengeId, address: wallet.publicKey.toBase58(), signature });
    expect(db.walletChallenge.updateMany).toHaveBeenCalledTimes(1);
    expect(db.walletChallenge.updateMany.mock.calls[0][0].where.consumedAt).toBe(null);
  });

  it("prevents a cross-account claim: a second user cannot verify the same address once it's claimed", async () => {
    const db = fakeDb();
    const wallet = testWallet();

    const first = await issueChallenge(db, wallet, USER_A);
    await verifyWalletChallenge(db, { userId: USER_A, challengeId: first.challengeId, address: wallet.publicKey.toBase58(), signature: sign(first.message, wallet) });

    const second = await issueChallenge(db, wallet, USER_B);
    await expect(
      verifyWalletChallenge(db, { userId: USER_B, challengeId: second.challengeId, address: wallet.publicKey.toBase58(), signature: sign(second.message, wallet) })
    ).rejects.toMatchObject({ code: "ADDRESS_ALREADY_CLAIMED" });
  });

  it("re-verifying the same address by the SAME user is idempotent, not an error", async () => {
    const db = fakeDb();
    const wallet = testWallet();

    const first = await issueChallenge(db, wallet, USER_A);
    const firstResult = await verifyWalletChallenge(db, {
      userId: USER_A,
      challengeId: first.challengeId,
      address: wallet.publicKey.toBase58(),
      signature: sign(first.message, wallet),
    });

    const second = await issueChallenge(db, wallet, USER_A);
    const secondResult = await verifyWalletChallenge(db, {
      userId: USER_A,
      challengeId: second.challengeId,
      address: wallet.publicKey.toBase58(),
      signature: sign(second.message, wallet),
    });

    expect(secondResult.id).toBe(firstResult.id);
  });
});

describe("listVerifiedWallets / unlinkVerifiedWallet", () => {
  it("lists only the calling user's own wallets", async () => {
    const db = fakeDb();
    const walletA = testWallet();
    const walletB = testWallet();
    const a = await issueChallenge(db, walletA, USER_A);
    await verifyWalletChallenge(db, { userId: USER_A, challengeId: a.challengeId, address: walletA.publicKey.toBase58(), signature: sign(a.message, walletA) });
    const b = await issueChallenge(db, walletB, USER_B);
    await verifyWalletChallenge(db, { userId: USER_B, challengeId: b.challengeId, address: walletB.publicKey.toBase58(), signature: sign(b.message, walletB) });

    const listA = await listVerifiedWallets(db, USER_A);
    expect(listA).toHaveLength(1);
    expect(listA[0].address).toBe(walletA.publicKey.toBase58());
  });

  it("unlinking only removes the ownership-proof row, and only for the owning user", async () => {
    const db = fakeDb();
    const wallet = testWallet();
    const c = await issueChallenge(db, wallet, USER_A);
    const verified = await verifyWalletChallenge(db, { userId: USER_A, challengeId: c.challengeId, address: wallet.publicKey.toBase58(), signature: sign(c.message, wallet) });

    const deniedForOtherUser = await unlinkVerifiedWallet(db, USER_B, verified.id);
    expect(deniedForOtherUser).toBe(false);
    expect(await listVerifiedWallets(db, USER_A)).toHaveLength(1);

    const removed = await unlinkVerifiedWallet(db, USER_A, verified.id);
    expect(removed).toBe(true);
    expect(await listVerifiedWallets(db, USER_A)).toHaveLength(0);
  });
});
