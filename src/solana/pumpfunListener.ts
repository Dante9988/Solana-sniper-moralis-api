/**
 * Phase 7E.4.3 §2/§7 — live observation plus recovery, both feeding one engine.
 *
 * LIVE      `logsSubscribe(mentions: [pump.fun])` over the configured endpoint's WebSocket.
 * RECOVERY  `getSignaturesForAddress(pump.fun)` walked back to the persisted checkpoint slot.
 *
 * Both hand signatures to `PumpfunIngestionEngine.processSignature`. There is no second decoder,
 * no second persister and no second set of rules — the only difference is the `source` label.
 *
 * Recovery runs on every connect, on every reconnect, and on a timer. That ordering matters: a
 * WebSocket that drops for 40 seconds silently misses ~2,000 notifications (measured rate:
 * 77.7/s, of which ~56/s are successful transactions), and a live-only listener has no way to
 * know it happened. The checkpoint is the thing that knows.
 *
 * Measured against mainnet on 2026-09-26, for the numbers this file's defaults come from:
 *   77.7 notifications/s observed, 44% of them transactions the chain rejected
 *   ~56 successful transactions/s, i.e. ~56 getTransaction calls/s to follow everything
 *   confirmed head ran ~32 slots ahead of finalized
 */

import WebSocket from "ws";
import type { PrismaClient } from "@prisma/client";

import { PUMP_PROGRAM_ID } from "../pump/discriminators";
import { CheckpointStore } from "../pons/checkpointStore";
import { PUMPFUN_CHECKPOINT_SOURCE, PumpfunIngestionEngine } from "./pumpfunIngestionEngine";
import type { PumpfunEngineConfig } from "./pumpfunIngestionEngine";
import { SolanaIngestionMetrics } from "./pumpfunMetrics";
import type { SolanaIngestionSnapshot } from "./pumpfunMetrics";
import { SolanaRpc, resolveSolanaRpcEndpoint } from "./rpc";

export interface PumpfunListenerConfig {
  /** Concurrent `getTransaction` calls. The live stream needs ~56/s to keep up. */
  readonly fetchConcurrency: number;
  /** Bounded queue. Overflow is counted and covered by recovery, never silently dropped. */
  readonly maxQueueDepth: number;
  /** How often to re-read the confirmed/finalized heads. */
  readonly headRefreshMs: number;
  /** How often recovery sweeps for anything live observation missed. */
  readonly recoveryIntervalMs: number;
  /** Upper bound on signatures one recovery sweep will walk back through. */
  readonly maxRecoverySignatures: number;
  /** WebSocket reconnect backoff bounds. */
  readonly reconnectMinMs: number;
  readonly reconnectMaxMs: number;
}

export const DEFAULT_PUMPFUN_LISTENER_CONFIG: PumpfunListenerConfig = {
  fetchConcurrency: 8,
  maxQueueDepth: 2_000,
  headRefreshMs: 10_000,
  recoveryIntervalMs: 60_000,
  maxRecoverySignatures: 5_000,
  reconnectMinMs: 1_000,
  reconnectMaxMs: 30_000,
};

export function resolvePumpfunListenerConfig(env: NodeJS.ProcessEnv = process.env): PumpfunListenerConfig {
  const int = (raw: string | undefined, fallback: number): number => {
    const value = Number(raw);
    return Number.isInteger(value) && value > 0 ? value : fallback;
  };
  return {
    fetchConcurrency: int(env.SOLANA_PUMPFUN_FETCH_CONCURRENCY, DEFAULT_PUMPFUN_LISTENER_CONFIG.fetchConcurrency),
    maxQueueDepth: int(env.SOLANA_PUMPFUN_MAX_QUEUE_DEPTH, DEFAULT_PUMPFUN_LISTENER_CONFIG.maxQueueDepth),
    headRefreshMs: int(env.SOLANA_PUMPFUN_HEAD_REFRESH_MS, DEFAULT_PUMPFUN_LISTENER_CONFIG.headRefreshMs),
    recoveryIntervalMs: int(env.SOLANA_PUMPFUN_RECOVERY_INTERVAL_MS, DEFAULT_PUMPFUN_LISTENER_CONFIG.recoveryIntervalMs),
    maxRecoverySignatures: int(env.SOLANA_PUMPFUN_MAX_RECOVERY_SIGNATURES, DEFAULT_PUMPFUN_LISTENER_CONFIG.maxRecoverySignatures),
    reconnectMinMs: DEFAULT_PUMPFUN_LISTENER_CONFIG.reconnectMinMs,
    reconnectMaxMs: DEFAULT_PUMPFUN_LISTENER_CONFIG.reconnectMaxMs,
  };
}

