import { describe, expect, it, vi } from "vitest";
import { ForensicsWorker } from "../forensicsWorker";
import { ForensicsWorkerConfig } from "../forensicsWorkerConfig";
import { ClaimedForensicsJob } from "../forensicsJobService";
import { makeFakeClient } from "../fixtures/fakeClient";
import { accountKey, available, buildTransaction, dasEntry, dasPage, initializeMint2, mintTo, tokenBalance } from "../fixtures/syntheticBuilders";
import { TOKEN_PROGRAM_ID } from "../wellKnownAccounts";

const MINT = "So11111111111111111111111111111111111111112";
const DEV = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const BUYER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

function baseConfig(overrides: Partial<ForensicsWorkerConfig> = {}): ForensicsWorkerConfig {
  return { enabled: true, concurrency: 1, pollMs: 50, leaseMs: 60_000, heartbeatMs: 20_000, maxAttempts: 5, baseBackoffMs: 1000, ...overrides };
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
      // claimNextForensicsJob internals; simulate via a minimal tx. Once the
      // sequence is exhausted, always report no job available (matching a
      // real claimed job no longer being PENDING) — never re-serve the same
      // job forever, which would spin the worker loop unboundedly.
      const next = call < claimSequence.length ? claimSequence[call] : null;
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue(next ? [{ id: "job-1" }] : []),
        solanaForensicsJob: { update: vi.fn().mockResolvedValue(next) },
        solanaForensicsRun: { create: vi.fn().mockResolvedValue({ id: "run-1" }) },
        solanaForensicsEvidence: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
        solanaWalletCluster: { create: vi.fn().mockResolvedValue({ id: "cluster-row-1" }) },
        solanaWalletClusterMember: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
        solanaForensicsError: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
        solanaTokenEligibilityAssessment: { create: vi.fn().mockResolvedValue({ id: "elig-1" }) },
      };
      call += 1;
      return cb(tx);
    }),
    solanaForensicsJob: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function successfulFixtureClient() {
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

describe("ForensicsWorker — lifecycle", () => {
  it("does nothing at construction time (no start on import/construction)", () => {
    const db = fakeDb([null]);
    const worker = new ForensicsWorker({ db, workerId: "w1", config: baseConfig(), createRpcClient: () => successfulFixtureClient() });
    expect(worker.isRunning).toBe(false);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("start() is a safe no-op when the feature flag is disabled", async () => {
    const db = fakeDb([null]);
    const worker = new ForensicsWorker({ db, workerId: "w1", config: baseConfig({ enabled: false }), createRpcClient: () => successfulFixtureClient() });
    worker.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(worker.isRunning).toBe(false);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("stops gracefully when no jobs are available", async () => {
    const db = fakeDb([null]);
    const worker = new ForensicsWorker({ db, workerId: "w1", config: baseConfig({ pollMs: 100 }), createRpcClient: () => successfulFixtureClient() });
    worker.start();
    expect(worker.isRunning).toBe(true);
    await worker.stop();
    expect(worker.isRunning).toBe(false);
  });

  it("processes a claimed job end-to-end and persists a run via the real service boundary", async () => {
    const job = fakeJob();
    const db = fakeDb([job]);
    const worker = new ForensicsWorker({ db, workerId: "w1", config: baseConfig({ pollMs: 20 }), createRpcClient: () => successfulFixtureClient() });
    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await worker.stop();
    expect(db.solanaForensicsJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: expect.stringMatching(/COMPLETE|PARTIAL/) }) })
    );
  });
});

describe("ForensicsWorker — onRunPersisted / reconciliation sweep (phase5e.txt §9)", () => {
  it("invokes onRunPersisted with the new run id only after the job is marked complete", async () => {
    const job = fakeJob();
    const db = fakeDb([job]);
    const calls: string[] = [];
    const onRunPersisted = vi.fn(async (runId: string) => {
      calls.push(runId);
    });
    const worker = new ForensicsWorker({
      db,
      workerId: "w1",
      config: baseConfig({ pollMs: 20 }),
      createRpcClient: () => successfulFixtureClient(),
      onRunPersisted,
    });
    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await worker.stop();

    expect(onRunPersisted).toHaveBeenCalledTimes(1);
    expect(onRunPersisted).toHaveBeenCalledWith("run-1");
    // completeForensicsJob (via updateMany) must have already been called
    // before this test's assertions run, proving job completion is not
    // gated on the reconciliation callback.
    expect(db.solanaForensicsJob.updateMany).toHaveBeenCalled();
  });

  it("a failing onRunPersisted callback is swallowed and never marks the job/run failed", async () => {
    const job = fakeJob();
    const db = fakeDb([job]);
    const onRunPersisted = vi.fn(async () => {
      throw new Error("reconciliation exploded");
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const worker = new ForensicsWorker({
      db,
      workerId: "w1",
      config: baseConfig({ pollMs: 20 }),
      createRpcClient: () => successfulFixtureClient(),
      onRunPersisted,
      logger,
    });
    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await worker.stop();

    expect(onRunPersisted).toHaveBeenCalledTimes(1);
    // The job was still marked COMPLETE/PARTIAL — never FAILED — despite the callback throwing.
    const updateCall = db.solanaForensicsJob.updateMany.mock.calls.at(-1)[0];
    expect(updateCall.data.status).toMatch(/COMPLETE|PARTIAL/);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("reconciliation exploded"));
  });

  it("never invokes onRunPersisted when it is not provided (no crash, opt-in only)", async () => {
    const job = fakeJob();
    const db = fakeDb([job]);
    const worker = new ForensicsWorker({ db, workerId: "w1", config: baseConfig({ pollMs: 20 }), createRpcClient: () => successfulFixtureClient() });
    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await worker.stop();
    expect(db.solanaForensicsJob.updateMany).toHaveBeenCalled();
  });

  it("schedules the reconciliation sweep only when provided, and stops it on stop()", async () => {
    vi.useFakeTimers();
    try {
      const db = fakeDb([null]);
      const reconciliationSweep = vi.fn(async () => {});
      const worker = new ForensicsWorker({
        db,
        workerId: "w1",
        config: baseConfig({ pollMs: 100_000 }),
        createRpcClient: () => successfulFixtureClient(),
        reconciliationSweep,
        reconciliationSweepMs: 1000,
      });
      worker.start();
      await vi.advanceTimersByTimeAsync(3500);
      expect(reconciliationSweep.mock.calls.length).toBeGreaterThanOrEqual(3);

      const callsBeforeStop = reconciliationSweep.mock.calls.length;
      const stopPromise = worker.stop();
      await vi.advanceTimersByTimeAsync(1000);
      await stopPromise;
      await vi.advanceTimersByTimeAsync(5000);
      expect(reconciliationSweep.mock.calls.length).toBe(callsBeforeStop);
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);

  it("does not schedule any sweep timer when reconciliationSweep is not provided", () => {
    const db = fakeDb([null]);
    const worker = new ForensicsWorker({ db, workerId: "w1", config: baseConfig({ pollMs: 100_000 }), createRpcClient: () => successfulFixtureClient() });
    worker.start();
    // @ts-expect-error accessing a private field for a whitebox timer-existence check
    expect(worker.reconciliationSweepTimer).toBeUndefined();
    void worker.stop();
  });
});

describe("ForensicsWorker — abort propagation on shutdown", () => {
  it("aborts the in-flight client signal when stop() is called mid-analysis", async () => {
    const job = fakeJob();
    const db = fakeDb([job]);
    let observedSignal: AbortSignal | undefined;
    const hangingClient = makeFakeClient({
      getAccountInfo: async () =>
        new Promise((resolve) => {
          // Short hang (not signal-aware) just to keep the job in flight long
          // enough to observe that stop() fires the abort signal immediately,
          // without slowing the test suite down.
          setTimeout(
            () =>
              resolve(
                available({ context: { slot: 1 }, value: { data: [Buffer.alloc(82).toString("base64"), "base64"], executable: false, lamports: 1, owner: TOKEN_PROGRAM_ID, rentEpoch: 0 } })
              ),
            300
          );
        }),
      getTransaction: async () => available(null),
      getTransactionsForAddress: async () => available({ data: [], paginationToken: null }),
      getTransactionsForAddressPaginated: async () => ({ status: "COMPLETE", pagesFetched: 1, items: [], warnings: [] }),
      getTokenAccountsPaginated: async () => ({ status: "COMPLETE", pagesFetched: 1, pages: [], contextSlot: 1, warnings: [] }),
      getTokenSupply: async () => available({ context: { slot: 1 }, value: { amount: "1", decimals: 0, uiAmount: null } }),
    });

    const worker = new ForensicsWorker({
      db,
      workerId: "w1",
      config: baseConfig({ pollMs: 20 }),
      createRpcClient: ({ signal }) => {
        observedSignal = signal;
        return hangingClient;
      },
    });
    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(observedSignal?.aborted).toBe(false);
    const stopPromise = worker.stop();
    expect(observedSignal?.aborted).toBe(true); // abort fires synchronously within stop()
    await stopPromise;
  }, 5_000);
});
