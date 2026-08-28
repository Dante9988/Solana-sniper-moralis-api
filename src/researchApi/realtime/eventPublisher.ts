/**
 * Phase 7B.2 — thin helper wrapping EventBus + eventEnvelope for job
 * lifecycle events, so call sites (the scan-enqueue route, the forensics
 * worker) never build a channel name or an envelope by hand.
 */

import { EventBus } from "./eventBus";
import { createRealtimeEvent, RealtimeEventType } from "./eventEnvelope";

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
