/**
 * Phase 5E — `npm run forensics:integration-fixture` (phase5e.txt §13).
 *
 * Proves the FULL async lifecycle end to end against the REAL local
 * PostgreSQL, using only fake/mocked external calls:
 *
 *   synthetic TokenDiscoveryEvent
 *     -> (mocked metadata/market/safety/social/AI workers, REAL bundleSniperResearcher)
 *     -> preliminary TokenIntelligenceReport persists PARTIAL/PENDING
 *     -> real forensic job enqueue
 *     -> real standalone ForensicsWorker boundary (FAKE forensic RPC client)
 *     -> deterministic run + eligibility persist
 *     -> real reconciliation (worker's onRunPersisted hook, same wiring as
 *        forensics:worker's entrypoint)
 *     -> real intelligence-report update
 *     -> candidate gate reflects the persisted eligibility
 *
 * Zero calls to Helius, Solana RPC, X, Anthropic, Discord, or trading —
 * every worker other than bundleSniperResearcher is a static mock, and the
 * forensic RPC client is this module's own synthetic fixture data. Anthropic
 * re-synthesis is deliberately left disabled (FORENSICS_AI_RESYNTHESIS_ENABLED
 * is never set here — phase5e.txt §10 forbids enabling it during Phase 5E
 * verification).
 *
 * Every identifier (mint/dev/buyer/funder addresses, event id, launch
 * signature) is deterministically derived from a fixed per-case seed — no
 * `randomUUID` in any identity field — so running this script twice as two
 * separate process invocations is idempotent: the second run finds the
 * existing job/run already settled and performs no new enqueue, no new
 * worker analysis, and no duplicate report evidence.
 */

import { PublicKey } from "@solana/web3.js";
import { MintLayout, MINT_SIZE } from "@solana/spl-token";
import { prisma } from "../../services/prismaClient";
import { TokenIntelligenceOrchestrator } from "../../intelligence/orchestrator";
import { bundleSniperResearcher } from "../../intelligence/workers/bundleSniperResearcher";
import { TokenDiscoveryEvent } from "../../intelligence/types";
import { evaluateCandidateGate } from "../candidateGate";
import { reconcileForensicsRun } from "../../services/forensicsIntelligenceReconciliation";
import { ForensicsWorker } from "../forensicsWorker";
import { loadForensicsWorkerConfig } from "../forensicsWorkerConfig";
import { ForensicsRpcClient } from "../solanaForensicsClient";
import { makeFakeClient } from "../fixtures/fakeClient";
import {
  accountKey,
  available,
  buildTransaction,
  dasEntry,
  dasPage,
  initializeMint2,
  mintTo,
  systemTransfer,
  tokenBalance,
} from "../fixtures/syntheticBuilders";
import { TOKEN_PROGRAM_ID } from "../wellKnownAccounts";

// Local-only, this-process-only overrides — never written to .env, never
// touching X/Discord/trading flags, and deliberately never enabling AI
// re-synthesis (phase5e.txt §10, §13).
process.env.FORENSICS_ENQUEUE_ENABLED = "true";
process.env.FORENSICS_RECONCILIATION_ENABLED = "true";

interface CaseSpec {
  seed: string;
  label: string;
  totalMinted: string;
  bundleAAmount: string;
  bundleBAmount: string;
  otherBuyerAmount: string;
  expectedEligibility: "CAUTION" | "EXCLUDED";
  expectedDisplaySeverity: "WARNING" | "DANGEROUS_EXCLUDED";
  expectedGateMode: "HUMAN_REVIEW_ONLY" | "BLOCKED";
  expectedGateAllowed: boolean;
  expectedBundledPct: number;
}

