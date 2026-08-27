/**
 * Phase 5D — `npm run forensics:fixture` (phase5d.txt §14).
 *
 * Enqueues one sanitized synthetic token/mint job, processes it once through
 * the REAL worker/job-claim/persistence boundary (ForensicsWorker,
 * claimNextForensicsJob, persistForensicsRun — no bypass logic), using a
 * FAKE injected RPC client (this module's own synthetic fixtures). Makes
 * zero Helius, Solana, X, Anthropic, Discord, or trading calls. Running it
 * twice must be idempotent: the second run must not create a duplicate job,
 * a duplicate run, or duplicate eligibility for the same run.
 *
 * All addresses used here are deterministically derived program-derived
 * addresses — no signing key material of any kind, never real launched-token
 * data, never a "fake holding" — nothing here is persisted as a real
 * position, only as forensic evidence rows.
 */

import { PublicKey } from "@solana/web3.js";
import { MintLayout, MINT_SIZE } from "@solana/spl-token";
import { randomUUID } from "node:crypto";
import { prisma } from "../../services/prismaClient";
import { enqueueSolanaForensicsJob } from "../forensicsJobService";
import { ForensicsWorker } from "../forensicsWorker";
import { loadForensicsWorkerConfig } from "../forensicsWorkerConfig";
import { FORENSICS_POLICY_VERSION } from "../thresholds";
import { makeFakeClient } from "../fixtures/fakeClient";
import { accountKey, available, buildTransaction, dasEntry, dasPage, initializeMint2, mintTo, tokenBalance } from "../fixtures/syntheticBuilders";
import { TOKEN_PROGRAM_ID } from "../wellKnownAccounts";
import { ForensicsRpcClient } from "../solanaForensicsClient";

const FIXTURE_SEED = "phase5d-forensics-fixture-v1";
const [FIXTURE_MINT_PK] = PublicKey.findProgramAddressSync([Buffer.from(FIXTURE_SEED), Buffer.from("mint")], new PublicKey(TOKEN_PROGRAM_ID));
const [FIXTURE_DEV_PK] = PublicKey.findProgramAddressSync([Buffer.from(FIXTURE_SEED), Buffer.from("dev")], new PublicKey(TOKEN_PROGRAM_ID));
const [FIXTURE_BUYER_PK] = PublicKey.findProgramAddressSync([Buffer.from(FIXTURE_SEED), Buffer.from("buyer")], new PublicKey(TOKEN_PROGRAM_ID));

const FIXTURE_MINT = FIXTURE_MINT_PK.toBase58();
const FIXTURE_DEV = FIXTURE_DEV_PK.toBase58();
const FIXTURE_BUYER = FIXTURE_BUYER_PK.toBase58();
const FIXTURE_SIGNATURE = `fixture-sig-${FIXTURE_SEED}`;
const FIXTURE_SLOT = 123_456;

function encodeMintBuffer(): Buffer {
  const buf = Buffer.alloc(MINT_SIZE);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: new PublicKey("11111111111111111111111111111111"),
      supply: 1_000_000n,
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: new PublicKey("11111111111111111111111111111111"),
    },
    buf
  );
  return buf;
}

