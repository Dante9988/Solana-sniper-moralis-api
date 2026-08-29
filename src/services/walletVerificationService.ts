/**
 * Phase 7B.2 — non-custodial Solana wallet-ownership verification
 * (phase7b2.txt §2). This is Sign-In-With-Solana-style: the user's wallet
 * signs a short-lived, single-use challenge message with `signMessage`
 * (never a transaction), and the server verifies the detached Ed25519
 * signature against the exact message bytes. This module never generates,
 * imports, requests, receives, or stores a private key or seed phrase, and
 * never signs or submits anything on the user's behalf — see
 * ARCHITECTURE.md §17.
 */

import { createHash, randomBytes } from 'node:crypto';
import { PrismaClient, Prisma } from '@prisma/client';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';

export const CHALLENGE_TTL_MS = 5 * 60_000; // ~5 minutes, per phase7b2.txt §2
export const NETWORK = 'solana:mainnet';

export class WalletVerificationError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'INVALID_ADDRESS'
      | 'INVALID_SIGNATURE_FORMAT'
      | 'CHALLENGE_NOT_FOUND'
      | 'CHALLENGE_EXPIRED'
      | 'CHALLENGE_ALREADY_CONSUMED'
      | 'ADDRESS_MISMATCH'
      | 'USER_MISMATCH'
      | 'SIGNATURE_INVALID'
      | 'ADDRESS_ALREADY_CLAIMED'
  ) {
    super(message);
    this.name = 'WalletVerificationError';
  }
}

export interface CreateChallengeResult {
  challengeId: string;
  message: string;
  expiresAt: Date;
}

function hashChallengeId(challengeId: string): string {
  return createHash('sha256').update(challengeId).digest('hex');
}

function buildChallengeMessage(opts: { domain: string; uri: string; address: string; nonce: string; issuedAt: Date; expiresAt: Date }): string {
  // Every field here is exactly what gets hashed and verified — changing
  // this template changes what a previously-issued (unexpired) challenge's
  // stored `message` says, so treat it as part of the verification contract.
  return [
    `${opts.domain} wants you to prove you own this Solana wallet.`,
    '',
    'This signature:',
    '- Proves you control this wallet',
    '- Signs you into / connects this wallet to your OnlyPump account',
    '- Does NOT authorize any transaction',
    '- Does NOT transfer funds',
    '- Does NOT grant access to your wallet, private key, or seed phrase',
    '',
    `Wallet: ${opts.address}`,
    `Domain: ${opts.domain}`,
    `URI: ${opts.uri}`,
    `Network: ${NETWORK}`,
    `Nonce: ${opts.nonce}`,
    `Issued At: ${opts.issuedAt.toISOString()}`,
    `Expires At: ${opts.expiresAt.toISOString()}`,
  ].join('\n');
}

/**
 * Creates a challenge bound to `userId` (the verified Supabase subject) and
 * `address`. Only the sha256 of the returned `challengeId` is persisted —
 * the raw id is a bearer-style value the caller must present again at
 * verify time, so it's handled like a reset token, not stored reusable in
 * plaintext (phase7b2.txt §2).
 */
export async function createWalletChallenge(
  db: PrismaClient,
  input: { userId: string; address: string; domain: string; uri: string }
): Promise<CreateChallengeResult> {
  let publicKey: PublicKey;
  try {
    publicKey = new PublicKey(input.address);
  } catch {
    throw new WalletVerificationError('Not a valid Solana public key.', 'INVALID_ADDRESS');
  }
  const address = publicKey.toBase58();

  const challengeId = randomBytes(32).toString('base64url'); // cryptographically random, single use
  const nonce = randomBytes(16).toString('hex');
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + CHALLENGE_TTL_MS);
  const message = buildChallengeMessage({ domain: input.domain, uri: input.uri, address, nonce, issuedAt, expiresAt });

  await db.walletChallenge.create({
    data: {
      challengeHash: hashChallengeId(challengeId),
      userId: input.userId,
      address,
      network: NETWORK,
      domain: input.domain,
      uri: input.uri,
      nonce,
      message,
      issuedAt,
      expiresAt,
    },
  });

  return { challengeId, message, expiresAt };
}

export interface VerifyChallengeInput {
  userId: string;
  challengeId: string;
  address: string;
  /** Base58-encoded detached Ed25519 signature, as returned by wallet-adapter's `signMessage`. */
  signature: string;
}

export interface VerifiedWalletRecord {
  id: string;
  address: string;
  network: string;
  verifiedAt: Date;
}

