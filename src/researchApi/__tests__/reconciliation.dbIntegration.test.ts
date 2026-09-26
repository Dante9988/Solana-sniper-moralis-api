/**
 * Phase 7E.1 §15 — the reconciliation loop against real PostgreSQL and a fake chain.
 *
 * The property that matters most is what happens when the chain CANNOT be read. A
 * provider outage must leave every pending trade exactly where it was: if an outage
 * advanced the miss counter, a long enough outage would mark a wallet's confirmed trades
 * DROPPED without ever having looked at one.
 *
 *   EXECUTIONS_RUN_DB_TESTS=true DATABASE_URL=postgresql://…/ci_7e1_test npx vitest run --no-file-parallelism src/researchApi/__tests__/reconciliation.dbIntegration.test.ts
 */

import { PrismaClient, type ExecutionState } from "@prisma/client";
import { encodeAbiParameters, getAbiItem, pad, toEventSelector } from "viem";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { PONS_V2_CURVE_ABI } from "../../pons/abiV2";
import { reconcileOnce, type ReceiptReader } from "../../pons/execution/reconciliationWorker";
import type { ReceiptFacts } from "../../pons/execution/venue";
import { MAX_RECONCILE_ATTEMPTS } from "../../services/executionService";

const RUN = process.env.EXECUTIONS_RUN_DB_TESTS === "true";

const USER = "cccccccc-0000-4000-8000-0000000007e1";
const TOKEN = "0x3bd9136d51af679bd1b11d06b951155543c5449f";
const CURVE = "0x074995b1c320d5e125b2105c08035f319aa82df8";
const WALLET = "0x1111111111111111111111111111111111111111";
const HASH = `0x${"e".repeat(64)}`;

const CURVE_BUY_TOPIC0 = toEventSelector(getAbiItem({ abi: PONS_V2_CURVE_ABI, name: "CurveBuy" }));

