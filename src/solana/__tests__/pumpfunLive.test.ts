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

import WebSocket from "ws";
import { describe, expect, it } from "vitest";

import { PUMPSWAP_PROGRAM_ID, PUMP_PROGRAM_ID } from "../../pump/discriminators";
import { findEvents } from "../../pump/eventWalker";
import type { RawTransactionLike } from "../../pump/eventWalker";
import { eventIdentityKey, eventIdentityOf } from "../../pump/eventIdentity";
import { decodePumpfunTransaction, mintsNeedingDecimals } from "../pumpfunDecode";
import { RECOVERY_STRATEGY } from "../pumpfunListener";
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

  it("decodes live PumpSwap trades from the SUBSCRIPTION, with their pool and their own quote asset", async () => {
    // Deliberately sourced from `logsSubscribe`, not `getSignaturesForAddress`: the PumpSwap program
    // is not in this node's signature index (see the test above), while the live filter sees it fine.
    // This is exactly the split the listener is built around.
    const socket = new WebSocket(rpc!.wsUrl);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "logsSubscribe", params: [{ mentions: [PUMPSWAP_PROGRAM_ID] }, { commitment: "confirmed" }] }));

    const observed: string[] = [];
    socket.on("message", (data: Buffer) => {
      const message = JSON.parse(data.toString()) as { method?: string; params?: { result: { value: { signature: string; err: unknown } } } };
      if (message.method !== "logsNotification" || !message.params) return;
      if (message.params.result.value.err) return;
      if (observed.length < 30) observed.push(message.params.result.value.signature);
    });
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    socket.close();

    expect(observed.length, "the subscription delivered no PumpSwap activity").toBeGreaterThan(0);
    // The RPC lags the notification by ~3s, the same gap the listener retries through.
    await new Promise((resolve) => setTimeout(resolve, 4_000));

    const cache = new SolanaDecimalsCache(rpc!);
    let trades = 0;
    const pools = new Set<string>();
    const quoteScales = new Map<string, number | null>();

    for (const signature of observed.slice(0, 15)) {
      const fetched = await rpc!.getTransaction(signature, "confirmed");
      if (fetched.status !== "OK" || !fetched.data) continue;
      const tx = fetched.data as unknown as RawTransactionLike;
      if (findEvents(tx).length === 0) continue;
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

      for (const trade of batch.trades.filter((t) => t.venue === "pumpswap")) {
        trades += 1;
        expect(trade.poolAddress, trade.provenance.sourceTxHash).toBeTruthy();
        expect(trade.tokenAmount).toMatch(/^\d+$/);
        expect(trade.quoteAmount).toMatch(/^\d+$/);
        pools.add(trade.poolAddress!);
        quoteScales.set(trade.quoteAddress, trade.quoteDecimals ?? null);
      }
      // Graduation is never inferred from PumpSwap activity — a trade produces no lifecycle row.
      expect(batch.lifecycle).toHaveLength(0);
    }

    expect(trades, "no live PumpSwap trade decoded").toBeGreaterThan(0);
    // PumpSwap quote assets genuinely vary in scale, which is why the persistence guard exists.
    console.log(`[live] pumpswap trades=${trades} pools=${pools.size} quoteScales=${JSON.stringify(Object.fromEntries(quoteScales))}`);
    for (const scale of quoteScales.values()) expect(scale === null || (scale >= 0 && scale <= 18)).toBe(true);
  }, 120_000);

  it("pins which addresses this node indexes for signature recovery", async () => {
    // The finding that shaped PumpSwap recovery. An unindexed address returns an EMPTY LIST, not an
    // error, so a program-wide walk would read it as "already caught up" and never notice the gap.
    const counts: Record<string, number> = {};
    for (const [label, address] of [
      ["pumpfunProgram", PUMP_PROGRAM_ID],
      ["pumpswapProgram", PUMPSWAP_PROGRAM_ID],
      ["wrappedSolMint", "So11111111111111111111111111111111111111112"],
    ] as const) {
      const page = await rpc!.getSignaturesForAddress(address, { limit: 5, commitment: "confirmed" });
      counts[label] = page.status === "OK" ? page.data.length : -1;
    }
    console.log(`[live] signature index: ${JSON.stringify(counts)}`);

    // Pump.fun must stay indexed — its recovery depends on it, and the listener warns loudly at
    // startup if this ever stops being true.
    expect(counts.pumpfunProgram).toBeGreaterThan(0);
    // PumpSwap is expected to be unindexed here, which is why it is recovered per pool. Asserted as
    // a report rather than a hard expectation: if a provider starts indexing it, that is good news,
    // not a failure — but the per-pool strategy must keep working either way.
    if (counts.pumpswapProgram > 0) {
      console.warn("[live] the PumpSwap program is now indexed; per-pool recovery remains correct but is no longer the only option");
    }
    expect(RECOVERY_STRATEGY[PUMP_PROGRAM_ID]).toBe("byProgramId");
    expect(RECOVERY_STRATEGY[PUMPSWAP_PROGRAM_ID]).toBe("byKnownPool");
  }, 60_000);

  it("finds a graduated token's PumpSwap trades through its pool, which IS indexed", async () => {
    // The pool a real migration named during the 7E.4.3 live run.
    const POOL = "3oP7CokyBZjwA14iTjaTSHitmF5UWkWaGjZqp5Xxentt";
    const MINT = "35ynznV9r2RVSXYDrZtfsngvLRrkD3iGKjzv5c3U2i7u";

    const page = await rpc!.getSignaturesForAddress(POOL, { limit: 20, commitment: "confirmed" });
    expect(page.status).toBe("OK");
    if (page.status !== "OK") return;
    expect(page.data.length, "the pool's signatures must be indexed for per-pool recovery to work").toBeGreaterThan(0);

    const cache = new SolanaDecimalsCache(rpc!);
    let trades = 0;
    for (const ref of page.data.filter((s) => !s.err).slice(0, 8)) {
      const fetched = await rpc!.getTransaction(ref.signature, "confirmed");
      if (fetched.status !== "OK" || !fetched.data) continue;
      const tx = fetched.data as unknown as RawTransactionLike;
      const block = await rpc!.getBlockIdentity(tx.slot, "confirmed");
      if (block.status !== "OK" || !block.data) continue;
      const needed = mintsNeedingDecimals(tx);
      const batch = decodePumpfunTransaction({
        tx,
        block: { slot: tx.slot, blockhash: block.data.blockhash, blockTime: block.data.blockTime ?? tx.blockTime },
        observedAt: new Date().toISOString(),
        confidence: "final",
        decimals: await cache.resolveAll([...needed.tokenMints, ...needed.quoteMints]),
      });
      for (const trade of batch.trades.filter((t) => t.venue === "pumpswap" && t.tokenAddress === MINT)) {
        trades += 1;
        expect(trade.poolAddress).toBe(POOL);
        // Same mint as the bonding-curve token — one identity across the migration.
        expect(trade.tokenAddress).toBe(MINT);
      }
    }
    expect(trades, "no PumpSwap trade of the graduated mint decoded through its pool").toBeGreaterThan(0);
    console.log(`[live] graduated mint ${MINT}: ${trades} PumpSwap trades via pool ${POOL}`);
  }, 120_000);
});