function buildFixtureClient(): ForensicsRpcClient {
  const launchTx = buildTransaction({
    signature: FIXTURE_SIGNATURE,
    slot: FIXTURE_SLOT,
    blockTime: 1_735_000_000,
    accountKeys: [accountKey(FIXTURE_DEV, { signer: true }), accountKey(FIXTURE_BUYER, { signer: true })],
    instructions: [initializeMint2(FIXTURE_MINT, FIXTURE_DEV), mintTo(FIXTURE_MINT, "fixtureMintDestination", "1000000")],
    preBalances: [10_000_000_000, 5_000_000_000],
    postBalances: [9_999_995_000, 4_990_000_000], // buyer's SOL decreased -> VERIFIED_BUY
    postTokenBalances: [tokenBalance(1, FIXTURE_MINT, FIXTURE_BUYER, "50000")], // 5% of supply
  });

  const mintBuffer = encodeMintBuffer();

  return makeFakeClient({
    getTransaction: async () => available(launchTx),
    getTransactionsForAddress: async () => available({ data: [], paginationToken: null }),
    getTransactionsForAddressPaginated: async () => ({ status: "COMPLETE", pagesFetched: 1, items: [], warnings: [] }),
    getTokenAccountsPaginated: async () => ({
      status: "COMPLETE",
      pagesFetched: 1,
      pages: [dasPage([dasEntry("fixtureTokenAccount1", FIXTURE_MINT, FIXTURE_BUYER, "50000")])],
      contextSlot: FIXTURE_SLOT + 10,
      warnings: [],
    }),
    getTokenSupply: async () =>
      available({ context: { slot: FIXTURE_SLOT + 10 }, value: { amount: "1000000", decimals: 6, uiAmount: null } }, { contextSlot: FIXTURE_SLOT + 10 }),
    getAccountInfo: async () => {
      const data: [string, string] = [mintBuffer.toString("base64"), "base64"];
      return available(
        { context: { slot: FIXTURE_SLOT + 10 }, value: { data, executable: false, lamports: 1, owner: TOKEN_PROGRAM_ID, rentEpoch: 0 } },
        { contextSlot: FIXTURE_SLOT + 10 }
      );
    },
  });
}

async function waitForJobSettlement(jobId: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await prisma.solanaForensicsJob.findUnique({ where: { id: jobId } });
    if (job && ["COMPLETE", "PARTIAL", "FAILED"].includes(job.status)) return job.status;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return "TIMED_OUT_WAITING";
}

async function main(): Promise<void> {
  const enqueueResult = await enqueueSolanaForensicsJob(prisma, {
    mint: FIXTURE_MINT,
    discoverySignature: FIXTURE_SIGNATURE,
    discoverySource: "PUMPFUN",
    analysisLevel: "FAST",
    policyVersion: FORENSICS_POLICY_VERSION,
  });

  const alreadySettled = !enqueueResult.created && enqueueResult.status !== "PENDING" && enqueueResult.status !== "RUNNING";

  if (!alreadySettled) {
    const client = buildFixtureClient();
    const baseConfig = loadForensicsWorkerConfig({ FORENSICS_WORKER_ENABLED: "true" });
    const worker = new ForensicsWorker({
      db: prisma,
      workerId: `fixture-${randomUUID()}`,
      config: { ...baseConfig, concurrency: 1, pollMs: 200 },
      createRpcClient: () => client,
    });
    worker.start();
    await waitForJobSettlement(enqueueResult.jobId, 10_000);
    await worker.stop();
  }

  const job = await prisma.solanaForensicsJob.findUnique({
    where: { id: enqueueResult.jobId },
    include: { runs: { orderBy: { createdAt: "desc" }, take: 1, include: { eligibility: true } } },
  });
  const latestRun = job?.runs[0];
  const runCount = await prisma.solanaForensicsRun.count({ where: { jobId: enqueueResult.jobId } });
  const eligibilityCount = latestRun ? await prisma.solanaTokenEligibilityAssessment.count({ where: { runId: latestRun.id } }) : 0;

  console.log("=== Phase 5D synthetic forensics fixture ===");
  console.log(`mint: ${job?.mint}`);
  console.log(`jobId: ${job?.id}`);
  console.log(`enqueue created a new job: ${enqueueResult.created}`);
  console.log(`job status: ${job?.status}`);
  console.log(`total runs for this job: ${runCount} (must stay 1 across repeated executions)`);
  console.log(`latest run status: ${latestRun?.runStatus ?? "none"}, coverage: ${latestRun?.coverageStatus ?? "none"}`);
  console.log(`eligibility rows for latest run: ${eligibilityCount} (must be exactly 1)`);
  console.log(`eligibility: ${latestRun?.eligibility?.eligibility ?? "none"} (${latestRun?.eligibility?.displaySeverity ?? "none"})`);
  console.log(`policyVersion: ${latestRun?.policyVersion ?? "none"}`);
  console.log(alreadySettled ? "idempotency check: job was already settled — no new work was performed." : "idempotency check: job processed this run.");

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[forensics:fixture] fatal error:", err instanceof Error ? err.message : String(err));
  await prisma.$disconnect();
  process.exitCode = 1;
});