export interface PumpfunListenerDeps {
  readonly db: PrismaClient;
  readonly rpc?: SolanaRpc;
  readonly metrics?: SolanaIngestionMetrics;
  readonly config?: Partial<PumpfunListenerConfig>;
  readonly engineConfig?: Partial<PumpfunEngineConfig>;
  readonly log?: (line: string) => void;
}

export class PumpfunListener {
  private readonly db: PrismaClient;
  private readonly rpc: SolanaRpc;
  private readonly metrics: SolanaIngestionMetrics;
  private readonly engine: PumpfunIngestionEngine;
  private readonly config: PumpfunListenerConfig;
  private readonly log: (line: string) => void;

  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private socket: WebSocket | null = null;
  private workers: Promise<void>[] = [];
  private timers: NodeJS.Timeout[] = [];
  private running = false;
  private reconnectDelayMs: number;
  private recovering = false;

  constructor(deps: PumpfunListenerDeps) {
    const endpoint = resolveSolanaRpcEndpoint();
    if (!deps.rpc && !endpoint) throw new Error("SOLANA_RPC_ENDPOINT is not configured");
    this.db = deps.db;
    this.rpc = deps.rpc ?? new SolanaRpc(endpoint!);
    this.metrics = deps.metrics ?? new SolanaIngestionMetrics();
    this.config = { ...DEFAULT_PUMPFUN_LISTENER_CONFIG, ...resolvePumpfunListenerConfig(), ...deps.config };
    this.log = deps.log ?? ((line) => console.log(line));
    this.engine = new PumpfunIngestionEngine({ db: deps.db, rpc: this.rpc, metrics: this.metrics, config: deps.engineConfig });
    this.reconnectDelayMs = this.config.reconnectMinMs;
  }

  snapshot(): SolanaIngestionSnapshot {
    return this.metrics.snapshot();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    // Heads first: the engine cannot decide provisional vs final without the finalized slot.
    await this.engine.refreshHeads();
    this.log(`[pumpfun] starting host=${this.rpc.host} concurrency=${this.config.fetchConcurrency}`);

    this.workers = Array.from({ length: this.config.fetchConcurrency }, () => this.worker());
    this.timers.push(setInterval(() => void this.engine.refreshHeads().catch((e) => this.metrics.recordError(String(e))), this.config.headRefreshMs));
    this.timers.push(setInterval(() => void this.runRecovery().catch((e) => this.metrics.recordError(String(e))), this.config.recoveryIntervalMs));

    this.connect();
    // Cover whatever happened while the process was down, before trusting the live stream.
    await this.runRecovery();
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.socket?.close();
    this.socket = null;
    await Promise.all(this.workers);
    this.workers = [];
  }

