import { randomUUID } from "crypto";
import { TokenDiscoveryEvent, TokenIntelligenceReport } from "../intelligence/types";
import { processTokenDiscoveryEvent } from "../intelligence/orchestrator";
import { PUMPSWAP_PROGRAM_ID, PUMP_FUN_RAYDIUM_MIGRATION } from "./pumpSwapDetection";

export interface TokenIntelligenceDispatcherOptions {
  processEvent?: (event: TokenDiscoveryEvent) => Promise<TokenIntelligenceReport>;
  maxConcurrent?: number;
  timeoutMs?: number;
  maxProcessedDiscoveries?: number;
  now?: () => Date;
  idFactory?: () => string;
}

// Evidence-based source classification (see ARCHITECTURE.md §3.2/§12): only
// maps to PUMPSWAP/MIGRATION when the matched pool's program id is the real,
// known program for that source; otherwise falls back to UNKNOWN instead of
// guessing. The only currently-enabled pool config ("pumpswap"/pump1)
// actually subscribes to the Pump.fun bonding-curve program, not the real
// PumpSwap AMM, so its CreatePool logs cannot be proven as PUMPSWAP.
export function deriveTokenSource(programId: string | undefined): TokenDiscoveryEvent["source"] {
  if (programId === PUMPSWAP_PROGRAM_ID.toBase58()) return "PUMPSWAP";
  if (programId === PUMP_FUN_RAYDIUM_MIGRATION.toBase58()) return "MIGRATION";
  return "UNKNOWN";
}

/**
 * Fire-and-forget dispatcher to the token intelligence pipeline. Bounded
 * concurrency + timeout + signature/mint dedup live here so the WebSocket
 * listener can call `dispatch` synchronously without awaiting research and
 * without risk of crashing or an unhandled promise rejection.
 */
export function createTokenIntelligenceDispatcher(options: TokenIntelligenceDispatcherOptions = {}) {
  const processEvent = options.processEvent ?? processTokenDiscoveryEvent;
  const maxConcurrent = options.maxConcurrent ?? 3;
  const timeoutMs = options.timeoutMs ?? 20000;
  const maxProcessedDiscoveries = options.maxProcessedDiscoveries ?? 1000;
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;

  const processedDiscoveries = new Set<string>();
  let activeJobs = 0;

  function dispatch(
    signature: string,
    mint: string,
    programId: string | undefined,
    rawPayload: unknown
  ): void {
    const key = `${signature}:${mint}`;
    if (processedDiscoveries.has(key)) {
      return;
    }
    processedDiscoveries.add(key);
    if (processedDiscoveries.size > maxProcessedDiscoveries) {
      const first = processedDiscoveries.values().next().value;
      if (first) processedDiscoveries.delete(first);
    }

    if (activeJobs >= maxConcurrent) {
      console.log(`⏳ Intelligence pipeline at capacity (${maxConcurrent}), skipping research for ${mint}`);
      return;
    }

    const event: TokenDiscoveryEvent = {
      id: idFactory(),
      source: deriveTokenSource(programId),
      signature,
      mint,
      discoveredAt: now(),
      receivedAt: now(),
      rawPayload,
    };

    activeJobs++;
    let slotReleased = false;
    const releaseSlot = () => {
      if (!slotReleased) {
        slotReleased = true;
        activeJobs--;
      }
    };

    // Always attach a catch directly to the real promise so it can never
    // become an unhandled rejection, independent of the timeout race below.
    // processEvent is also guarded with try/catch in case a worker throws
    // synchronously instead of returning a rejected promise — either way,
    // dispatch() itself must never throw back into the caller.
    let researchPromise: Promise<void>;
    try {
      researchPromise = processEvent(event)
        .then(() => undefined)
        .catch((err) => {
          console.error(
            `TokenIntelligence: research failed for ${mint} (${event.id}):`,
            err instanceof Error ? err.message : String(err)
          );
        });
    } catch (err) {
      console.error(
        `TokenIntelligence: research pipeline threw synchronously for ${mint} (${event.id}):`,
        err instanceof Error ? err.message : String(err)
      );
      releaseSlot();
      return;
    }

    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        if (!slotReleased) {
          console.error(
            `TokenIntelligence: research timed out after ${timeoutMs}ms for ${mint} (${event.id}); freeing concurrency slot, work continues in background`
          );
        }
        resolve();
      }, timeoutMs);
    });

    Promise.race([researchPromise, timeoutPromise]).finally(releaseSlot);
  }

  return {
    dispatch,
    get activeJobs() {
      return activeJobs;
    },
    get processedCount() {
      return processedDiscoveries.size;
    },
  };
}

export const defaultTokenIntelligenceDispatcher = createTokenIntelligenceDispatcher();
export const dispatchTokenIntelligence = defaultTokenIntelligenceDispatcher.dispatch;
