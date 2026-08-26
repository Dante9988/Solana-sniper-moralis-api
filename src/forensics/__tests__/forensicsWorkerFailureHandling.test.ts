import { describe, expect, it, vi } from "vitest";

// Force the persistence step to throw in a controlled way, so we can test
// the worker's retry/permanent/backoff logic without needing a real
// persistence failure mode.
vi.mock("../forensicsRunPersistence", () => ({
  persistForensicsRun: vi.fn(),
}));

import { ForensicsWorker } from "../forensicsWorker";
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
  return { enabled: true, concurrency: 1, pollMs: 30, leaseMs: 60_000, heartbeatMs: 40, maxAttempts: 5, baseBackoffMs: 1000, ...overrides };
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

function fakeDb(job: ClaimedForensicsJob | null) {
  let served = false;
  return {
    $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => {
      const next = served ? null : job;
      served = true;
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue(next ? [{ id: next.id }] : []),
        solanaForensicsJob: { update: vi.fn().mockResolvedValue(next) },
      };
      return cb(tx);
    }),
    solanaForensicsJob: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function fixtureClient(delayMs = 0) {
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
    getAccountInfo: async () => {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      const data: [string, string] = [mintBuffer.toString("base64"), "base64"];
      return available({ context: { slot: 200 }, value: { data, executable: false, lamports: 1, owner: TOKEN_PROGRAM_ID, rentEpoch: 0 } });
    },
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
  });
}

describe("ForensicsWorker — retryable vs permanent failure", () => {
  it("a generic thrown error with attempts remaining retries (status PENDING, bounded backoff)", async () => {
    vi.mocked(persistForensicsRun).mockRejectedValue(new Error("transient db hiccup"));
    const db = fakeDb(fakeJob({ attemptCount: 1, maxAttempts: 5 }));
    const worker = new ForensicsWorker({ db, workerId: "w1", config: baseConfig(), createRpcClient: () => fixtureClient() });
    worker.start();
    await new Promise((r) => setTimeout(r, 150));
    await worker.stop();

    const call = db.solanaForensicsJob.updateMany.mock.calls.find((c: unknown[]) => (c[0] as { data: { status?: string } }).data.status === "PENDING");
    expect(call).toBeTruthy();
    expect(call![0].data.lastErrorCode).toBe("WORKER_ERROR");
  });

  it("exhausting maxAttempts marks the job FAILED instead of retrying again", async () => {
    vi.mocked(persistForensicsRun).mockRejectedValue(new Error("still broken"));
    const db = fakeDb(fakeJob({ attemptCount: 5, maxAttempts: 5 }));
    const worker = new ForensicsWorker({ db, workerId: "w1", config: baseConfig(), createRpcClient: () => fixtureClient() });
    worker.start();
    await new Promise((r) => setTimeout(r, 150));
    await worker.stop();

    const call = db.solanaForensicsJob.updateMany.mock.calls.find((c: unknown[]) => (c[0] as { data: { status?: string } }).data.status === "FAILED");
    expect(call).toBeTruthy();
    expect(call![0].data.lastErrorCode).toBe("RETRIES_EXHAUSTED");
  });

  it("a ForensicsJobValidationError is always permanent (FAILED), regardless of remaining attempts", async () => {
    vi.mocked(persistForensicsRun).mockRejectedValue(new ForensicsJobValidationError("bad mint"));
    const db = fakeDb(fakeJob({ attemptCount: 1, maxAttempts: 5 }));
    const worker = new ForensicsWorker({ db, workerId: "w1", config: baseConfig(), createRpcClient: () => fixtureClient() });
    worker.start();
    await new Promise((r) => setTimeout(r, 150));
    await worker.stop();

    const call = db.solanaForensicsJob.updateMany.mock.calls.find((c: unknown[]) => (c[0] as { data: { status?: string } }).data.status === "FAILED");
    expect(call).toBeTruthy();
    expect(call![0].data.lastErrorCode).toBe("VALIDATION_ERROR");
  });

  it("retry backoff grows with attempt number", async () => {
    vi.mocked(persistForensicsRun).mockRejectedValue(new Error("fail"));

    const dbLowAttempt = fakeDb(fakeJob({ attemptCount: 1, maxAttempts: 5 }));
    const workerLow = new ForensicsWorker({ db: dbLowAttempt, workerId: "w1", config: baseConfig(), createRpcClient: () => fixtureClient() });
    workerLow.start();
    await new Promise((r) => setTimeout(r, 150));
    await workerLow.stop();

    const dbHighAttempt = fakeDb(fakeJob({ attemptCount: 4, maxAttempts: 5 }));
    const workerHigh = new ForensicsWorker({ db: dbHighAttempt, workerId: "w1", config: baseConfig(), createRpcClient: () => fixtureClient() });
    workerHigh.start();
    await new Promise((r) => setTimeout(r, 150));
    await workerHigh.stop();

    const lowCall = dbLowAttempt.solanaForensicsJob.updateMany.mock.calls.find((c: unknown[]) => (c[0] as { data: { status?: string } }).data.status === "PENDING");
    const highCall = dbHighAttempt.solanaForensicsJob.updateMany.mock.calls.find((c: unknown[]) => (c[0] as { data: { status?: string } }).data.status === "PENDING");
    const lowDelay = (lowCall![0].data.availableAt as Date).getTime() - Date.now();
    const highDelay = (highCall![0].data.availableAt as Date).getTime() - Date.now();
    expect(highDelay).toBeGreaterThan(lowDelay);
  });
});

describe("ForensicsWorker — heartbeat", () => {
  it("extends the lease periodically while a job is still in flight", async () => {
    vi.mocked(persistForensicsRun).mockResolvedValue({ runId: "run-1" });
    const db = fakeDb(fakeJob());
    const worker = new ForensicsWorker({ db, workerId: "w1", config: baseConfig({ heartbeatMs: 30 }), createRpcClient: () => fixtureClient(200) });
    worker.start();
    await new Promise((r) => setTimeout(r, 150));
    await worker.stop();

    const heartbeatCalls = db.solanaForensicsJob.updateMany.mock.calls.filter(
      (c: unknown[]) => (c[0] as { data: Record<string, unknown> }).data.leaseExpiresAt !== undefined && (c[0] as { data: Record<string, unknown> }).data.status === undefined
    );
    expect(heartbeatCalls.length).toBeGreaterThan(0);
  });
});