  private connect(): void {
    if (!this.running) return;
    const socket = new WebSocket(this.rpc.wsUrl);
    this.socket = socket;

    socket.on("open", () => {
      this.reconnectDelayMs = this.config.reconnectMinMs;
      socket.send(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "logsSubscribe", params: [{ mentions: [PUMP_PROGRAM_ID] }, { commitment: "confirmed" }] })
      );
      this.log(`[pumpfun] subscribed host=${this.rpc.host}`);
      // A reconnect means a gap of unknown length. Close it from the checkpoint, not from hope.
      void this.runRecovery().catch((error) => this.metrics.recordError(String(error)));
    });

    socket.on("message", (data) => this.onNotification(data.toString()));

    socket.on("close", () => {
      if (!this.running) return;
      const delay = this.reconnectDelayMs;
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.config.reconnectMaxMs);
      this.log(`[pumpfun] socket closed, reconnecting in ${delay}ms`);
      this.timers.push(setTimeout(() => this.connect(), delay) as unknown as NodeJS.Timeout);
    });

    socket.on("error", (error) => {
      // Never log the URL — it carries the API key.
      this.metrics.recordError(`websocket: ${error.message}`);
    });
  }

  private onNotification(raw: string): void {
    let message: { method?: string; params?: { result: { value: { signature: string; err: unknown } } } };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.method !== "logsNotification" || !message.params) return;

    this.metrics.increment("observed");
    const value = message.params.result.value;
    if (value.err) {
      // A rejected transaction fired no events; `findEvents` refuses them anyway. Counted so the
      // observed total stays reconcilable.
      this.metrics.increment("observedFailedTx");
      return;
    }
    this.enqueue(value.signature);
  }

  private enqueue(signature: string): void {
    // Duplicate frames for one signature are normal; the DB would absorb them, but skipping the
    // fetch saves the call.
    if (this.queued.has(signature)) return;
    if (this.queue.length >= this.config.maxQueueDepth) {
      this.metrics.increment("queueOverflowed");
      return;
    }
    this.queued.add(signature);
    this.queue.push(signature);
  }

  private async worker(): Promise<void> {
    while (this.running || this.queue.length > 0) {
      const signature = this.queue.shift();
      if (!signature) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        continue;
      }
      try {
        await this.engine.processSignature(signature, "live stream");
      } catch (error) {
        this.metrics.recordError(error instanceof Error ? error.message : String(error));
      } finally {
        this.queued.delete(signature);
      }
    }
  }

  /**
   * Re-walks the program's signatures back to the checkpoint slot and processes anything the live
   * stream did not.
   *
   * Uses the checkpoint's SLOT rather than a stored signature cursor: `getSignaturesForAddress`
   * returns each entry's slot, so the stop condition is a comparison, with no extra column and no
   * risk of a cursor signature having been dropped from the chain. Re-processing the boundary slot
   * is free — every write is keyed on canonical identity.
   */
  async runRecovery(): Promise<{ scanned: number; processed: number; reachedCheckpoint: boolean }> {
    if (this.recovering) return { scanned: 0, processed: 0, reachedCheckpoint: false };
    this.recovering = true;
    try {
      // Anything live observation could not resolve gets another chance first; by now the
      // transaction has almost certainly become visible.
      let processed = 0;
      for (const signature of this.engine.deferredSignatures) {
        const outcome = await this.engine.processSignature(signature, "block reconciliation");
        if (outcome.status === "PERSISTED") processed += 1;
      }

      const store = new CheckpointStore(this.db);
      const checkpoint = await store.get(PUMPFUN_CHECKPOINT_SOURCE);
      if (!checkpoint) {
        // No checkpoint yet: this is a first run, and there is no gap to close. Local development
        // deliberately starts at the head rather than replaying the chain's whole history.
        this.log("[pumpfun] no checkpoint yet — starting from the live head");
        return { scanned: 0, processed, reachedCheckpoint: true };
      }

      const floor = checkpoint.lastHeight;
      const pending: string[] = [];
      let before: string | undefined;
      let scanned = 0;
      let reachedCheckpoint = false;

      while (scanned < this.config.maxRecoverySignatures) {
        const page = await this.rpc.getSignaturesForAddress(PUMP_PROGRAM_ID, { limit: 1_000, before, commitment: "confirmed" });
        if (page.status !== "OK") {
          this.metrics.recordError(`recovery: ${page.status === "FAILED" ? page.reason : page.reason}`);
          break;
        }
        if (page.data.length === 0) {
          reachedCheckpoint = true;
          break;
        }
        for (const entry of page.data) {
          scanned += 1;
          if (BigInt(entry.slot) <= floor) {
            reachedCheckpoint = true;
            break;
          }
          if (entry.err) continue;
          pending.push(entry.signature);
        }
        if (reachedCheckpoint) break;
        before = page.data[page.data.length - 1].signature;
      }

      // Oldest first, so the token exists before its trades are considered.
      for (const signature of pending.reverse()) {
        const outcome = await this.engine.processSignature(signature, "historical backfill");
        if (outcome.status === "PERSISTED") processed += 1;
      }

      if (!reachedCheckpoint) {
        this.log(`[pumpfun] recovery hit its ${this.config.maxRecoverySignatures}-signature cap before reaching the checkpoint; a gap remains`);
      }
      return { scanned, processed, reachedCheckpoint };
    } finally {
      this.recovering = false;
    }
  }
}
