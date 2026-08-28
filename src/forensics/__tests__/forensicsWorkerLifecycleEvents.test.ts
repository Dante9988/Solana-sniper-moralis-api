import { describe, expect, it, vi } from "vitest";

// Force the persistence step's outcome directly (success / permanent
// failure / retryable failure) so each scenario is deterministic — same
// technique as forensicsWorkerFailureHandling.test.ts.
vi.mock("../forensicsRunPersistence", () => ({
  persistForensicsRun: vi.fn(),
}));

import { ForensicsWorker, JobLifecycleEvent } from "../forensicsWorker";
import { persistForensicsRun } from "../forensicsRunPersistence";
import { ForensicsJobValidationError, ClaimedForensicsJob } from "../forensicsJobService";
import { ForensicsWorkerConfig } from "../forensicsWorkerConfig";
import { makeFakeClient } from "../fixtures/fakeClient";
import { accountKey, available, buildTransaction, dasEntry, dasPage, initializeMint2, mintTo, tokenBalance } from "../fixtures/syntheticBuilders";
import { TOKEN_PROGRAM_ID } from "../wellKnownAccounts";

const MINT = "So11111111111111111111111111111111111111112";
const DEV = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const BUYER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

function baseConfig(overrides: Partial<ForensicsWorkerConfig> = {}): ForensicsWorkerConfig {
  return { enabled: true, concurrency: 1, pollMs: 20, leaseMs: 60_000, heartbeatMs: 40, maxAttempts: 5, baseBackoffMs: 1000, ...overrides };
}

function fakeJob(overrides: Partial<ClaimedForensicsJob> = {}): ClaimedForensicsJob {
  return {
    id: "job-1",
    jobKey: "key-1",
    assetId: "asset-1",
    mint: MINT,
    eventId: null,
    discoverySignature: "sig1",
    discoverySource: "PUMPFUN",
    analysisLevel: "FAST",
    policyVersion: "v1",
    attemptCount: 1,
    maxAttempts: 5,
    ...overrides,
  };
}

function fakeDb(claimSequence: (ClaimedForensicsJob | null)[]) {
  let call = 0;
  return {
    $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => {
      const next = call < claimSequence.length ? claimSequence[call] : null;
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue(next ? [{ id: "job-1" }] : []),
        solanaForensicsJob: { update: vi.fn().mockResolvedValue(next) },
      };
      call += 1;
      return cb(tx);
    }),
    solanaForensicsJob: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function fixtureClient() {
  const tx = buildTransaction({
    signature: "sig1",
    slot: 100,
    accountKeys: [accountKey(DEV, { signer: true }), accountKey(BUYER, { signer: true })],
    instructions: [initializeMint2(MINT, DEV), mintTo(MINT, "mintDest", "1000")],
    preBalances: [1_000_000, 500_000],
    postBalances: [999_000, 400_000],
    postTokenBalances: [tokenBalance(1, MINT, BUYER, "100")],
  });
  const mintBuffer = Buffer.alloc(82);
  return makeFakeClient({
    getTransaction: async () => available(tx),
    getTransactionsForAddress: async () => available({ data: [], paginationToken: null }),
    getTransactionsForAddressPaginated: async () => ({ status: "COMPLETE", pagesFetched: 1, items: [], warnings: [] }),
    getTokenAccountsPaginated: async () => ({
      status: "COMPLETE",
      pagesFetched: 1,
      pages: [dasPage([dasEntry("acct1", MINT, BUYER, "100")])],
      contextSlot: 200,
      warnings: [],
    }),
    getTokenSupply: async () => available({ context: { slot: 200 }, value: { amount: "1000", decimals: 6, uiAmount: null } }, { contextSlot: 200 }),
    getAccountInfo: async () => {
      const data: [string, string] = [mintBuffer.toString("base64"), "base64"];
      return available({ context: { slot: 200 }, value: { data, executable: false, lamports: 1, owner: TOKEN_PROGRAM_ID, rentEpoch: 0 } });
    },
  });
}

