/**
 * Phase 7E.4.3 §17 — live, read-only Pump.fun validation against mainnet.
 *
 * Observes the live stream, fetches each transaction, runs the SAME decode path ingestion uses,
 * and prints the canonical result for each event kind. Writes nothing and signs nothing.
 *
 *   SOLANA_RPC_ENDPOINT=... npx ts-node src/solana/scripts/pumpfunLiveCapture.ts [seconds]
 *
 * It exists to produce evidence (signature, slot, mint, event, decoded values, canonical row) and
 * to measure the real observation rate the listener has to survive. Never logs the endpoint URL.
 */

import WebSocket from "ws";

import { PUMPSWAP_PROGRAM_ID, PUMP_PROGRAM_ID } from "../../pump/discriminators";
import { findEvents } from "../../pump/eventWalker";
import { decodePumpfunTransaction, describeEvent, mintsNeedingDecimals } from "../pumpfunDecode";
import { SolanaRpc, resolveSolanaRpcEndpoint } from "../rpc";
import type { FetchedTransaction } from "../rpc";

const RUN_SECONDS = Number(process.argv[2] ?? 45);
const FETCH_CONCURRENCY = 6;

async function main(): Promise<void> {
  const endpoint = resolveSolanaRpcEndpoint();
  if (!endpoint) throw new Error("SOLANA_RPC_ENDPOINT is not set");
  const rpc = new SolanaRpc(endpoint);
  console.log(`[capture] host=${rpc.host} window=${RUN_SECONDS}s programs=${[PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID].join(",")}`);

  const finalizedSlot = await rpc.getSlot("finalized");
  const confirmedSlot = await rpc.getSlot("confirmed");
  console.log(`[capture] confirmed=${JSON.stringify(confirmedSlot)} finalized=${JSON.stringify(finalizedSlot)}`);

  const counters = { observed: 0, failedTx: 0, queued: 0, fetched: 0, fetchFailed: 0, unsupportedTxVersion: 0, notFound: 0, blockFetchFailed: 0 };
  const eventCounts = new Map<string, number>();
  const samplesShown = new Map<string, number>();
  const blockCache = new Map<number, { blockhash: string; blockTime: number | null } | null>();
  const queue: string[] = [];
  let draining = 0;
  let stop = false;

  async function blockRef(slot: number): Promise<{ blockhash: string; blockTime: number | null } | null> {
    if (blockCache.has(slot)) return blockCache.get(slot) ?? null;
    const result = await rpc.getBlockIdentity(slot, "confirmed");
    const value = result.status === "OK" && result.data ? { blockhash: result.data.blockhash, blockTime: result.data.blockTime } : null;
    if (value === null) counters.blockFetchFailed += 1;
    blockCache.set(slot, value);
    return value;
  }

  async function handle(signature: string): Promise<void> {
    const fetched = await rpc.getTransaction(signature, "confirmed");
    if (fetched.status === "UNSUPPORTED_TX_VERSION") {
      counters.unsupportedTxVersion += 1;
      console.log(`[capture] UNSUPPORTED VERSION sig=${signature} ${fetched.reason}`);
      return;
    }
    if (fetched.status === "FAILED") {
      counters.fetchFailed += 1;
      return;
    }
    if (!fetched.data) {
      counters.notFound += 1;
      return;
    }
    counters.fetched += 1;
    const tx = fetched.data as FetchedTransaction;

    const envelopes = findEvents(tx as never);
    for (const envelope of envelopes) {
      const key = `${envelope.emittingProgram === PUMP_PROGRAM_ID ? "pump" : envelope.emittingProgram.slice(0, 4)}:${envelope.eventName}`;
      eventCounts.set(key, (eventCounts.get(key) ?? 0) + 1);
    }
    if (envelopes.length === 0) return;

    const block = await blockRef(tx.slot);
    const needed = mintsNeedingDecimals(tx as never);
    const decimals = new Map<string, number | null>();
    for (const mint of [...needed.tokenMints, ...needed.quoteMints]) {
      if (decimals.has(mint)) continue;
      const read = await rpc.getMintDecimals(mint);
      decimals.set(mint, read.status === "OK" ? read.data : null);
    }

    const batch = decodePumpfunTransaction({
      tx: tx as never,
      block: { slot: tx.slot, blockhash: block?.blockhash ?? "", blockTime: block?.blockTime ?? tx.blockTime },
      observedAt: new Date().toISOString(),
      confidence: "provisional",
      decimals,
    });

    // Print the first two examples of each event kind: raw decode plus the canonical row.
    for (const envelope of envelopes) {
      const shown = samplesShown.get(`${envelope.emittingProgram}:${envelope.eventName}`) ?? 0;
      if (shown >= 2) continue;
      samplesShown.set(`${envelope.emittingProgram}:${envelope.eventName}`, shown + 1);
      console.log(`\n--- ${envelope.eventName} sig=${signature} slot=${tx.slot} blockTime=${tx.blockTime} outer=${envelope.outerInstructionIndex} inner=${envelope.innerPosition}`);
      console.log(`    decoded: ${describeEvent(envelope)}`);
      const token = batch.discovered.find((d) => describeEvent(envelope).includes(d.tokenAddress));
      if (token) console.log(`    DiscoveredToken: ${JSON.stringify(token)}`);
      const trade = batch.trades.find((t) => t.provenance.sourceTxHash === signature && describeEvent(envelope).includes(t.tokenAddress));
      if (trade) console.log(`    ChainTrade: ${JSON.stringify(trade)}`);
      const transition = batch.lifecycle.find((l) => describeEvent(envelope).includes(l.tokenAddress) && l.eventType !== "");
      if (transition) console.log(`    Lifecycle: ${JSON.stringify(transition)}`);
    }
  }

  async function pump(): Promise<void> {
    while (!stop || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise((r) => setTimeout(r, 25));
        if (stop && queue.length === 0) return;
        continue;
      }
      const signature = queue.shift()!;
      draining += 1;
      try {
        await handle(signature);
      } catch (error) {
        console.log(`[capture] handler error sig=${signature}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        draining -= 1;
      }
    }
  }

  const socket = new WebSocket(rpc.wsUrl);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  // Both programs (§14): a graduated token's trades no longer mention the bonding-curve program.
  [PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID].forEach((program, index) => {
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: index + 1, method: "logsSubscribe", params: [{ mentions: [program] }, { commitment: "confirmed" }] }));
  });

  socket.on("message", (data) => {
    const message = JSON.parse(data.toString()) as { method?: string; params?: { result: { value: { signature: string; err: unknown } } } };
    if (message.method !== "logsNotification" || !message.params) return;
    counters.observed += 1;
    const value = message.params.result.value;
    if (value.err) {
      counters.failedTx += 1;
      return;
    }
    // Cap the sampled queue: this is an evidence script, not the listener.
    if (queue.length < 400) {
      queue.push(value.signature);
      counters.queued += 1;
    }
  });

  const workers = Array.from({ length: FETCH_CONCURRENCY }, () => pump());
  await new Promise((r) => setTimeout(r, RUN_SECONDS * 1000));
  stop = true;
  await Promise.all(workers);
  socket.close();

  const endConfirmed = await rpc.getSlot("confirmed");
  const endFinalized = await rpc.getSlot("finalized");
  console.log(`\n[capture] counters ${JSON.stringify(counters)}`);
  console.log(`[capture] events ${JSON.stringify(Object.fromEntries([...eventCounts].sort((a, b) => b[1] - a[1])))}`);
  console.log(`[capture] observed rate ${(counters.observed / RUN_SECONDS).toFixed(1)} notifications/s, drained=${counters.fetched}, pending=${queue.length}, inflight=${draining}`);
  if (endConfirmed.status === "OK" && endFinalized.status === "OK") {
    console.log(`[capture] confirmed=${endConfirmed.data} finalized=${endFinalized.data} lagSlots=${endConfirmed.data - endFinalized.data}`);
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`[capture] fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
);
