import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import bs58 from "bs58";
import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";

import { validateBatch, validateKeypair } from "../importVanity";
import { loadSecret, storeSecret } from "../keystore";

/** Phase 7D.4 §7 — keystore and import validation, with freshly generated keys (never real ones). */

function grind(suffix: string): { public_key: string; private_key: string } {
  for (;;) {
    const kp = nacl.sign.keyPair();
    const pub = bs58.encode(kp.publicKey);
    if (pub.endsWith(suffix)) return { public_key: pub, private_key: bs58.encode(kp.secretKey) };
  }
}

describe("vanity keystore", () => {
  const key = Buffer.alloc(32, 7);
  it("round-trips a secret through an authenticated 0600 file and never stores it in clear", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vanity-ks-"));
    const kp = grind("a");
    const secret = bs58.decode(kp.private_key);
    const ref = storeSecret(dir, kp.public_key, secret, key);
    expect(ref).toBe(`keystore:v1:${kp.public_key}`);
    const file = path.join(dir, `${kp.public_key}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).not.toContain(kp.private_key);
    expect(Buffer.from(loadSecret(dir, ref, key)).equals(Buffer.from(secret))).toBe(true);
    expect(() => storeSecret(dir, kp.public_key, secret, key)).toThrow(/already holds/);
  });

  it("refuses a tampered entry or the wrong key", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vanity-ks-"));
    const kp = grind("b");
    const ref = storeSecret(dir, kp.public_key, bs58.decode(kp.private_key), key);
    expect(() => loadSecret(dir, ref, Buffer.alloc(32, 8))).toThrow();
    const file = path.join(dir, `${kp.public_key}.json`);
    const entry = JSON.parse(readFileSync(file, "utf8"));
    entry.ciphertext = Buffer.from(Buffer.from(entry.ciphertext, "base64").map((b, i) => (i === 0 ? b ^ 1 : b))).toString("base64");
    writeFileSync(file, JSON.stringify(entry));
    expect(() => loadSecret(dir, ref, key)).toThrow();
  });
});

describe("vanity import validation", () => {
  it("accepts only keypairs whose secret derives the stated address with the suffix", () => {
    const good = grind("p");
    expect(validateKeypair(good, "p").ok).toBe(true);
    const other = grind("p");
    expect(validateKeypair({ public_key: good.public_key, private_key: other.private_key }, "p")).toMatchObject({ ok: false, reason: "PUBLIC_KEY_MISMATCH" });
    expect(validateKeypair({ ...good, private_key: "notbase58!" }, "p")).toMatchObject({ ok: false, reason: "MALFORMED_SECRET" });
    expect(validateKeypair(good, "zzzz")).toMatchObject({ ok: false, reason: "WRONG_SUFFIX" });
  });

  it("rejects publicly exposed keys, used mint accounts, duplicates and unverifiable chain state", async () => {
    const [a, b, c, d] = [grind("q"), grind("q"), grind("q"), grind("q")];
    const result = await validateBatch(
      { suffix: "q", keypairs: [a, b, c, d, a] },
      { exposed: new Set([b.public_key]), accountExists: async (addr) => (addr === c.public_key ? true : addr === d.public_key ? "UNKNOWN" : false) }
    );
    expect(result.accepted.map((k) => k.address)).toEqual([a.public_key]);
    expect(result.rejected.map((r) => r.reason).sort()).toEqual(["ALREADY_ON_CHAIN", "DUPLICATE_IN_BATCH", "ON_CHAIN_CHECK_FAILED", "PUBLICLY_EXPOSED"]);
  });
});

describe("on-chain unused check", () => {
  it("treats a null account as unused, an account as used, and any RPC failure as unknown", async () => {
    const { solanaAccountExists } = await import("../scripts/importVanityAddresses");
    const reply = (value: unknown, ok = true) => (async () => ({ ok, json: async () => ({ result: { value } }) })) as unknown as typeof fetch;
    expect(await solanaAccountExists("http://rpc", reply([null]))("A")).toBe(false);
    expect(await solanaAccountExists("http://rpc", reply([{ lamports: 1 }]))("A")).toBe(true);
    expect(await solanaAccountExists("http://rpc", reply([null], false))("A")).toBe("UNKNOWN");
    expect(await solanaAccountExists("http://rpc", reply(undefined))("A")).toBe("UNKNOWN");
    expect(await solanaAccountExists("http://rpc", (async () => { throw new Error("down"); }) as unknown as typeof fetch)("A")).toBe("UNKNOWN");
  });
});