describe("ForensicsWorker onJobLifecycleEvent (phase7b2.txt §6)", () => {
  it("fires 'started' right after a job is claimed, then 'completed' with the run's status, after persistence has actually succeeded", async () => {
    vi.mocked(persistForensicsRun).mockResolvedValue({ runId: "run-1" });
    const job = fakeJob();
    const db = fakeDb([job]);
    const events: JobLifecycleEvent[] = [];
    const worker = new ForensicsWorker({
      db,
      workerId: "w1",
      config: baseConfig(),
      createRpcClient: () => fixtureClient(),
      onJobLifecycleEvent: async (event) => {
        events.push(event);
      },
    });

    worker.start();
    await vi.waitFor(() => expect(events.some((e) => e.type === "completed")).toBe(true), { timeout: 2000 });
    await worker.stop();

    expect(events[0]).toMatchObject({ type: "started", job: { id: "job-1", jobKey: "key-1" } });
    const completed = events.find((e) => e.type === "completed");
    expect(completed).toMatchObject({ type: "completed", job: { id: "job-1" }, status: expect.stringMatching(/COMPLETE|PARTIAL/) });
  });

  it("fires 'failed' on a permanent (validation) failure — never a silent success", async () => {
    vi.mocked(persistForensicsRun).mockRejectedValue(new ForensicsJobValidationError("bad input"));
    const job = fakeJob();
    const db = fakeDb([job]);
    const events: JobLifecycleEvent[] = [];
    const worker = new ForensicsWorker({
      db,
      workerId: "w1",
      config: baseConfig(),
      createRpcClient: () => fixtureClient(),
      onJobLifecycleEvent: async (event) => {
        events.push(event);
      },
    });

    worker.start();
    await vi.waitFor(() => expect(events.some((e) => e.type === "failed")).toBe(true), { timeout: 2000 });
    await worker.stop();

    const failed = events.find((e) => e.type === "failed");
    expect(failed).toMatchObject({ type: "failed", job: { id: "job-1" }, reason: expect.stringContaining("bad input") });
  });

  it("does NOT fire 'failed' on a retryable failure that still has attempts remaining — only a genuinely terminal outcome is 'failed'", async () => {
    vi.mocked(persistForensicsRun).mockRejectedValue(new Error("transient RPC error"));
    const job = fakeJob({ attemptCount: 1, maxAttempts: 5 }); // well under the retry ceiling
    const db = fakeDb([job]);
    const events: JobLifecycleEvent[] = [];
    const worker = new ForensicsWorker({
      db,
      workerId: "w1",
      config: baseConfig(),
      createRpcClient: () => fixtureClient(),
      onJobLifecycleEvent: async (event) => {
        events.push(event);
      },
    });

    worker.start();
    await vi.waitFor(() => expect(events.some((e) => e.type === "started")).toBe(true), { timeout: 2000 });
    await new Promise((r) => setTimeout(r, 150)); // give the (mocked) retry path time to run if it were going to fire an event
    await worker.stop();

    expect(events.some((e) => e.type === "failed")).toBe(false);
  });

  it("a lifecycle-event callback that throws never crashes the worker or blocks job processing", async () => {
    vi.mocked(persistForensicsRun).mockResolvedValue({ runId: "run-1" });
    const job = fakeJob();
    const db = fakeDb([job]);
    const worker = new ForensicsWorker({
      db,
      workerId: "w1",
      config: baseConfig(),
      createRpcClient: () => fixtureClient(),
      onJobLifecycleEvent: async () => {
        throw new Error("event bus is down");
      },
    });

    worker.start();
    await vi.waitFor(() => expect(db.solanaForensicsJob.updateMany).toHaveBeenCalled(), { timeout: 2000 });
    await worker.stop();
    // No assertion beyond "this didn't throw/hang" — the point is the worker
    // keeps running and completes the job despite the callback failing.
  });
});