/**
 * Verifies the signature against the exact stored challenge message,
 * atomically consumes the challenge (a single `updateMany` guarded by
 * `consumedAt: null` — never a separate read-then-write, so a replayed
 * request can't win a race against itself), and records the address as
 * verified for `userId`. Rejects a claim on an address already verified by
 * a *different* user (phase7b2.txt §2's default: no cross-account claims).
 */
export async function verifyWalletChallenge(db: PrismaClient, input: VerifyChallengeInput): Promise<VerifiedWalletRecord> {
  let publicKey: PublicKey;
  try {
    publicKey = new PublicKey(input.address);
  } catch {
    throw new WalletVerificationError('Not a valid Solana public key.', 'INVALID_ADDRESS');
  }
  const address = publicKey.toBase58();

  let signatureBytes: Uint8Array;
  try {
    signatureBytes = bs58.decode(input.signature);
  } catch {
    throw new WalletVerificationError('Signature is not valid base58.', 'INVALID_SIGNATURE_FORMAT');
  }
  if (signatureBytes.length !== 64) {
    throw new WalletVerificationError('Signature has the wrong length for a detached Ed25519 signature.', 'INVALID_SIGNATURE_FORMAT');
  }

  const challenge = await db.walletChallenge.findUnique({ where: { challengeHash: hashChallengeId(input.challengeId) } });
  if (!challenge) {
    throw new WalletVerificationError('Unknown or expired challenge.', 'CHALLENGE_NOT_FOUND');
  }
  if (challenge.consumedAt) {
    throw new WalletVerificationError('This challenge has already been used.', 'CHALLENGE_ALREADY_CONSUMED');
  }
  if (challenge.expiresAt.getTime() <= Date.now()) {
    throw new WalletVerificationError('This challenge has expired. Request a new one.', 'CHALLENGE_EXPIRED');
  }
  if (challenge.userId !== input.userId) {
    throw new WalletVerificationError('This challenge was not issued to the authenticated user.', 'USER_MISMATCH');
  }
  if (challenge.address !== address) {
    throw new WalletVerificationError('The signing address does not match the challenge.', 'ADDRESS_MISMATCH');
  }

  const messageBytes = new TextEncoder().encode(challenge.message);
  const signatureValid = nacl.sign.detached.verify(messageBytes, signatureBytes, publicKey.toBytes());
  if (!signatureValid) {
    throw new WalletVerificationError('Signature verification failed.', 'SIGNATURE_INVALID');
  }

  // Atomic consume: only succeeds if still unconsumed. If this loses a race
  // (concurrent replay), `count` is 0 and we treat it as already-consumed
  // rather than proceeding to link the wallet twice.
  const consumed = await db.walletChallenge.updateMany({
    where: { id: challenge.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (consumed.count === 0) {
    throw new WalletVerificationError('This challenge has already been used.', 'CHALLENGE_ALREADY_CONSUMED');
  }

  try {
    const verified = await db.verifiedWallet.create({
      data: { userId: input.userId, address, network: NETWORK },
    });
    return { id: verified.id, address: verified.address, network: verified.network, verifiedAt: verified.verifiedAt };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const existing = await db.verifiedWallet.findUnique({ where: { network_address: { network: NETWORK, address } } });
      if (existing && existing.userId === input.userId) {
        // Already verified by this same user (e.g. a retried request after a
        // dropped response) — idempotent success, not an error.
        return { id: existing.id, address: existing.address, network: existing.network, verifiedAt: existing.verifiedAt };
      }
      throw new WalletVerificationError('This wallet is already verified on a different OnlyPump account.', 'ADDRESS_ALREADY_CLAIMED');
    }
    throw err;
  }
}

export async function listVerifiedWallets(db: PrismaClient, userId: string): Promise<VerifiedWalletRecord[]> {
  const rows = await db.verifiedWallet.findMany({ where: { userId }, orderBy: { verifiedAt: 'desc' } });
  return rows.map((row) => ({ id: row.id, address: row.address, network: row.network, verifiedAt: row.verifiedAt }));
}

/**
 * Unlinks a verified wallet. Deletes only the ownership-proof row —
 * never touches token intelligence, forensics runs, or any other shared
 * data those addresses may appear in (phase7b2.txt §2 "must not delete
 * blockchain history or shared token intelligence").
 */
export async function unlinkVerifiedWallet(db: PrismaClient, userId: string, walletId: string): Promise<boolean> {
  const result = await db.verifiedWallet.deleteMany({ where: { id: walletId, userId } });
  return result.count > 0;
}
