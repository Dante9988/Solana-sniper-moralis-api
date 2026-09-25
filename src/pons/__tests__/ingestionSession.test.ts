import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_INGESTION_MODE,
  IngestionModeError,
  checkpointSourceFor,
  describeSession,
  loadIngestionMode,
  openSession,
  resolveSession,
  sessionStartHeight,
  type IngestionSessionRecord,
} from "../ingestionSession";
import { CheckpointStore } from "../checkpointStore";

/**
 * Phase 7D.5 — local development observes from the current chain head instead of replaying
 * a historical backlog. The properties that must hold:
 *
 *  - `resume` stays the default, so hosted environments are untouched by this phase.
 *  - a session never reads or writes the durable `robinhood:*` checkpoints.
 *  - the boundary is shared: a worker restart rejoins, it does not cut a new one.
 */

const SESSION: IngestionSessionRecord = {
  id: "11111111-2222-3333-4444-555555555555",
  chain: "robinhood",
  mode: "live-head",
  startBlock: 67_000_000n,
  startHash: "0xabc",
  startTimestamp: new Date("2026-09-20T00:00:00Z"),
  createdAt: new Date("2026-09-20T00:00:01Z"),
};

describe("ingestion mode", () => {
  it("defaults to resume, so an unset environment keeps durable checkpoints", () => {
    expect(DEFAULT_INGESTION_MODE).toBe("resume");
    expect(loadIngestionMode({})).toBe("resume");
    expect(loadIngestionMode({ PONS_INGESTION_MODE: "" })).toBe("resume");
  });

  it.each(["live-head", "LIVE-HEAD", "live_head", "livehead", " live-head "])("accepts %s", (v) => {
    expect(loadIngestionMode({ PONS_INGESTION_MODE: v })).toBe("live-head");
  });

  it("refuses an unrecognised mode rather than guessing", () => {
    expect(() => loadIngestionMode({ PONS_INGESTION_MODE: "head" })).toThrow(IngestionModeError);
  });
});

describe("session boundary", () => {
  it("starts at the block AFTER the boundary, so the boundary block is never double-counted", () => {
    expect(sessionStartHeight(SESSION)).toBe(67_000_001n);
  });

  it("namespaces checkpoints in live-head and leaves them alone in resume", () => {
    expect(checkpointSourceFor("robinhood:pons_v2:discovery", null)).toBe("robinhood:pons_v2:discovery");
    expect(checkpointSourceFor("robinhood:pons_v2:discovery", SESSION)).toBe(
      `session:${SESSION.id}:robinhood:pons_v2:discovery`
    );
  });

  it("describes itself with the boundary an operator needs", () => {
    expect(describeSession("resume", null)).toMatch(/durable checkpoints/);
    const d = describeSession("live-head", SESSION);
    expect(d).toContain(SESSION.id);
    expect(d).toContain("67000000");
  });
});

describe("CheckpointStore namespacing", () => {
  function fakeDb() {
    const rows = new Map<string, { source: string; lastHeight: bigint; lastHash: string }>();
    return {
      rows,
      chainIngestionCheckpoint: {
        findUnique: vi.fn(async ({ where }: { where: { source: string } }) => rows.get(where.source) ?? null),
        upsert: vi.fn(async ({ where, create }: { where: { source: string }; create: never }) => {
          rows.set(where.source, create as never);
        }),
        update: vi.fn(async () => undefined),
      },
    };
  }

  it("writes the session row and leaves the durable row untouched", async () => {
    const db = fakeDb();
    // A durable checkpoint from an earlier, non-session run.
    db.rows.set("robinhood:pons_v2:discovery", { source: "robinhood:pons_v2:discovery", lastHeight: 12n, lastHash: "0xold" });

    const scoped = new CheckpointStore(db as never, `session:${SESSION.id}:`);
    await scoped.set("robinhood:pons_v2:discovery", { lastHeight: 67_000_050n, lastHash: "0xnew" });

    expect(db.rows.get("robinhood:pons_v2:discovery")!.lastHeight).toBe(12n);
    const scopedRow = db.rows.get(`session:${SESSION.id}:robinhood:pons_v2:discovery`);
    expect(scopedRow, "the session write must land on its own row").toBeDefined();
    expect(scopedRow!.lastHeight).toBe(67_000_050n);
    // The stored `source` column must be the namespaced key, or the row is unreadable.
    expect(scopedRow!.source).toBe(`session:${SESSION.id}:robinhood:pons_v2:discovery`);
  });

  it("does not see an old durable checkpoint, so a session never resumes history", async () => {
    const db = fakeDb();
    db.rows.set("robinhood:pons_v2:discovery", { source: "robinhood:pons_v2:discovery", lastHeight: 12n, lastHash: "0xold" });

    const scoped = new CheckpointStore(db as never, `session:${SESSION.id}:`);
    expect(await scoped.get("robinhood:pons_v2:discovery")).toBeNull();

    // resume mode, same database, still sees it.
    expect(await new CheckpointStore(db as never).get("robinhood:pons_v2:discovery")).toMatchObject({ lastHeight: 12n });
  });
});

