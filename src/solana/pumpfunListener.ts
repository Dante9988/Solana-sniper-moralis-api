/**
 * Phase 7E.4.3 §2/§7 — live observation plus recovery, both feeding one engine.
 *
 * LIVE      `logsSubscribe` over the configured endpoint's WebSocket: one subscription for the
 *           Pump.fun program, plus one per KNOWN GRADUATED POOL.
 * RECOVERY  `getSignaturesForAddress` walked back to the persisted checkpoint slot.
 *
 * A graduated token's trades no longer mention the bonding-curve program at all, so Pump.fun alone
 * would make every token go silent the moment it graduated (§14). But subscribing to the whole
 * PumpSwap program is the wrong correction, measured rather than assumed: doing so took observation
 * from ~78 notifications/s to ~640/s and the fetcher dropped 62,256 of them in a 210-second run,
 * because PumpSwap is a general AMM and almost all of that traffic is pools this product does not
 * track.
 *
 * So PumpSwap is observed per pool. The set of pools is exactly the set of pools a migration event
 * proved (`TokenLifecycleState.pumpswapPool`), which is the same rule as everywhere else here:
 * nothing is observed, stored or claimed for a pool we have no proof belongs to one of our tokens.
 * New pools are picked up as tokens graduate, and re-subscribed after a reconnect.
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

import { PUMPSWAP_PROGRAM_ID, PUMP_PROGRAM_ID } from "../pump/discriminators";
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
  /** Upper bound on PumpSwap pools one recovery sweep will walk, most recently graduated first. */
  readonly maxRecoveryPools: number;
  /** Upper bound on late create backfills per sweep — each one pages a mint's whole history. */
  readonly maxCreateBackfillsPerSweep: number;
  /** Upper bound on live pool subscriptions. Beyond it, older graduated pools rely on recovery. */
  readonly maxPoolSubscriptions: number;
  /** How often the pool subscription set is reconciled against newly graduated tokens. */
  readonly poolSyncIntervalMs: number;
  /** WebSocket reconnect backoff bounds. */
  readonly reconnectMinMs: number;
  readonly reconnectMaxMs: number;
}

/**
 * The programs recovery handles, in order.
 *
 * Pump.fun first on purpose: a create has to be persisted before its token's trades can be, and
 * recovery processes oldest-first within each program.
 */
export const OBSERVED_PROGRAMS: readonly string[] = [PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID];

/** The only program subscribed to wholesale. PumpSwap is subscribed per pool — see this file's header. */
export const SUBSCRIBED_PROGRAMS: readonly string[] = [PUMP_PROGRAM_ID];

/**
 * How each program's missed transactions are found again — and it is NOT the same for both.
 *
 * Measured against the configured endpoint on 2026-09-26, reproducibly, at every commitment and with
 * and without options:
 *
 *   getSignaturesForAddress(6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P)  -> 10,000   (pump.fun)
 *   getSignaturesForAddress(pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA)  ->      0   (PumpSwap)
 *   getSignaturesForAddress(3oP7CokyBZjwA14iTjaTSHitmF5UWkWaGjZqp5Xxentt) ->      5   (a pool)
 *   getSignaturesForAddress(So11111111111111111111111111111111111111112)  ->      0   (wSOL mint)
 *
 * The node's account index excludes some very hot accounts — wSOL returning 0 shows this is a
 * "too hot to index" exclusion rather than anything specific to PumpSwap. `logsSubscribe` is a live
 * filter and not affected, so PumpSwap is observed live perfectly well; it is only *recovery* that
 * cannot ask the program id.
 *
 * The danger is that the call does not fail — it returns an empty list, which a program-wide walk
 * reads as "already caught up". That is precisely the silent gap this phase exists to avoid, so
 * PumpSwap is recovered per POOL instead: pool addresses are indexed, and every pool we care about
 * was named by the migration event that proved the token graduated.
 */
export type RecoveryStrategy = "byProgramId" | "byKnownPool";

export const RECOVERY_STRATEGY: Readonly<Record<string, RecoveryStrategy>> = {
  [PUMP_PROGRAM_ID]: "byProgramId",
  [PUMPSWAP_PROGRAM_ID]: "byKnownPool",
};

