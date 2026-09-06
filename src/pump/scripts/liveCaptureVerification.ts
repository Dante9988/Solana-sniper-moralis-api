/**
 * Phase 7B.3A1 no-mock completion policy: "live read-only Pump.fun
 * ingestion through the actual Helius endpoint" and "live read-only
 * PumpSwap ingestion through the actual Helius endpoint."
 *
 * First attempt used @solana/web3.js's Connection.getTransaction with its
 * default retry-on-429 behavior, one call per logsNotification: it produced
 * 111,769 rate-limit responses in 75 seconds and zero successful decodes —
 * proof this project's actual Helius plan cannot sustain even modest
 * concurrent getTransaction volume during real trade activity, and that a
 * client-side retry loop only makes it worse (see the Phase 7B.3A1 report).
 *
 * This version uses a raw, non-retrying HTTPS call and a strict serial
 * queue (one in-flight request at a time, with a minimum spacing between
 * requests) specifically to produce an honest throughput measurement
 * instead of a client-side retry storm, and to get at least one genuine
 * live decode through the real eventWalker/normalizeTrade pipeline.
 *
 * Run: ts-node src/pump/scripts/liveCaptureVerification.ts
 */
import WebSocket from 'ws';
import https from 'https';
import { findEvents, RawTransactionLike } from '../eventWalker';
import { normalizeTradeEvent } from '../normalizeTrade';
import { eventIdentityOf, eventIdentityKey } from '../eventIdentity';
import { PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID } from '../discriminators';

const WSS = process.env.HELIUS_WSS_URI;
const HTTPS_URL = process.env.HELIUS_HTTPS_URI;
if (!WSS || !HTTPS_URL) {
  console.log('BLOCKER: HELIUS_WSS_URI/HELIUS_HTTPS_URI not set in environment.');
  process.exit(1);
}

function redactedHost(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return '<unparseable>';
  }
}

function rawRpc(method: string, params: unknown[]): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const req = https.request(
      HTTPS_URL as string,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: data });
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const MAX_CAPTURES = Number(process.env.PUMP_LIVE_CAPTURE_MAX ?? 5);
const TIMEOUT_MS = Number(process.env.PUMP_LIVE_CAPTURE_TIMEOUT_MS ?? 90_000);
const MIN_SPACING_MS = Number(process.env.PUMP_LIVE_CAPTURE_SPACING_MS ?? 3_000);

let captured = 0;
let notificationsSeen = 0;
let notificationsDropped = 0; // arrived while the queue already had a pending item
let rateLimited = 0;
let otherErrors = 0;
const seenIdentities = new Set<string>();
const latencies: number[] = [];

let queueBusy = false;
let lastRequestAt = 0;
const pending: Array<{ signature: string; notifiedAtMs: number }> = [];

async function drainQueue() {
  if (queueBusy) return;
  queueBusy = true;
  while (pending.length > 0) {
    const item = pending.shift()!;
    const waitFor = Math.max(0, lastRequestAt + MIN_SPACING_MS - Date.now());
    if (waitFor > 0) await new Promise((r) => setTimeout(r, waitFor));
    lastRequestAt = Date.now();
    await processOne(item.signature, item.notifiedAtMs);
  }
  queueBusy = false;
}

async function processOne(signature: string, notifiedAtMs: number) {
  const r = await rawRpc('getTransaction', [
    signature,
    { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
  ]);
  if (r.status === 429) {
    rateLimited++;
    return;
  }
  if (r.status !== 200 || !r.body?.result) {
    otherErrors++;
    return;
  }
  const fetchedAtMs = Date.now();
  const tx = r.body.result as RawTransactionLike;
  const events = findEvents(tx);
  for (const env of events) {
    const identity = eventIdentityOf(env);
    const key = eventIdentityKey(identity);
    if (seenIdentities.has(key)) continue;
    seenIdentities.add(key);

    const trade = normalizeTradeEvent(env, tx, new Date().toISOString());
    const latencyMs = fetchedAtMs - notifiedAtMs;
    latencies.push(latencyMs);
    captured++;

    console.log(
      `CAPTURED #${captured}: event=${env.eventName} program=${env.emittingProgram} ` +
        `sig=${signature.slice(0, 16)}… slot=${tx.slot} txPos=${tx.transactionIndex ?? 'n/a'} ` +
        `notify→fetch=${latencyMs}ms` +
        (trade
          ? ` trade={mint:${trade.mint}, side:${trade.side}, tokenAmount:${trade.tokenAmount}, quoteAmount:${trade.quoteAmount}, priceQuote:${trade.priceQuote}}`
          : ' (non-trade event)'),
    );
  }
}

async function main() {
  console.log('WSS host:', redactedHost(WSS as string));
  console.log('HTTPS host:', redactedHost(HTTPS_URL as string));
  console.log(
    `Serial queue, min ${MIN_SPACING_MS}ms between getTransaction calls, no client-side retry on 429. ` +
      `Capturing up to ${MAX_CAPTURES} real decoded events (timeout ${TIMEOUT_MS}ms)...`,
  );

  const ws = new WebSocket(WSS as string);

  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* noop */
      }
      resolve();
    };
    const timer = setTimeout(done, TIMEOUT_MS);

    ws.on('open', () => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [PUMP_PROGRAM_ID] }, { commitment: 'confirmed' }] }));
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'logsSubscribe', params: [{ mentions: [PUMPSWAP_PROGRAM_ID] }, { commitment: 'confirmed' }] }));
    });

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.method !== 'logsNotification') return;
      const val = msg.params.result.value;
      if (val.err !== null) return;
      notificationsSeen++;
      if (pending.length > 0) {
        notificationsDropped++; // bounded queue: drop rather than grow unboundedly (backpressure)
        return;
      }
      pending.push({ signature: val.signature, notifiedAtMs: Date.now() });
      drainQueue().then(() => {
        if (captured >= MAX_CAPTURES) done();
      });
    });

    ws.on('error', (e) => console.log('WS error:', e.message));
  });

  console.log('\n=== Summary ===');
  console.log('Notifications observed:', notificationsSeen);
  console.log('Notifications dropped (queue busy — backpressure):', notificationsDropped);
  console.log('getTransaction calls rate-limited (429):', rateLimited);
  console.log('getTransaction calls with other errors:', otherErrors);
  console.log('Real decoded events captured:', captured);
  if (latencies.length > 0) {
    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    console.log(`notify→fetch latency: min=${Math.min(...latencies)}ms max=${Math.max(...latencies)}ms avg=${avg.toFixed(0)}ms`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.log('FATAL:', e.message);
  process.exit(1);
});