function curveBuyReceipt(options: { quoteIn: bigint; tokensOut: bigint; status?: "success" | "reverted" }): ReceiptFacts {
  return {
    status: options.status ?? "success",
    blockNumber: 62211600n,
    blockHash: `0x${"f".repeat(64)}`,
    gasUsed: 150_000n,
    effectiveGasPrice: 1_000_000_000n,
    logs: [
      {
        address: CURVE,
        topics: [CURVE_BUY_TOPIC0, pad(WALLET as `0x${string}`, { size: 32 }), pad(WALLET as `0x${string}`, { size: 32 })],
        data: encodeAbiParameters(
          [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
          [options.quoteIn, options.tokensOut, 0n, 0n]
        ),
      },
    ],
  };
}

describe.skipIf(!RUN)("execution reconciliation — Postgres", () => {
  const db = new PrismaClient();

  async function seed(): Promise<{ intentId: string; submissionId: string }> {
    const snapshot = await db.evidenceSnapshot.create({
      data: {
        kind: "QUOTE",
        status: "QUOTED",
        chain: "robinhood",
        tokenAddress: TOKEN,
        side: "buy",
        observedAt: new Date(),
        policyVersion: "quote-policy-1",
        payload: {},
        payloadSha256: "x".repeat(64),
        sourceReferences: [],
        missingEvidence: [],
      },
    });
    const intent = await db.executionIntent.create({
      data: {
        userId: USER,
        idempotencyKey: `recon-${Date.now()}-${Math.random()}`,
        requestFingerprint: "fp",
        chain: "robinhood",
        chainId: 4663,
        walletAddress: WALLET,
        tokenAddress: TOKEN,
        side: "buy",
        venue: "ROBINHOOD_PONS_CURVE",
        route: "BONDING_CURVE",
        routeTarget: CURVE,
        inputCurrency: "0x0000000000000000000000000000000000000000",
        inputSymbol: "ETH",
        inputDecimals: 18,
        inputAmount: "10000000000000000",
        outputCurrency: TOKEN,
        outputSymbol: "SMA",
        outputDecimals: 18,
        expectedOutput: "5000",
        minimumOutput: "4950",
        slippageBps: 100,
        calldata: "0xdeadbeef",
        callValue: "10000000000000000",
        calldataVersion: "pons-v2-execution-1",
        quoteSnapshotId: snapshot.id,
        state: "SUBMITTED",
      },
    });
    const submission = await db.submittedExecution.create({
      data: { intentId: intent.id, chain: "robinhood", transactionHash: HASH, walletAddress: WALLET },
    });
    return { intentId: intent.id, submissionId: submission.id };
  }

  async function stateOf(intentId: string): Promise<ExecutionState> {
    return (await db.executionIntent.findUniqueOrThrow({ where: { id: intentId } })).state;
  }

  async function cleanup() {
    await db.executionReceipt.deleteMany({ where: { submission: { intent: { userId: USER } } } });
    await db.submittedExecution.deleteMany({ where: { intent: { userId: USER } } });
    await db.executionIntent.deleteMany({ where: { userId: USER } });
    await db.$executeRawUnsafe(`ALTER TABLE "EvidenceSnapshot" DISABLE TRIGGER "EvidenceSnapshot_immutable"`);
    try {
      await db.$executeRawUnsafe(`DELETE FROM "EvidenceSnapshot" WHERE "tokenAddress" = '${TOKEN}'`);
    } finally {
      await db.$executeRawUnsafe(`ALTER TABLE "EvidenceSnapshot" ENABLE TRIGGER "EvidenceSnapshot_immutable"`);
    }
  }

  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await db.$disconnect();
  });

  const reader = (receipt: ReceiptFacts | null): ReceiptReader => ({
    async getReceipt() {
      return { status: "AVAILABLE", data: receipt, source: "test", fetchedAt: new Date(), attempts: 1 };
    },
  });

  const brokenReader: ReceiptReader = {
    async getReceipt() {
      return { status: "UNAVAILABLE", source: "test", fetchedAt: new Date(), code: "RPC_ERROR", reason: "provider down", attempts: 1 };
    },
  };

  it("confirms a trade from the curve's own event, not from the quote", async () => {
    const { intentId, submissionId } = await seed();
    const tick = await reconcileOnce({ db, reader: reader(curveBuyReceipt({ quoteIn: 9_900_000_000_000_000n, tokensOut: 4980n })) });

    expect(tick).toMatchObject({ checked: 1, confirmed: 1 });
    expect(await stateOf(intentId)).toBe("CONFIRMED");

    const receipt = await db.executionReceipt.findUniqueOrThrow({ where: { submissionId } });
    // The curve has no hook, so what it paid IS what the wallet kept.
    expect(receipt.netWalletOutput?.toFixed()).toBe("4980"); // not the quoted 5000
    expect(receipt.grossVenueOutput?.toFixed()).toBe("4980");
    expect(receipt.hookFeeAmount).toBeNull();
    expect(receipt.matchedWallet).toBe(true);
  });

  it("records a revert as REVERTED with no amounts", async () => {
    const { intentId, submissionId } = await seed();
    await reconcileOnce({ db, reader: reader(curveBuyReceipt({ quoteIn: 1n, tokensOut: 1n, status: "reverted" })) });

    expect(await stateOf(intentId)).toBe("REVERTED");
    const receipt = await db.executionReceipt.findUniqueOrThrow({ where: { submissionId } });
    expect(receipt.netWalletOutput).toBeNull();
    expect(receipt.grossVenueOutput).toBeNull();
    expect(receipt.failureReason).toBeTruthy();
  });

  it("confirms with null amounts when the receipt carries no event it recognises", async () => {
    const { intentId, submissionId } = await seed();
    const bare: ReceiptFacts = { status: "success", blockNumber: 1n, blockHash: "0xabc", gasUsed: 1n, effectiveGasPrice: null, logs: [] };
    await reconcileOnce({ db, reader: reader(bare) });

    expect(await stateOf(intentId)).toBe("CONFIRMED");
    const receipt = await db.executionReceipt.findUniqueOrThrow({ where: { submissionId } });
    // Reported as unknown rather than back-filled from the quote.
    expect(receipt.netWalletOutput).toBeNull();
    expect(receipt.grossVenueOutput).toBeNull();
    expect(receipt.actualInput).toBeNull();
  });

  it("leaves a not-yet-mined transaction pending and counts the miss", async () => {
    const { intentId, submissionId } = await seed();
    const tick = await reconcileOnce({ db, reader: reader(null) });

    expect(tick).toMatchObject({ checked: 1, stillPending: 1 });
    expect(await stateOf(intentId)).toBe("CONFIRMING");
    expect((await db.submittedExecution.findUniqueOrThrow({ where: { id: submissionId } })).reconcileAttempts).toBe(1);
  });

  it("does NOT advance the miss counter during a provider outage", async () => {
    const { intentId, submissionId } = await seed();
    for (let i = 0; i < MAX_RECONCILE_ATTEMPTS + 5; i += 1) {
      const tick = await reconcileOnce({ db, reader: brokenReader });
      expect(tick).toMatchObject({ unavailable: 1 });
    }

    // An outage is not evidence about the transaction. Had it counted, this would be DROPPED.
    expect(await stateOf(intentId)).toBe("SUBMITTED");
    expect((await db.submittedExecution.findUniqueOrThrow({ where: { id: submissionId } })).reconcileAttempts).toBe(0);
  });

  it("eventually calls a never-mined transaction DROPPED", async () => {
    const { intentId } = await seed();
    for (let i = 0; i < MAX_RECONCILE_ATTEMPTS; i += 1) {
      await reconcileOnce({ db, reader: reader(null) });
    }
    expect(await stateOf(intentId)).toBe("DROPPED");
  });

  it("stops looking at a trade once it is terminal", async () => {
    const { intentId } = await seed();
    await reconcileOnce({ db, reader: reader(curveBuyReceipt({ quoteIn: 1n, tokensOut: 2n })) });
    expect(await stateOf(intentId)).toBe("CONFIRMED");

    // A terminal trade is no longer pending, so a second pass has nothing to check.
    const tick = await reconcileOnce({ db, reader: reader(null) });
    expect(tick.checked).toBe(0);
    expect(await stateOf(intentId)).toBe("CONFIRMED");
  });

  it("is safe to run twice over the same receipt", async () => {
    const { intentId, submissionId } = await seed();
    const receipt = curveBuyReceipt({ quoteIn: 1n, tokensOut: 2n });
    await reconcileOnce({ db, reader: reader(receipt) });
    await reconcileOnce({ db, reader: reader(receipt) });

    expect(await stateOf(intentId)).toBe("CONFIRMED");
    expect(await db.executionReceipt.count({ where: { submissionId } })).toBe(1);
  });
});
