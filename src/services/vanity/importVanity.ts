/**
 * Phase 7D.4 §7 — validate and import OnlyPump-Vanity-Generator output.
 *
 * Generator facts (inspected 2026-09-15, repo OnlyPump-Vanity-Generator @96e4f63): it grinds
 * random Solana ed25519 keypairs (`Keypair::new()`) until the base58 public key ends with the
 * suffix, and writes `{ suffix, count, generated_at, keypairs: [{ public_key, private_key }] }`
 * where private_key is the base58 64-byte secret key. The address is the pump.fun mint account, so
 * the create transaction needs the keypair's signature: signing material stays server-side.
 *
 * Every keypair must pass, or it is not imported:
 *   - the secret decodes to 64 bytes and derives exactly the stated public key;
 *   - the public key ends with the batch suffix;
 *   - it was never publicly exposed (any key ever committed or served is burned);
 *   - its account does not already exist on chain (a used mint address cannot be created again).
 */

import bs58 from "bs58";
import nacl from "tweetnacl";

export interface VanityBatchFile {
  suffix: string;
  keypairs: Array<{ public_key: string; private_key: string }>;
}

export type ImportRejection = "MALFORMED_SECRET" | "PUBLIC_KEY_MISMATCH" | "WRONG_SUFFIX" | "PUBLICLY_EXPOSED" | "ALREADY_ON_CHAIN" | "ON_CHAIN_CHECK_FAILED" | "DUPLICATE_IN_BATCH";

export interface ValidatedKeypair {
  address: string;
  secret: Uint8Array;
}

export function validateKeypair(entry: { public_key: string; private_key: string }, suffix: string): { ok: true; value: ValidatedKeypair } | { ok: false; address: string; reason: ImportRejection } {
  let secret: Uint8Array;
  try {
    secret = bs58.decode(entry.private_key);
  } catch {
    return { ok: false, address: entry.public_key, reason: "MALFORMED_SECRET" };
  }
  if (secret.length !== 64) return { ok: false, address: entry.public_key, reason: "MALFORMED_SECRET" };
  const derived = bs58.encode(nacl.sign.keyPair.fromSecretKey(secret).publicKey);
  if (derived !== entry.public_key) return { ok: false, address: entry.public_key, reason: "PUBLIC_KEY_MISMATCH" };
  if (!derived.endsWith(suffix)) return { ok: false, address: derived, reason: "WRONG_SUFFIX" };
  return { ok: true, value: { address: derived, secret } };
}

export type AccountExists = (address: string) => Promise<boolean | "UNKNOWN">;

export async function validateBatch(batch: VanityBatchFile, options: { exposed: ReadonlySet<string>; accountExists: AccountExists }) {
  const accepted: ValidatedKeypair[] = [];
  const rejected: Array<{ address: string; reason: ImportRejection }> = [];
  const seen = new Set<string>();
  for (const entry of batch.keypairs) {
    const v = validateKeypair(entry, batch.suffix);
    if (!v.ok) {
      rejected.push({ address: v.address, reason: v.reason });
      continue;
    }
    if (seen.has(v.value.address)) {
      rejected.push({ address: v.value.address, reason: "DUPLICATE_IN_BATCH" });
      continue;
    }
    seen.add(v.value.address);
    if (options.exposed.has(v.value.address)) {
      rejected.push({ address: v.value.address, reason: "PUBLICLY_EXPOSED" });
      continue;
    }
    const exists = await options.accountExists(v.value.address);
    if (exists === "UNKNOWN") {
      rejected.push({ address: v.value.address, reason: "ON_CHAIN_CHECK_FAILED" });
      continue;
    }
    if (exists) {
      rejected.push({ address: v.value.address, reason: "ALREADY_ON_CHAIN" });
      continue;
    }
    accepted.push(v.value);
  }
  return { accepted, rejected };
}
