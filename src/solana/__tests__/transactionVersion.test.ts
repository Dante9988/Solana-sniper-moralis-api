/**
 * Phase 7E.4.3 §0 — transaction version support.
 *
 * The offline half pins the contract. The live half is opt-in and proves against mainnet
 * that legacy, v0 and v1 transactions all parse, because that is the failure mode that
 * actually bit: the RPC refuses the whole request for an unsupported version, so a reader
 * pinned too low returns an error that a careless caller reads as "no transaction here".
 *
 *   SOLANA_RUN_LIVE_TEST=true npx vitest run src/solana/__tests__/transactionVersion.test.ts
 */

import { describe, expect, it } from "vitest";

import {
  SOLANA_MAX_SUPPORTED_TRANSACTION_VERSION,
  UNSUPPORTED_TRANSACTION_VERSION_CODE,
  getTransactionConfig,
  isUnsupportedTransactionVersion,
} from "../transactionVersion";

const RUN_LIVE = process.env.SOLANA_RUN_LIVE_TEST === "true";
const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

describe("getTransactionConfig", () => {
  it("always carries the supported version, so a new reader cannot forget it", () => {
    expect(getTransactionConfig().maxSupportedTransactionVersion).toBe(SOLANA_MAX_SUPPORTED_TRANSACTION_VERSION);
    expect(getTransactionConfig({ encoding: "jsonParsed" }).maxSupportedTransactionVersion).toBe(SOLANA_MAX_SUPPORTED_TRANSACTION_VERSION);
  });

  it("supports at least version 1, which mainnet is emitting today", () => {
    expect(SOLANA_MAX_SUPPORTED_TRANSACTION_VERSION).toBeGreaterThanOrEqual(1);
  });

  it("passes through only what the caller asked for", () => {
    expect(getTransactionConfig({ encoding: "jsonParsed", commitment: "confirmed" })).toEqual({
      encoding: "jsonParsed",
      commitment: "confirmed",
      maxSupportedTransactionVersion: SOLANA_MAX_SUPPORTED_TRANSACTION_VERSION,
    });
    expect(getTransactionConfig()).toEqual({ maxSupportedTransactionVersion: SOLANA_MAX_SUPPORTED_TRANSACTION_VERSION });
  });
});

describe("isUnsupportedTransactionVersion", () => {
  it("recognises the RPC's own error code", () => {
    expect(isUnsupportedTransactionVersion({ code: UNSUPPORTED_TRANSACTION_VERSION_CODE })).toBe(true);
  });

  it("recognises the message when a client drops the code", () => {
    expect(
      isUnsupportedTransactionVersion({ message: "Transaction version (2) is not supported by the requesting client." })
    ).toBe(true);
  });

  it("does not mistake an ordinary failure for a version problem", () => {
    // Misclassifying here would turn a real outage into a silently-skipped transaction.
    for (const other of [null, undefined, "boom", { code: -32602 }, { message: "rate limit exceeded" }, { message: "Transaction not found" }]) {
      expect(isUnsupportedTransactionVersion(other), JSON.stringify(other)).toBe(false);
    }
  });
});

/**
 * vitest does not load .env, and the RPC URL carries an API key. Read the file rather than
 * importing it into process.env, so nothing leaks into other workers or logs.
 */
function rpcUrl(): string | undefined {
  if (process.env.SOLANA_RPC_ENDPOINT) return process.env.SOLANA_RPC_ENDPOINT;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const parsed = require("dotenv").parse(require("node:fs").readFileSync(".env"));
    return parsed.SOLANA_RPC_ENDPOINT || undefined;
  } catch {
    return undefined;
  }
}

describe.skipIf(!RUN_LIVE)("live mainnet transaction versions", () => {
  const url = rpcUrl();

  async function rpc(method: string, params: unknown[]): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
    const res = await fetch(url!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return (await res.json()) as { result?: unknown; error?: { code: number; message: string } };
  }

  it("parses recent Pump.fun transactions at the supported version", async () => {
    expect(url, "SOLANA_RPC_ENDPOINT must be set for the live test").toBeTruthy();
    const sigs = (await rpc("getSignaturesForAddress", [PUMP_PROGRAM, { limit: 8 }])).result as { signature: string; err: unknown }[];
    expect(sigs.length).toBeGreaterThan(0);

    let parsed = 0;
    const versions = new Set<unknown>();
    for (const s of sigs.filter((x) => !x.err).slice(0, 5)) {
      const body = await rpc("getTransaction", [s.signature, getTransactionConfig({ encoding: "jsonParsed", commitment: "confirmed" })]);
      expect(body.error, `signature ${s.signature}`).toBeUndefined();
      if (body.result) {
        parsed += 1;
        versions.add((body.result as { version?: unknown }).version);
      }
    }
    expect(parsed).toBeGreaterThan(0);
    // Legacy transactions report "legacy"; versioned ones report a number. Either is fine —
    // what matters is that none of them errored.
    expect(versions.size).toBeGreaterThan(0);
  }, 60_000);

  it("fails VISIBLY, not silently, when the version is pinned too low", async () => {
    // This is the bug reproduced on purpose. Pinning 0 does not return an empty result — it
    // returns an error, so a listener that swallowed errors would drop live trades while
    // reporting itself healthy.
    const sigs = (await rpc("getSignaturesForAddress", [PUMP_PROGRAM, { limit: 12 }])).result as { signature: string; err: unknown }[];

    let sawRefusal = false;
    for (const s of sigs.filter((x) => !x.err)) {
      const body = await rpc("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
      if (body.error && isUnsupportedTransactionVersion(body.error)) {
        sawRefusal = true;
        expect(body.error.code).toBe(UNSUPPORTED_TRANSACTION_VERSION_CODE);
        break;
      }
    }
    // If mainnet happens to serve only legacy/v0 in this sample the assertion is vacuous, so
    // report that rather than pretending the case was covered.
    if (!sawRefusal) console.warn("[live] no versioned transaction in this sample; refusal path not exercised");
  }, 60_000);
});
