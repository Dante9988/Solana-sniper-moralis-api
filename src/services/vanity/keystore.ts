/**
 * Phase 7D.4 §7 — server-side keystore for vanity mint signing material.
 *
 * A pump.fun create transaction must be signed by the mint keypair, so the secret cannot be
 * avoided at consumption time. It is kept out of the database, API responses, the frontend and
 * logs: each secret is encrypted with AES-256-GCM under VANITY_KEYSTORE_KEY (32 bytes, base64,
 * server env only) and written to its own 0600 file. The database stores only the opaque
 * reference `keystore:v1:<address>`. Tampering fails authentication rather than yielding a key.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import path from "node:path";

export const SECRET_REF_PREFIX = "keystore:v1:";

export function keystoreKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.VANITY_KEYSTORE_KEY?.trim();
  if (!raw) throw new Error("VANITY_KEYSTORE_KEY is not set (32 random bytes, base64)");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("VANITY_KEYSTORE_KEY must decode to exactly 32 bytes");
  return key;
}

function fileFor(dir: string, address: string): string {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) throw new Error("not a base58 address");
  return path.join(dir, `${address}.json`);
}

/** Encrypts and stores a secret; returns its reference. Refuses to overwrite an existing entry. */
export function storeSecret(dir: string, address: string, secret: Uint8Array, key: Buffer): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = fileFor(dir, address);
  if (existsSync(file)) throw new Error(`keystore already holds an entry for ${address}`);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(address));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(secret)), cipher.final()]);
  const entry = { v: 1, alg: "AES-256-GCM", address, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
  writeFileSync(file, JSON.stringify(entry), { mode: 0o600, flag: "wx" });
  chmodSync(file, 0o600);
  return `${SECRET_REF_PREFIX}${address}`;
}

/** For the launch signer only. Never call from a request handler that returns data to a client. */
export function loadSecret(dir: string, secretRef: string, key: Buffer): Uint8Array {
  if (!secretRef.startsWith(SECRET_REF_PREFIX)) throw new Error("unsupported secret reference");
  const address = secretRef.slice(SECRET_REF_PREFIX.length);
  const entry = JSON.parse(readFileSync(fileFor(dir, address), "utf8")) as { v: number; address: string; iv: string; tag: string; ciphertext: string };
  if (entry.v !== 1 || entry.address !== address) throw new Error("keystore entry does not match its reference");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(entry.iv, "base64"));
  decipher.setAAD(Buffer.from(address));
  decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
  return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(entry.ciphertext, "base64")), decipher.final()]));
}
