/**
 * Phase 7B.2 — thin helper wrapping EventBus + eventEnvelope for job
 * lifecycle events, so call sites (the scan-enqueue route, the forensics
 * worker) never build a channel name or an envelope by hand.
 */

import { EventBus } from "./eventBus";
import { createRealtimeEvent, RealtimeEventType } from "./eventEnvelope";
import type { CandleResolutionId } from "../../candles/resolutions";
import type { PersistedCandleChange } from "../../candles/persistCandles";

export function jobChannel(jobKey: string): string {
  return `job:${jobKey}`;
}

export async function publishJobEvent(
  bus: EventBus,
  type: Exclude<RealtimeEventType, "connection.ready">,
  data: { jobKey: string; mint: string } & Record<string, unknown>
): Promise<void> {
  const event = createRealtimeEvent(type, data);
  await bus.publish(jobChannel(data.jobKey), event);
}

/**
 * Phase 7B.5B §14 — public market data, not user-owned: unlike `jobChannel`
 * (gated by `userOwnsJob` in websocketServer.ts), any authenticated
 * WebSocket connection may subscribe to any (chain, tokenAddress,
 * resolution) — the same read-access boundary as the REST candle route
 * itself, never weaker.
 */
export function candleChannel(chain: string, tokenAddress: string, resolution: CandleResolutionId): string {
  return `candle:${chain}:${tokenAddress}:${resolution}`;
}

export interface CandleUpdatedEventInput {
  readonly chain: string;
  readonly tokenAddress: string;
  readonly quoteAddress: string;
  readonly resolution: CandleResolutionId;
  readonly candle: PersistedCandleChange;
}

/** Builds and publishes one `token.candle.updated` event — the complete latest candle snapshot, a deterministic sequence (the row's own `revision`), and an observed timestamp (phase7b5b.txt §14). */
export async function publishCandleEvent(bus: EventBus, input: CandleUpdatedEventInput): Promise<void> {
  const data = {
    chain: input.chain,
    tokenAddress: input.tokenAddress,
    quoteAddress: input.quoteAddress,
    resolution: input.resolution,
    sequence: input.candle.revision,
    candle: {
      startTime: input.candle.bucketStart,
      open: input.candle.candle.open,
      high: input.candle.candle.high,
      low: input.candle.candle.low,
      close: input.candle.candle.close,
      volumeToken: input.candle.candle.volumeToken,
      volumeQuote: input.candle.candle.volumeQuote,
      volumeUsd: input.candle.candle.volumeUsd,
      trades: input.candle.candle.tradeCount,
      uniqueTraders: input.candle.candle.uniqueTraders,
      status: input.candle.status === "FINAL" ? "final" : "provisional",
      updatedAt: new Date().toISOString(),
    },
  };
  const event = createRealtimeEvent(RealtimeEventType.TOKEN_CANDLE_UPDATED, data);
  await bus.publish(candleChannel(input.chain, input.tokenAddress, input.resolution), event);
}
