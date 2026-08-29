import { describe, expect, it } from "vitest";
import { createRealtimeEvent, RealtimeEventEnvelopeSchema } from "../realtime/eventEnvelope";

describe("realtime event envelope (phase7b2.txt §5)", () => {
  it("createRealtimeEvent produces a schema-valid envelope with version, eventId, type, occurredAt, and data", () => {
    const event = createRealtimeEvent("scan.completed", { jobKey: "k1", mint: "MintX", status: "COMPLETE" });
    const parsed = RealtimeEventEnvelopeSchema.safeParse(event);
    expect(parsed.success).toBe(true);
    expect(event.version).toBe("1");
    expect(event.type).toBe("scan.completed");
  });

  it("two calls produce different eventIds", () => {
    const a = createRealtimeEvent("scan.started", { jobKey: "k1", mint: "MintX" });
    const b = createRealtimeEvent("scan.started", { jobKey: "k1", mint: "MintX" });
    expect(a.eventId).not.toBe(b.eventId);
  });

  it("occurredAt is a valid ISO-8601 timestamp", () => {
    const event = createRealtimeEvent("connection.ready", { userId: "u1" });
    expect(() => new Date(event.occurredAt).toISOString()).not.toThrow();
    expect(new Date(event.occurredAt).toISOString()).toBe(event.occurredAt);
  });

  it("rejects an envelope with an unknown event type", () => {
    const invalid = { version: "1", eventId: "11111111-1111-4111-8111-111111111111", type: "scan.definitely-not-real", occurredAt: new Date().toISOString(), data: {} };
    expect(RealtimeEventEnvelopeSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects an envelope with the wrong version string", () => {
    const invalid = { version: "2", eventId: "11111111-1111-4111-8111-111111111111", type: "scan.started", occurredAt: new Date().toISOString(), data: {} };
    expect(RealtimeEventEnvelopeSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects an envelope with a non-UUID eventId", () => {
    const invalid = { version: "1", eventId: "not-a-uuid", type: "scan.started", occurredAt: new Date().toISOString(), data: {} };
    expect(RealtimeEventEnvelopeSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects an envelope missing data entirely", () => {
    const invalid = { version: "1", eventId: "11111111-1111-4111-8111-111111111111", type: "scan.started", occurredAt: new Date().toISOString() };
    expect(RealtimeEventEnvelopeSchema.safeParse(invalid).success).toBe(false);
  });

  it("accepts every documented initial event type", () => {
    for (const type of ["connection.ready", "scan.accepted", "scan.started", "scan.completed", "scan.failed", "token.report.updated"] as const) {
      const event = createRealtimeEvent(type, {});
      expect(RealtimeEventEnvelopeSchema.safeParse(event).success).toBe(true);
    }
  });
});