describe("resolveSession", () => {
  const reader = {
    getBlockNumber: vi.fn(async () => ({ status: "AVAILABLE", data: 67_500_000n })),
    getBlockRef: vi.fn(async () => ({ status: "AVAILABLE", data: { hash: "0xhead", timestamp: 1789900000n } })),
  };

  function db(active: IngestionSessionRecord | null) {
    return {
      ingestionSession: {
        findFirst: vi.fn(async () => active),
        updateMany: vi.fn(async () => ({ count: 0 })),
        create: vi.fn(async ({ data }: { data: never }) => ({ id: "new-session", createdAt: new Date(), ...(data as object) })),
      },
    };
  }

  it("creates no session in resume mode", async () => {
    const d = db(null);
    expect(await resolveSession(d as never, reader as never, "robinhood", "resume")).toBeNull();
    expect(d.ingestionSession.create).not.toHaveBeenCalled();
  });

  it("rejoins the active session — a worker restart must not cut a new boundary", async () => {
    const d = db(SESSION);
    const got = await resolveSession(d as never, reader as never, "robinhood", "live-head");
    expect(got!.id).toBe(SESSION.id);
    expect(d.ingestionSession.create, "restarting a worker must never open a session").not.toHaveBeenCalled();
  });

  it("opens one when none is active, so a bare worker run still works", async () => {
    const d = db(null);
    const got = await resolveSession(d as never, reader as never, "robinhood", "live-head");
    expect(d.ingestionSession.create).toHaveBeenCalledTimes(1);
    expect(got!.startBlock).toBe(67_500_000n);
  });

  it("records the chain's own timestamp for the boundary block, not wall clock", async () => {
    const d = db(null);
    await openSession(d as never, reader as never, "robinhood");
    const data = d.ingestionSession.create.mock.calls[0][0].data as { startTimestamp: Date; startHash: string };
    expect(data.startTimestamp.getTime()).toBe(1789900000 * 1000);
    expect(data.startHash).toBe("0xhead");
  });

  it("ends the previous session before creating one, so two are never active", async () => {
    const d = db(null);
    await openSession(d as never, reader as never, "robinhood");
    const endOrder = d.ingestionSession.updateMany.mock.invocationCallOrder[0];
    const createOrder = d.ingestionSession.create.mock.invocationCallOrder[0];
    expect(endOrder).toBeLessThan(createOrder);
  });
});

describe("health projection under live-head", () => {
  // Imported lazily so the module-level mode read happens after the env is set.
  async function health(env: Record<string, string>, rows: Record<string, unknown>, session: unknown) {
    const prev = process.env.PONS_INGESTION_MODE;
    Object.assign(process.env, env);
    try {
      const { computeIngestionHealth } = await import("../sourceHealth");
      const db = {
        ingestionSession: { findFirst: vi.fn(async () => session) },
        chainIngestionCheckpoint: { findUnique: vi.fn(async ({ where }: { where: { source: string } }) => rows[where.source] ?? null) },
      };
      return await computeIngestionHealth(db as never, { healthLaggingBlocks: 50, healthStaleMs: 120_000, healthErrorWindowMs: 60_000 });
    } finally {
      if (prev === undefined) delete process.env.PONS_INGESTION_MODE;
      else process.env.PONS_INGESTION_MODE = prev;
    }
  }

  const live = (height: bigint) => ({
    lastHeight: height,
    lastHash: "0xh",
    updatedAt: new Date(),
    lastObservedChainHeight: height + 2n,
    lastPollAt: new Date(),
    lastSuccessAt: new Date(),
    lastError: null,
    lastErrorAt: null,
    lastReorgAt: null,
    reorgUnresolvedAt: null,
    reorgUnresolvedReason: null,
  });

  it("reads session rows, not the abandoned durable ones", async () => {
    const prefix = `session:${SESSION.id}:`;
    const result = await health(
      { PONS_INGESTION_MODE: "live-head" },
      {
        // Durable row, 1.3M blocks behind — must be ignored.
        "robinhood:pons_v2:discovery": { ...live(1n), lastObservedChainHeight: 1_300_000n },
        [`${prefix}robinhood:pons_v2:discovery`]: live(67_000_000n),
        [`${prefix}robinhood:pons:discovery`]: live(67_000_000n),
      },
      SESSION
    );

    expect(result.status).toBe("LIVE");
    expect(result.session.id).toBe(SESSION.id);
    expect(result.session.startBlock).toBe("67000000");
  });

  it("does not let a stream that never started report the whole stack as down", async () => {
    const prefix = `session:${SESSION.id}:`;
    const result = await health(
      { PONS_INGESTION_MODE: "live-head" },
      // Only V2 discovery has run. The V1 trade listener legitimately idles when no
      // venue="pons" token exists; that used to make the endpoint say UNAVAILABLE.
      { [`${prefix}robinhood:pons_v2:discovery`]: live(67_000_000n) },
      SESSION
    );

    expect(result.status).toBe("LIVE");
    expect(result.streams.find((s) => s.source === "robinhood:pons:trades")!.lastHeight).toBeNull();
  });

  it("still reports UNAVAILABLE when nothing has run at all", async () => {
    const result = await health({ PONS_INGESTION_MODE: "live-head" }, {}, SESSION);
    expect(result.status).toBe("UNAVAILABLE");
  });

  it("reports mode=resume and no session id outside live-head", async () => {
    const result = await health({ PONS_INGESTION_MODE: "resume" }, { "robinhood:pons:discovery": live(5n) }, null);
    expect(result.session).toMatchObject({ mode: "resume", id: null, startBlock: null });
  });
});
