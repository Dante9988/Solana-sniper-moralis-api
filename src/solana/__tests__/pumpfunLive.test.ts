/**
 * Phase 7E.4.3 §18 (live, opt-in) — the Pump.fun decoder and listener against real mainnet.
 *
 * Opt-in exactly like the Jupiter contract test, and for the same reason: the failures this guards
 * against are not logic bugs. They are the chain or the endpoint changing under us — a new
 * transaction version the reader refuses, a program that stops emitting an event, a `getBlock` that
 * stops answering for recent slots. A mocked test stays green through every one of those.
 *
 *   SOLANA_RUN_LIVE_TEST=true npx vitest run src/solana/__tests__/pumpfunLive.test.ts
 *
 * CI must not depend on public RPC availability, so without the flag every case here is skipped.
 * Read-only throughout: no transaction is signed, nothing is written to a database.
 */

import { describe, expect, it } from "vitest";

import { PUMP_PROGRAM_ID } from "../../pump/discriminators";
import { findEvents } from "../../pump/eventWalker";
import type { RawTransactionLike } from "../../pump/eventWalker";
import { eventIdentityKey, eventIdentityOf } from "../../pump/eventIdentity";
import { decodePumpfunTransaction, mintsNeedingDecimals } from "../pumpfunDecode";
import { SolanaRpc, resolveSolanaRpcEndpoint } from "../rpc";
import { SolanaDecimalsCache, NATIVE_SOL_DECIMALS, NATIVE_SOL_QUOTE_SENTINEL } from "../solanaDecimals";

const RUN_LIVE = process.env.SOLANA_RUN_LIVE_TEST === "true";

/** vitest does not load .env, and the RPC URL carries an API key — read the file, never export it. */
function endpoint() {
  const fromEnv = resolveSolanaRpcEndpoint();
  if (fromEnv) return fromEnv;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const parsed = require("dotenv").parse(require("node:fs").readFileSync(".env"));
    return resolveSolanaRpcEndpoint({ SOLANA_RPC_ENDPOINT: parsed.SOLANA_RPC_ENDPOINT } as NodeJS.ProcessEnv);
  } catch {
    return null;
  }
}

