/**
 * Phase 7B.2 — the one authoritative, versioned realtime event envelope
 * (phase7b2.txt §5), shared by the event bus, the WebSocket server, and (via
 * generated types) the frontend. The job record and REST API remain the
 * source of truth — this is a delivery mechanism, not a second copy of job
 * state; see websocketServer.ts's reconnect-and-reconcile note.
 */

import { randomUUID } from "node:crypto";
import { z } from "../contracts/zodOpenApi";

export const RealtimeEventType = {
  CONNECTION_READY: "connection.ready",
  SCAN_ACCEPTED: "scan.accepted",
  SCAN_STARTED: "scan.started",
  SCAN_COMPLETED: "scan.completed",
  SCAN_FAILED: "scan.failed",
  TOKEN_REPORT_UPDATED: "token.report.updated",
} as const;

export type RealtimeEventType = (typeof RealtimeEventType)[keyof typeof RealtimeEventType];

const RealtimeEventTypeSchema = z.enum([
  RealtimeEventType.CONNECTION_READY,
  RealtimeEventType.SCAN_ACCEPTED,
  RealtimeEventType.SCAN_STARTED,
  RealtimeEventType.SCAN_COMPLETED,
  RealtimeEventType.SCAN_FAILED,
  RealtimeEventType.TOKEN_REPORT_UPDATED,
]);

export const RealtimeEventEnvelopeSchema = z
  .object({
    version: z.literal("1"),
    eventId: z.string().uuid(),
    type: RealtimeEventTypeSchema,
    occurredAt: z.string(),
    data: z.record(z.string(), z.unknown()),
  })
  .openapi("RealtimeEvent");

export type RealtimeEventEnvelope = z.infer<typeof RealtimeEventEnvelopeSchema>;

/** Builds a well-formed envelope — the only place `version`/`eventId`/`occurredAt` are set, so every emitted event is shaped identically. */
export function createRealtimeEvent(type: RealtimeEventType, data: Record<string, unknown>): RealtimeEventEnvelope {
  return {
    version: "1",
    eventId: randomUUID(),
    type,
    occurredAt: new Date().toISOString(),
    data,
  };
}