export const DEFAULT_PUMPFUN_LISTENER_CONFIG: PumpfunListenerConfig = {
  fetchConcurrency: 8,
  maxQueueDepth: 2_000,
  headRefreshMs: 10_000,
  recoveryIntervalMs: 60_000,
  maxRecoverySignatures: 5_000,
  maxRecoveryPools: 50,
  maxCreateBackfillsPerSweep: 10,
  maxPoolSubscriptions: 200,
  poolSyncIntervalMs: 20_000,
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
    maxRecoveryPools: int(env.SOLANA_PUMPFUN_MAX_RECOVERY_POOLS, DEFAULT_PUMPFUN_LISTENER_CONFIG.maxRecoveryPools),
    maxCreateBackfillsPerSweep: int(env.SOLANA_PUMPFUN_MAX_CREATE_BACKFILLS, DEFAULT_PUMPFUN_LISTENER_CONFIG.maxCreateBackfillsPerSweep),
    maxPoolSubscriptions: int(env.SOLANA_PUMPFUN_MAX_POOL_SUBSCRIPTIONS, DEFAULT_PUMPFUN_LISTENER_CONFIG.maxPoolSubscriptions),
    poolSyncIntervalMs: int(env.SOLANA_PUMPFUN_POOL_SYNC_INTERVAL_MS, DEFAULT_PUMPFUN_LISTENER_CONFIG.poolSyncIntervalMs),
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
  private subscriptionId = 0;
  private readonly subscribedPools = new Set<string>();

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

    await this.assertProgramIndexUsable();

    this.workers = Array.from({ length: this.config.fetchConcurrency }, () => this.worker());
    this.timers.push(setInterval(() => void this.engine.refreshHeads().catch((e) => this.metrics.recordError(String(e))), this.config.headRefreshMs));
    this.timers.push(setInterval(() => void this.runRecovery().catch((e) => this.metrics.recordError(String(e))), this.config.recoveryIntervalMs));
    // Picks up pools of tokens that graduate mid-run, so a new chart starts updating without a restart.
    this.timers.push(setInterval(() => void this.syncPoolSubscriptions().catch((e) => this.metrics.recordError(String(e))), this.config.poolSyncIntervalMs));

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
      for (const program of SUBSCRIBED_PROGRAMS) this.subscribe(socket, program);
      // A reconnect resets every subscription, so the pool set is rebuilt rather than assumed.
      this.subscribedPools.clear();
      void this.syncPoolSubscriptions().catch((error) => this.metrics.recordError(String(error)));
      this.log(`[pumpfun] subscribed host=${this.rpc.host} programs=${SUBSCRIBED_PROGRAMS.length}`);
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

  /**
   * Fills in the `DiscoveredToken` row for tokens this backend has lifecycle proof of but never saw
   * created — overwhelmingly tokens that graduated before observation began.
   *
   * Bounded per sweep, most recently active first. A token whose create cannot be reached is counted
   * and left alone rather than retried indefinitely within one sweep.
   */
  private async backfillMissingCreates(): Promise<number> {
    const candidates = await this.db.tokenLifecycleState.findMany({
      orderBy: { lastEventSlot: "desc" },
      take: this.config.maxRecoveryPools,
      select: { mint: true },
    });
    if (candidates.length === 0) return 0;

    const known = new Set(
      (
        await this.db.discoveredToken.findMany({
          where: { chain: "solana", tokenAddress: { in: candidates.map((c) => c.mint) } },
          select: { tokenAddress: true },
        })
      ).map((row) => row.tokenAddress)
    );

    let backfilled = 0;
    for (const candidate of candidates.filter((c) => !known.has(c.mint)).slice(0, this.config.maxCreateBackfillsPerSweep)) {
      const result = await this.engine.backfillTokenCreate(candidate.mint);
      if (result.status === "BACKFILLED") {
        this.metrics.increment("createsBackfilled");
        backfilled += 1;
        this.log(`[pumpfun] backfilled the create for ${candidate.mint}`);
      } else {
        this.metrics.increment("createBackfillUnresolved");
      }
    }
    return backfilled;
  }

  /**
   * Checks that every program recovered `byProgramId` really is indexed by this node.
   *
   * `getSignaturesForAddress` on an unindexed address returns an empty list rather than an error, so
   * a provider change could turn recovery into a no-op that reports itself healthy — the exact silent
   * gap this phase is built to prevent. This makes that condition loud at startup instead.
   */
  private async assertProgramIndexUsable(): Promise<void> {
    for (const [program, strategy] of Object.entries(RECOVERY_STRATEGY)) {
      if (strategy !== "byProgramId") continue;
      const probe = await this.rpc.getSignaturesForAddress(program, { limit: 1, commitment: "confirmed" });
      if (probe.status !== "OK") {
        this.metrics.recordError(`recovery index probe failed for ${program}: ${probe.reason}`);
        continue;
      }
      if (probe.data.length === 0) {
        const message = `this node does not index signatures for ${program}, so recovery by program id would silently find nothing — recovery for it is degraded until an indexed strategy is configured`;
        this.log(`[pumpfun] WARNING ${message}`);
        this.metrics.recordError(message);
      }
    }
  }

  /**
   * The PumpSwap pools worth recovering: those a migration event proved, most recently graduated
   * first, capped.
   *
   * Only pools this backend has seen a token graduate into are walked. That is deliberate — it is
   * the same rule as everywhere else in this phase (nothing is inferred about a pool we have no
   * proof of), and it keeps the sweep proportional to the tokens we actually track rather than to
   * the whole of PumpSwap.
   */
  private async knownPools(): Promise<string[]> {
    const rows = await this.db.tokenLifecycleState.findMany({
      where: { state: "pumpswap", pumpswapPool: { not: null } },
      orderBy: { lastEventSlot: "desc" },
      take: this.config.maxRecoveryPools,
      select: { pumpswapPool: true },
    });
    return rows.map((row) => row.pumpswapPool!).filter((pool, index, all) => all.indexOf(pool) === index);
  }

  /** Pages back through one address's signatures until the checkpoint slot, or the budget runs out. */
  private async walkSignatures(
    address: string,
    floorSlot: bigint,
    budget: number
  ): Promise<{ signatures: string[]; scanned: number; reachedFloor: boolean }> {
    const signatures: string[] = [];
    let before: string | undefined;
    let scanned = 0;
    let reachedFloor = false;

    while (scanned < budget) {
      const page = await this.rpc.getSignaturesForAddress(address, { limit: 1_000, before, commitment: "confirmed" });
      if (page.status !== "OK") {
        this.metrics.recordError(`recovery: ${page.reason}`);
        break;
      }
      if (page.data.length === 0) {
        // Genuinely nothing newer than the checkpoint for this address. Note that an address the
        // node does not index also returns an empty list — which is why a program id is only ever
        // walked when RECOVERY_STRATEGY says its index is known to work.
        reachedFloor = true;
        break;
      }
      for (const entry of page.data) {
        scanned += 1;
        if (BigInt(entry.slot) <= floorSlot) {
          reachedFloor = true;
          break;
        }
        if (entry.err) continue;
        signatures.push(entry.signature);
      }
      if (reachedFloor) break;
      before = page.data[page.data.length - 1].signature;
    }

    return { signatures, scanned, reachedFloor };
  }

  /** Sends one `logsSubscribe` for an address. Subscription ids are not tracked: nothing unsubscribes. */
  private subscribe(socket: WebSocket, address: string): void {
    this.subscriptionId += 1;
    socket.send(
      JSON.stringify({ jsonrpc: "2.0", id: this.subscriptionId, method: "logsSubscribe", params: [{ mentions: [address] }, { commitment: "confirmed" }] })
    );
  }

  /**
   * Subscribes to the pools of every token a migration event proved graduated, up to a cap.
   *
   * Called on connect and on a timer, so a token that graduates mid-run starts being followed without
   * a restart. Pools are never unsubscribed: a graduated token keeps trading, and its chart should
   * not go dark because newer tokens graduated after it.
   */
  async syncPoolSubscriptions(): Promise<number> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return 0;

    const rows = await this.db.tokenLifecycleState.findMany({
      where: { state: "pumpswap", pumpswapPool: { not: null } },
      orderBy: { lastEventSlot: "desc" },
      take: this.config.maxPoolSubscriptions,
      select: { pumpswapPool: true },
    });

    let added = 0;
    for (const row of rows) {
      const pool = row.pumpswapPool!;
      if (this.subscribedPools.has(pool)) continue;
      if (this.subscribedPools.size >= this.config.maxPoolSubscriptions) {
        this.log(`[pumpfun] pool subscription cap (${this.config.maxPoolSubscriptions}) reached; older graduated pools are covered by recovery only`);
        break;
      }
      this.subscribe(socket, pool);
      this.subscribedPools.add(pool);
      added += 1;
    }
    if (added > 0) this.log(`[pumpfun] following ${added} new graduated pool(s), ${this.subscribedPools.size} total`);
    return added;
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

      // Before walking pools, make sure the tokens those pools belong to actually exist as rows —
      // otherwise their trades are dropped at the barrier and the sweep achieves nothing.
      processed += await this.backfillMissingCreates();

      const store = new CheckpointStore(this.db);
      const checkpoint = await store.get(PUMPFUN_CHECKPOINT_SOURCE);
      if (!checkpoint) {
        // No checkpoint yet: this is a first run, and there is no gap to close. Local development
        // deliberately starts at the head rather than replaying the chain's whole history.
        this.log("[pumpfun] no checkpoint yet — starting from the live head");
        return { scanned: 0, processed, reachedCheckpoint: true };
      }

      const floor = checkpoint.lastHeight;
      let scanned = 0;
      let reachedCheckpoint = true;

      // Pump.fun's transactions are found by program id; PumpSwap's cannot be (see RECOVERY_STRATEGY)
      // and are found per pool. Pump.fun runs first, so a create lands before its token's trades.
      const budgetPerProgram = Math.max(1, Math.floor(this.config.maxRecoverySignatures / OBSERVED_PROGRAMS.length));
      for (const program of OBSERVED_PROGRAMS) {
        const addresses =
          RECOVERY_STRATEGY[program] === "byProgramId" ? [program] : await this.knownPools();
        if (addresses.length === 0) continue;

        const budgetPerAddress = Math.max(1, Math.floor(budgetPerProgram / addresses.length));
        for (const address of addresses) {
          const walk = await this.walkSignatures(address, floor, budgetPerAddress);
          scanned += walk.scanned;
          if (!walk.reachedFloor) reachedCheckpoint = false;
          // Oldest first, so a token exists before its trades are considered.
          for (const signature of walk.signatures.reverse()) {
            const outcome = await this.engine.processSignature(signature, "historical backfill");
            if (outcome.status === "PERSISTED") processed += 1;
          }
        }
      }

      if (!reachedCheckpoint) {
        this.log(`[pumpfun] recovery hit its per-address signature cap before reaching the checkpoint; a gap remains`);
      }
      return { scanned, processed, reachedCheckpoint };
    } finally {
      this.recovering = false;
    }
  }
}