const CASES: CaseSpec[] = [
  {
    seed: "phase5e-fixture-case-3999-v1",
    label: "39.99% bundled, complete evidence (not excluded)",
    totalMinted: "10000",
    bundleAAmount: "2000",
    bundleBAmount: "1999",
    otherBuyerAmount: "6001",
    expectedEligibility: "CAUTION",
    expectedDisplaySeverity: "WARNING",
    expectedGateMode: "HUMAN_REVIEW_ONLY",
    expectedGateAllowed: true,
    expectedBundledPct: 39.99,
  },
  {
    seed: "phase5e-fixture-case-4000-v1",
    label: "exactly 40.00% bundled (mandatory exclusion)",
    totalMinted: "1000",
    bundleAAmount: "250",
    bundleBAmount: "150",
    otherBuyerAmount: "600",
    expectedEligibility: "EXCLUDED",
    expectedDisplaySeverity: "DANGEROUS_EXCLUDED",
    expectedGateMode: "BLOCKED",
    expectedGateAllowed: false,
    expectedBundledPct: 40,
  },
];

interface CaseAddresses {
  mint: string;
  dev: string;
  bundleA: string;
  bundleB: string;
  otherBuyer: string;
  funder: string;
}

function deriveCaseAddresses(seed: string): CaseAddresses {
  const derive = (label: string) =>
    PublicKey.findProgramAddressSync([Buffer.from(seed), Buffer.from(label)], new PublicKey(TOKEN_PROGRAM_ID))[0].toBase58();
  return {
    mint: derive("mint"),
    dev: derive("dev"),
    bundleA: derive("bundleA"),
    bundleB: derive("bundleB"),
    otherBuyer: derive("otherBuyer"),
    funder: derive("funder"),
  };
}

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

