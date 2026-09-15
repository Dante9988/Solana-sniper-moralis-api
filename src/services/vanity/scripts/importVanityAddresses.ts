/**
 * Phase 7D.4 §7 — import OnlyPump-Vanity-Generator output into the server-side inventory.
 *
 *   npm run vanity:import -- --file <generator output.json>          # dry run
 *   npm run vanity:import -- --file <generator output.json> --apply  # store
 *
 * --apply needs VANITY_KEYSTORE_KEY (base64, 32 bytes) and VANITY_KEYSTORE_DIR (outside the repo).
 * The on-chain check uses Solana JSON-RPC getMultipleAccounts (https://solana.com/docs/rpc/http/getmultipleaccounts,
 * accessed 2026-09-15): a null entry means no account exists at that address. Any RPC failure marks
 * the batch entry unverifiable and it is not imported (fail closed).
 *
 * Prints addresses and reasons only — never a private key, the keystore key or the RPC URL. Delete
 * the plaintext generator file after a successful import.
 */

import { readFileSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";

import exposed from "../exposedVanityAddresses.json";
import { validateBatch, type AccountExists, type VanityBatchFile } from "../importVanity";
import { keystoreKey, storeSecret } from "../keystore";
import { retireAddresses } from "../vanityService";

dotenv.config();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function solanaAccountExists(rpcUrl: string, fetcher: typeof fetch = fetch): AccountExists {
  const cache = new Map<string, Promise<boolean | "UNKNOWN">>();
  return (address) => {
    if (!cache.has(address)) {
      cache.set(
        address,
        (async () => {
          try {
            const res = await fetcher(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [[address], { encoding: "base64", commitment: "finalized" }] }) });
            if (!res.ok) return "UNKNOWN";
            const body = (await res.json()) as { result?: { value?: unknown[] } };
            const value = body.result?.value;
            if (!Array.isArray(value) || value.length !== 1) return "UNKNOWN";
            return value[0] !== null;
          } catch {
            return "UNKNOWN";
          }
        })()
      );
    }
    return cache.get(address)!;
  };
}

async function main() {
  const file = arg("--file");
  const apply = process.argv.includes("--apply");
  if (!file) throw new Error("--file <generator output.json> is required");
  const rpc = process.env.SOLANA_RPC_HTTPS ?? process.env.HELIUS_HTTPS_URI;
  if (!rpc) throw new Error("set HELIUS_HTTPS_URI or SOLANA_RPC_HTTPS for the on-chain unused check");
  const batch = JSON.parse(readFileSync(file, "utf8")) as VanityBatchFile;
  if (typeof batch.suffix !== "string" || !Array.isArray(batch.keypairs)) throw new Error("not a vanity generator output file");

  const exposedSet = new Set(exposed.addresses);
  const { accepted, rejected } = await validateBatch(batch, { exposed: exposedSet, accountExists: solanaAccountExists(rpc) });
  for (const r of rejected) console.log(`reject ${r.address} ${r.reason}`);
  console.log(`suffix=${batch.suffix} candidates=${batch.keypairs.length} accepted=${accepted.length} rejected=${rejected.length} mode=${apply ? "apply" : "dry-run"}`);

  // A dry run reads the file and the chain only; it never writes the database or the keystore.
  if (!apply) return;
  const dir = process.env.VANITY_KEYSTORE_DIR;
  if (!dir) throw new Error("VANITY_KEYSTORE_DIR is required with --apply");
  const key = keystoreKey();
  const db = new PrismaClient();
  try {
    const retired = await retireAddresses(db, exposed.addresses, "private key publicly exposed");
    if (retired) console.log(`retired ${retired} previously imported exposed address(es)`);
    let imported = 0;
    for (const kp of accepted) {
      if (await db.vanityAddress.findUnique({ where: { address: kp.address } })) {
        console.log(`skip ${kp.address} already imported`);
        continue;
      }
      const secretRef = storeSecret(dir, kp.address, kp.secret, key);
      await db.vanityAddress.create({ data: { chain: "solana", address: kp.address, generationType: "ed25519-keypair-suffix", suffix: batch.suffix, secretRef } });
      imported += 1;
    }
    console.log(`imported ${imported}`);
  } finally {
    await db.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    const message = String(err instanceof Error ? err.message : err).split("\n").find((line) => line.trim()) ?? "import failed";
    console.error(message.replace(/https?:\/\/\S+/g, "[url redacted]").slice(0, 300));
    process.exit(1);
  });
}