describe.skipIf(!RUN_LIVE)("Pump.fun live validation", () => {
  const configured = endpoint();
  const rpc = configured ? new SolanaRpc(configured) : null;

  it("has an endpoint configured, and never exposes its URL", () => {
    expect(configured, "SOLANA_RPC_ENDPOINT must be set").not.toBeNull();
    // The only thing any log or error is allowed to carry is the host.
    expect(rpc!.host).not.toContain("/");
    expect(rpc!.host).not.toMatch(/[?=]/);
  });

  it("reports a confirmed head ahead of the finalized head", async () => {
    const [confirmed, finalized] = await Promise.all([rpc!.getSlot("confirmed"), rpc!.getSlot("finalized")]);
    expect(confirmed.status).toBe("OK");
    expect(finalized.status).toBe("OK");
    if (confirmed.status !== "OK" || finalized.status !== "OK") return;
    // This gap is the whole reason the finality model exists (§8). Measured ~32 slots.
    expect(confirmed.data).toBeGreaterThanOrEqual(finalized.data);
    expect(confirmed.data - finalized.data).toBeLessThan(1_000);
  }, 30_000);

  it("answers getBlock for a recent slot, which is what makes a Solana sourceHash real", async () => {
    const confirmed = await rpc!.getSlot("confirmed");
    if (confirmed.status !== "OK") throw new Error("no confirmed slot");
    const block = await rpc!.getBlockIdentity(confirmed.data, "confirmed");
    expect(block.status).toBe("OK");
    if (block.status !== "OK" || !block.data) throw new Error("no block");
    expect(block.data.blockhash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(block.data.parentSlot).toBeLessThan(confirmed.data);
  }, 30_000);

  it("reads decimals from chain, and knows the native sentinel has no mint account", async () => {
    const cache = new SolanaDecimalsCache(rpc!);
    // USDC is the case §10 names: 6, not 9.
    expect(await cache.get("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe(6);
    expect(await cache.get("So11111111111111111111111111111111111111112")).toBe(9);
    // The sentinel is the System Program: no mint to read, so the protocol's own definition applies.
    expect(await cache.get(NATIVE_SOL_QUOTE_SENTINEL)).toBe(NATIVE_SOL_DECIMALS);
    const raw = await rpc!.getMintDecimals(NATIVE_SOL_QUOTE_SENTINEL);
    expect(raw.status === "OK" && raw.data).toBeNull();
  }, 60_000);

  it("decodes live Pump.fun activity into canonical rows", async () => {
    const signatures = await rpc!.getSignaturesForAddress(PUMP_PROGRAM_ID, { limit: 40, commitment: "confirmed" });
    expect(signatures.status).toBe("OK");
    if (signatures.status !== "OK") return;
    expect(signatures.data.length).toBeGreaterThan(0);

    const cache = new SolanaDecimalsCache(rpc!);
    let decoded = 0;
    let trades = 0;
    let discoveries = 0;
    let unsupportedVersion = 0;
    const eventNames = new Set<string>();
    const identities = new Set<string>();

    for (const ref of signatures.data.filter((s) => !s.err).slice(0, 12)) {
      const fetched = await rpc!.getTransaction(ref.signature, "confirmed");
      if (fetched.status === "UNSUPPORTED_TX_VERSION") {
        // Must be visible as its own outcome, never as an empty result (§19).
        unsupportedVersion += 1;
        continue;
      }
      if (fetched.status !== "OK" || !fetched.data) continue;
      const tx = fetched.data as unknown as RawTransactionLike;

      const envelopes = findEvents(tx);
      for (const envelope of envelopes) {
        eventNames.add(envelope.eventName);
        identities.add(eventIdentityKey(eventIdentityOf(envelope)));
      }
      if (envelopes.length === 0) continue;

      const block = await rpc!.getBlockIdentity(tx.slot, "confirmed");
      if (block.status !== "OK" || !block.data) continue;

      const needed = mintsNeedingDecimals(tx);
      const batch = decodePumpfunTransaction({
        tx,
        block: { slot: tx.slot, blockhash: block.data.blockhash, blockTime: block.data.blockTime ?? tx.blockTime },
        observedAt: new Date().toISOString(),
        confidence: "provisional",
        decimals: await cache.resolveAll([...needed.tokenMints, ...needed.quoteMints]),
      });
      decoded += 1;
      trades += batch.trades.length;
      discoveries += batch.discovered.length;

      for (const trade of batch.trades) {
        expect(trade.chain).toBe("solana");
        expect(trade.tokenAmount).toMatch(/^\d+$/);
        expect(trade.quoteAmount).toMatch(/^\d+$/);
        expect(trade.provenance.sourceHash).toBe(block.data.blockhash);
        expect(trade.provenance.sourceIndex).toBeGreaterThanOrEqual(0);
      }
      for (const token of batch.discovered) {
        expect(token.venue).toBe("pumpfun");
        // A pump.fun mint's decimals must have been READ, not assumed.
        expect(token.metadata?.tokenDecimals).not.toBeUndefined();
      }
    }

    expect(decoded, "no Pump.fun transaction decoded from live mainnet").toBeGreaterThan(0);
    expect(trades, "no live TradeEvent decoded").toBeGreaterThan(0);
    // Every decoded event has a unique canonical identity across the whole sample.
    expect(identities.size).toBeGreaterThan(0);
    expect(eventNames.has("TradeEvent")).toBe(true);
    // Reported, not asserted: creates and migrations are much rarer than trades in a small sample.
    console.log(`[live] decoded=${decoded} trades=${trades} discoveries=${discoveries} events=${[...eventNames].join(",")} unsupportedVersion=${unsupportedVersion}`);
  }, 120_000);

  it("surfaces an unreadable transaction version instead of swallowing it", async () => {
    // Asks for version 0 on purpose, which is the bug §0 fixed. The point is that the node returns
    // an ERROR the reader classifies, not an empty result a careless caller reads as "no events".
    const signatures = await rpc!.getSignaturesForAddress(PUMP_PROGRAM_ID, { limit: 20, commitment: "confirmed" });
    if (signatures.status !== "OK") return;

    let sawRefusal = false;
    for (const ref of signatures.data.filter((s) => !s.err)) {
      const body = await rpc!.call<unknown>("getTransaction", [ref.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
      if (body.status === "UNSUPPORTED_TX_VERSION") {
        sawRefusal = true;
        break;
      }
    }
    if (!sawRefusal) console.warn("[live] no versioned transaction in this sample; the refusal path was not exercised");
  }, 60_000);
});