function buildCaseClient(addrs: CaseAddresses, spec: CaseSpec, signature: string): ForensicsRpcClient {
  const launchTx = buildTransaction({
    signature,
    slot: 100,
    blockTime: 1_735_000_000,
    accountKeys: [
      accountKey(addrs.dev, { signer: true }),
      accountKey(addrs.bundleA, { signer: true }),
      accountKey(addrs.bundleB, { signer: true }),
      accountKey(addrs.otherBuyer, { signer: true }),
    ],
    instructions: [initializeMint2(addrs.mint, addrs.dev), mintTo(addrs.mint, "fixtureMintDestination", spec.totalMinted)],
    preBalances: [10_000_000_000, 5_000_000_000, 5_000_000_000, 5_000_000_000],
    postBalances: [9_999_995_000, 4_999_000_000, 4_999_000_000, 4_999_000_000],
    postTokenBalances: [
      tokenBalance(1, addrs.mint, addrs.bundleA, spec.bundleAAmount),
      tokenBalance(2, addrs.mint, addrs.bundleB, spec.bundleBAmount),
      tokenBalance(3, addrs.mint, addrs.otherBuyer, spec.otherBuyerAmount),
    ],
  });

  const fundingItemsFor = (wallet: string) => [
    {
      signature: `sig-fund-${wallet}`,
      slot: 50,
      transaction: {
        signatures: [`sig-fund-${wallet}`],
        message: { accountKeys: [accountKey(addrs.funder, { signer: true })], instructions: [systemTransfer(addrs.funder, wallet, 1_000_000)] },
      },
      meta: { innerInstructions: [] },
    },
  ];

  const mintBuffer = encodeMintBuffer();

  return makeFakeClient({
    getTransaction: async () => available(launchTx),
    getTransactionsForAddress: async (address: string) =>
      available({ data: address === addrs.bundleA || address === addrs.bundleB ? fundingItemsFor(address) : [], paginationToken: null }),
    getTransactionsForAddressPaginated: async () => ({ status: "COMPLETE", pagesFetched: 1, items: [], warnings: [] }),
    getTokenAccountsPaginated: async () => ({
      status: "COMPLETE",
      pagesFetched: 1,
      pages: [
        dasPage([
          dasEntry("acct-bundleA", addrs.mint, addrs.bundleA, spec.bundleAAmount),
          dasEntry("acct-bundleB", addrs.mint, addrs.bundleB, spec.bundleBAmount),
          dasEntry("acct-other", addrs.mint, addrs.otherBuyer, spec.otherBuyerAmount),
        ]),
      ],
      contextSlot: 200,
      warnings: [],
    }),
    getTokenSupply: async () =>
      available({ context: { slot: 200 }, value: { amount: spec.totalMinted, decimals: 6, uiAmount: null } }, { contextSlot: 200 }),
    getAccountInfo: async () => {
      const data: [string, string] = [mintBuffer.toString("base64"), "base64"];
      return available({ context: { slot: 200 }, value: { data, executable: false, lamports: 1, owner: TOKEN_PROGRAM_ID, rentEpoch: 0 } }, { contextSlot: 200 });
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

async function waitForReconciliation(jobId: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await prisma.solanaForensicsRun.findFirst({ where: { jobId }, orderBy: { createdAt: "desc" } });
    if (run && run.reconciliationStatus !== "PENDING") return run.reconciliationStatus;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return "TIMED_OUT_WAITING";
}

function buildMockedOrchestrator(): TokenIntelligenceOrchestrator {
  return new TokenIntelligenceOrchestrator({
    metadata: async () => ({ data: { name: "Fixture Token", symbol: "FIXT" }, errors: [] }),
    market: async () => ({ data: { pools: [], sources: [] }, errors: [] }),
    safety: async () => ({ data: { riskFactors: [], confidence: 0 }, errors: [] }),
    social: async () => ({ data: { findings: [] }, errors: [] }),
    aiSynthesis: async () => ({
      data: {
        riskLevel: "UNKNOWN",
        confidence: 0,
        positiveSignals: [],
        riskFactors: [],
        reasons: [],
        missingInformation: [],
        dataQualityWarnings: [],
        recommendation: "RESEARCH_ONLY",
      },
      errors: [],
    }),
    // The ONLY real worker in this fixture — everything it touches is either
    // the real local Postgres or the fake forensic RPC client below.
    bundleSniper: bundleSniperResearcher,
  });
}

class FixtureAssertionError extends Error {}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) throw new FixtureAssertionError(`${label}: expected ${String(expected)}, got ${String(actual)}`);
}

function assertClose(actual: number | null | undefined, expected: number, label: string): void {
  if (actual === null || actual === undefined || Math.abs(actual - expected) > 0.01) {
    throw new FixtureAssertionError(`${label}: expected ~${expected}, got ${String(actual)}`);
  }
}

async function runCase(spec: CaseSpec): Promise<void> {
  const addrs = deriveCaseAddresses(spec.seed);
  const signature = `fixture-sig-${spec.seed}`;
  const eventId = `fixture-event-${spec.seed}`;

  console.log(`\n=== case: ${spec.label} ===`);
  console.log(`mint: ${addrs.mint}`);
  console.log(`eventId: ${eventId}`);

  const event: TokenDiscoveryEvent = {
    id: eventId,
    source: "PUMPFUN",
    signature,
    mint: addrs.mint,
    discoveredAt: new Date("2026-01-01T00:00:00.000Z"),
    receivedAt: new Date("2026-01-01T00:00:01.000Z"),
    rawPayload: { fixture: spec.label },
  };

  const orchestrator = buildMockedOrchestrator();
  const preliminaryReport = await orchestrator.process(event);

  console.log(`preliminary report status: ${preliminaryReport.processing.status}`);
  console.log(`preliminary forensics status: ${preliminaryReport.forensics.status}`);
  if (preliminaryReport.forensics.status === "DISABLED") {
    throw new FixtureAssertionError("forensics enqueue is disabled — FORENSICS_ENQUEUE_ENABLED did not take effect");
  }

  if (preliminaryReport.forensics.status === "PENDING" && preliminaryReport.forensics.jobId) {
    console.log("forensic job is new — running the real standalone worker against the fake RPC client...");
    const client = buildCaseClient(addrs, spec, signature);
    const workerConfig = loadForensicsWorkerConfig({ FORENSICS_WORKER_ENABLED: "true" });
    const worker = new ForensicsWorker({
      db: prisma,
      workerId: `fixture-${spec.seed}`,
      config: { ...workerConfig, concurrency: 1, pollMs: 200 },
      createRpcClient: () => client,
      // Same wiring as forensics:worker's real entrypoint (forensicsWorkerMain.ts).
      onRunPersisted: (runId) => reconcileForensicsRun(prisma, runId).then(() => undefined),
    });
    worker.start();
    const jobStatus = await waitForJobSettlement(preliminaryReport.forensics.jobId, 15_000);
    const reconciliationStatus = await waitForReconciliation(preliminaryReport.forensics.jobId, 15_000);
    await worker.stop();
    console.log(`worker job settlement: ${jobStatus}`);
    console.log(`reconciliation status: ${reconciliationStatus}`);
    assertEqual(jobStatus, "COMPLETE", "job settlement status");
    assertEqual(reconciliationStatus, "SUCCESS", "reconciliation status");
  } else {
    console.log("forensic job already settled from a prior run — no new worker analysis needed (idempotency).");
  }

  const persistedReport = await prisma.tokenIntelligenceReport.findUnique({ where: { eventId } });
  if (!persistedReport) throw new FixtureAssertionError("intelligence report was not persisted");

  const gate = evaluateCandidateGate(
    persistedReport.forensicsEligibility
      ? {
          eligibility: persistedReport.forensicsEligibility as "ELIGIBLE" | "CAUTION" | "EXCLUDED" | "UNKNOWN",
          requiredEvidenceComplete: persistedReport.forensicsRequiredEvidenceComplete,
        }
      : undefined
  );

  console.log(`persisted forensics status: ${persistedReport.forensicsStatus}`);
  console.log(`persisted forensics eligibility: ${persistedReport.forensicsEligibility}`);
  console.log(`persisted forensics displaySeverity: ${persistedReport.forensicsDisplaySeverity}`);
  console.log(`persisted forensics reasonCodes: ${JSON.stringify(persistedReport.forensicsReasonCodes)}`);
  console.log(
    `initialBundledAcquisitionPct: ${persistedReport.forensicsInitialBundledAcquisitionPct}, currentBundleWalletHoldingsPct: ${persistedReport.forensicsCurrentBundleWalletHoldingsPct}`
  );
  console.log(`candidate gate: allowed=${gate.allowed} mode=${gate.mode} reasonCodes=${JSON.stringify(gate.reasonCodes)}`);

  const jobCount = await prisma.solanaForensicsJob.count({ where: { mint: addrs.mint } });
  const runCount = await prisma.solanaForensicsRun.count({ where: { mint: addrs.mint } });
  console.log(`jobs for this mint: ${jobCount} (must stay 1 across repeated executions)`);
  console.log(`runs for this mint: ${runCount} (must stay 1 for the settled job)`);
  assertEqual(jobCount, 1, "job count for mint");
  assertEqual(runCount, 1, "run count for mint");

  assertEqual(persistedReport.forensicsEligibility, spec.expectedEligibility, "persisted eligibility");
  assertEqual(persistedReport.forensicsDisplaySeverity, spec.expectedDisplaySeverity, "persisted displaySeverity");
  assertClose(persistedReport.forensicsCurrentBundleWalletHoldingsPct?.toNumber(), spec.expectedBundledPct, "currentBundleWalletHoldingsPct");
  assertClose(persistedReport.forensicsInitialBundledAcquisitionPct?.toNumber(), spec.expectedBundledPct, "initialBundledAcquisitionPct");
  assertEqual(gate.mode, spec.expectedGateMode, "candidate gate mode");
  assertEqual(gate.allowed, spec.expectedGateAllowed, "candidate gate allowed");

  console.log(`case OK: ${spec.label}`);
}

async function main(): Promise<void> {
  console.log("=== Phase 5E end-to-end integration fixture ===");
  console.log("Zero Helius/Solana RPC/X/Anthropic/Discord/trading calls — all external I/O in this script is faked or mocked.");

  for (const spec of CASES) {
    await runCase(spec);
  }

  console.log("\n=== all cases passed ===");
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[forensics:integration-fixture] FAILED:", err instanceof Error ? err.message : String(err));
  await prisma.$disconnect();
  process.exitCode = 1;
});
