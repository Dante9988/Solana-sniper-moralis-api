import { describe, expect, it, vi } from "vitest";
import { InMemoryEventBus, RedisEventBus } from "../realtime/eventBus";
import { createRealtimeEvent } from "../realtime/eventEnvelope";

describe("InMemoryEventBus", () => {
  it("delivers a published event to a subscriber on the same channel", async () => {
    const bus = new InMemoryEventBus();
    const received: unknown[] = [];
    await bus.subscribe("job:abc", (event) => received.push(event));

    const event = createRealtimeEvent("scan.started", { jobKey: "abc", mint: "MintX" });
    await bus.publish("job:abc", event);

    expect(received).toEqual([event]);
  });

  it("never delivers to a different channel", async () => {
    const bus = new InMemoryEventBus();
    const received: unknown[] = [];
    await bus.subscribe("job:abc", (event) => received.push(event));

    await bus.publish("job:other", createRealtimeEvent("scan.started", { jobKey: "other", mint: "MintY" }));
    expect(received).toHaveLength(0);
  });

  it("delivers to multiple subscribers on the same channel", async () => {
    const bus = new InMemoryEventBus();
    const a: unknown[] = [];
    const b: unknown[] = [];
    await bus.subscribe("job:abc", (e) => a.push(e));
    await bus.subscribe("job:abc", (e) => b.push(e));

    const event = createRealtimeEvent("scan.completed", { jobKey: "abc", mint: "MintX", status: "COMPLETE" });
    await bus.publish("job:abc", event);

    expect(a).toEqual([event]);
    expect(b).toEqual([event]);
  });

  it("unsubscribe stops further delivery to that handler only", async () => {
    const bus = new InMemoryEventBus();
    const received: unknown[] = [];
    const unsubscribe = await bus.subscribe("job:abc", (e) => received.push(e));

    await unsubscribe();
    await bus.publish("job:abc", createRealtimeEvent("scan.started", { jobKey: "abc", mint: "MintX" }));
    expect(received).toHaveLength(0);
  });

  it("publishing to a channel with no subscribers is a safe no-op", async () => {
    const bus = new InMemoryEventBus();
    await expect(bus.publish("job:nobody-listening", createRealtimeEvent("scan.started", { jobKey: "x", mint: "y" }))).resolves.toBeUndefined();
  });
});

describe("RedisEventBus (mocked ioredis client — never a live Redis connection, phase7b2.txt §11)", () => {
  function fakePublisherAndSubscriber() {
    const listeners: Record<string, ((channel: string, message: string) => void)[]> = {};
    const subscriber = {
      on: vi.fn((event: string, handler: (channel: string, message: string) => void) => {
        listeners[event] = listeners[event] ?? [];
        listeners[event].push(handler);
      }),
      subscribe: vi.fn(async () => undefined),
      unsubscribe: vi.fn(async () => undefined),
      quit: vi.fn(async () => undefined),
      // Test helper: simulate Redis delivering a published message to this subscriber.
      __emitMessage(channel: string, raw: string) {
        for (const handler of listeners["message"] ?? []) handler(channel, raw);
      },
    };
    const publisher = {
      publish: vi.fn(async (channel: string, raw: string) => {
        subscriber.__emitMessage(channel, raw); // simulate Redis routing pub -> sub in-process
        return 1;
      }),
      quit: vi.fn(async () => undefined),
    };
    return { publisher, subscriber };
  }

  it("subscribes to the Redis channel on first subscriber and publishes JSON-serialized events through it", async () => {
    const { publisher, subscriber } = fakePublisherAndSubscriber();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bus = new RedisEventBus(publisher as any, subscriber as any);
    const received: unknown[] = [];
    await bus.subscribe("job:abc", (e) => received.push(e));
    expect(subscriber.subscribe).toHaveBeenCalledWith("job:abc");

    const event = createRealtimeEvent("scan.completed", { jobKey: "abc", mint: "MintX", status: "COMPLETE" });
    await bus.publish("job:abc", event);

    expect(publisher.publish).toHaveBeenCalledWith("job:abc", JSON.stringify(event));
    expect(received).toEqual([event]);
  });

  it("drops a malformed payload instead of crashing the process", async () => {
    const { publisher, subscriber } = fakePublisherAndSubscriber();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bus = new RedisEventBus(publisher as any, subscriber as any);
    const received: unknown[] = [];
    await bus.subscribe("job:abc", (e) => received.push(e));

    subscriber.__emitMessage("job:abc", "{not valid json");
    expect(received).toHaveLength(0);
  });

  it("unsubscribing the last handler on a channel calls Redis UNSUBSCRIBE", async () => {
    const { publisher, subscriber } = fakePublisherAndSubscriber();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bus = new RedisEventBus(publisher as any, subscriber as any);
    const unsubscribe = await bus.subscribe("job:abc", () => undefined);
    await unsubscribe();
    expect(subscriber.unsubscribe).toHaveBeenCalledWith("job:abc");
  });

  it("close() quits both the publisher and subscriber connections", async () => {
    const { publisher, subscriber } = fakePublisherAndSubscriber();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bus = new RedisEventBus(publisher as any, subscriber as any);
    await bus.close();
    expect(publisher.quit).toHaveBeenCalled();
    expect(subscriber.quit).toHaveBeenCalled();
  });
});
