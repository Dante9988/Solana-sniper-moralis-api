/**
 * Phase 7D.3.2 §5/§6 — evidence snapshots and paper positions.
 *
 * Three things are kept strictly apart, in storage and in wording:
 *   - a QUOTE snapshot     — an estimate at one block
 *   - a SIMULATION snapshot — the route executed at that block from a synthetic account
 *   - a PAPER POSITION     — a user's saved fill, based on one of the above
 *
 * Snapshots are immutable (database trigger). Paper positions are scoped to the Supabase
 * user and idempotent per (user, key).
 */

import { createHash } from "node:crypto";

import { Prisma, type EvidenceSnapshot, type PaperPosition, type PrismaClient } from "@prisma/client";

import type { PonsQuote, QuoteOutcome } from "../pons/quote/quoteService";
import { QUOTE_POLICY_VERSION } from "../pons/quote/quoteService";
import type { SimulationOutcome } from "../pons/quote/simulationService";
import { QUOTE_SOURCE_REFERENCES } from "../pons/quote/protocol";

/** JSON with sorted keys, so the payload hash does not depend on property order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : typeof v === "bigint"
        ? v.toString()
        : v
  );
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export async function saveQuoteSnapshot(
  db: PrismaClient,
  outcome: Exclude<QuoteOutcome, { status: "UNAVAILABLE" }>,
  request: { tokenAddress: string; side: string; amountIn: string; slippageBps: number }
): Promise<EvidenceSnapshot> {
  const payload = { request, outcome };
  const text = canonicalJson(payload);
  const quote = outcome.status === "QUOTED" ? outcome.quote : null;
  const block = quote?.block ?? (outcome.status === "UNSUPPORTED" ? outcome.block : null);

  const missing: { code: string; detail: string }[] = [];
  if (outcome.status === "UNSUPPORTED") missing.push({ code: outcome.reason, detail: outcome.detail });
  if (quote) {
    for (const fee of quote.fees) {
      if (!fee.amount.exact) missing.push({ code: "FEE_SPLIT_RANGE", detail: `${fee.kind} is known only to within ${BigInt(fee.amount.max) - BigInt(fee.amount.min)} base unit(s)` });
    }
    if (quote.venue === "PONS_V2_UNISWAP_V4" && quote.priceImpact.poolOnlyBps === null) {
      missing.push({ code: "POOL_ONLY_IMPACT_UNRESOLVED", detail: "hook fee split could not be reconstructed" });
    }
  }

  return db.evidenceSnapshot.create({
    data: {
      kind: "QUOTE",
      status: outcome.status,
      chain: "robinhood",
      tokenAddress: request.tokenAddress.toLowerCase(),
      side: request.side,
      blockNumber: block ? BigInt(block.number) : null,
      blockHash: block?.hash ?? null,
      blockTimestamp: block ? new Date(Number(block.timestamp) * 1000) : null,
      observedAt: quote ? new Date(quote.quotedAt) : new Date(),
      expiresAt: quote ? new Date(quote.expiresAt) : null,
      calculationVersion: quote?.calculationVersion ?? null,
      policyVersion: quote?.policyVersion ?? QUOTE_POLICY_VERSION,
      payload: JSON.parse(text) as Prisma.InputJsonValue,
      payloadSha256: sha256(text),
      sourceReferences: JSON.parse(canonicalJson(quote?.sourceReferences ?? QUOTE_SOURCE_REFERENCES)) as Prisma.InputJsonValue,
      missingEvidence: missing as unknown as Prisma.InputJsonValue,
    },
  });
}

export async function saveSimulationSnapshot(
  db: PrismaClient,
  quoteSnapshot: EvidenceSnapshot,
  outcome: Exclude<SimulationOutcome, { status: "UNAVAILABLE" }>
): Promise<EvidenceSnapshot> {
  const payload = { quoteSnapshotId: quoteSnapshot.id, outcome };
  const text = canonicalJson(payload);
  const missing =
    outcome.status === "UNSUPPORTED"
      ? [{ code: outcome.reason, detail: outcome.detail }]
      : outcome.status === "SIMULATED" && !outcome.result.matchesQuote
        ? [{ code: "SIMULATION_DIFFERS_FROM_QUOTE", detail: `simulated ${outcome.result.received}, quoted ${outcome.result.expectedOut}` }]
        : [];

  return db.evidenceSnapshot.create({
    data: {
      kind: "SIMULATION",
      status: outcome.status,
      chain: quoteSnapshot.chain,
      tokenAddress: quoteSnapshot.tokenAddress,
      side: quoteSnapshot.side,
      parentId: quoteSnapshot.id,
      blockNumber: quoteSnapshot.blockNumber,
      blockHash: quoteSnapshot.blockHash,
      blockTimestamp: quoteSnapshot.blockTimestamp,
      observedAt: outcome.status === "UNSUPPORTED" ? new Date() : new Date(outcome.simulatedAt),
      // A simulation is only as fresh as the quote it ran against.
      expiresAt: quoteSnapshot.expiresAt,
      calculationVersion: outcome.status === "UNSUPPORTED" ? null : outcome.calculationVersion,
      policyVersion: quoteSnapshot.policyVersion,
      payload: JSON.parse(text) as Prisma.InputJsonValue,
      payloadSha256: sha256(text),
      sourceReferences: quoteSnapshot.sourceReferences as Prisma.InputJsonValue,
      missingEvidence: missing as unknown as Prisma.InputJsonValue,
    },
  });
}

export function quoteFromSnapshot(snapshot: EvidenceSnapshot): PonsQuote | null {
  if (snapshot.kind !== "QUOTE" || snapshot.status !== "QUOTED") return null;
  const payload = snapshot.payload as { outcome?: { status?: string; quote?: PonsQuote } };
  return payload.outcome?.status === "QUOTED" && payload.outcome.quote ? payload.outcome.quote : null;
}

export function simulationFromSnapshot(snapshot: EvidenceSnapshot): SimulationOutcome | null {
  if (snapshot.kind !== "SIMULATION") return null;
  return ((snapshot.payload as { outcome?: SimulationOutcome }).outcome ?? null) as SimulationOutcome | null;
}

export type CreatePaperPositionResult =
  | { ok: true; created: boolean; position: PaperPositionWithEvidence }
  | {
      ok: false;
      code:
        | "QUOTE_NOT_FOUND"
        | "QUOTE_NOT_FILLABLE"
        | "QUOTE_EXPIRED"
        | "SIMULATION_NOT_FOUND"
        | "SIMULATION_NOT_FOR_QUOTE"
        | "SIMULATION_NOT_SUCCESSFUL"
        | "IDEMPOTENCY_KEY_REUSED";
      message: string;
    };

export type PaperPositionWithEvidence = PaperPosition & { quoteSnapshot: EvidenceSnapshot; simulationSnapshot: EvidenceSnapshot | null };

const WITH_EVIDENCE = { quoteSnapshot: true, simulationSnapshot: true } as const;

export async function createPaperPosition(
  db: PrismaClient,
  params: { userId: string; idempotencyKey: string; quoteId: string; simulationId: string | null; now?: Date }
): Promise<CreatePaperPositionResult> {
  const fingerprint = sha256(canonicalJson({ quoteId: params.quoteId, simulationId: params.simulationId }));

  const existing = await db.paperPosition.findUnique({
    where: { userId_idempotencyKey: { userId: params.userId, idempotencyKey: params.idempotencyKey } },
    include: WITH_EVIDENCE,
  });
  if (existing) return replay(existing, fingerprint);

  const now = params.now ?? new Date();
  const quoteSnapshot = await db.evidenceSnapshot.findUnique({ where: { id: params.quoteId } });
  if (!quoteSnapshot || quoteSnapshot.kind !== "QUOTE") return { ok: false, code: "QUOTE_NOT_FOUND", message: "no such quote" };
  const quote = quoteFromSnapshot(quoteSnapshot);
  if (!quote) return { ok: false, code: "QUOTE_NOT_FILLABLE", message: "this quote did not produce a price, so there is nothing to fill" };
  if (!quoteSnapshot.expiresAt || quoteSnapshot.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, code: "QUOTE_EXPIRED", message: "the quote has expired; request a new quote and simulation" };
  }

  let fillBasis: "EXECUTION_SIMULATION" | "QUOTE" = "QUOTE";
  let inputAmount = quote.spent;
  let outputAmount = quote.output.expected;
  let simulationSnapshot: EvidenceSnapshot | null = null;

  if (params.simulationId) {
    simulationSnapshot = await db.evidenceSnapshot.findUnique({ where: { id: params.simulationId } });
    if (!simulationSnapshot || simulationSnapshot.kind !== "SIMULATION") return { ok: false, code: "SIMULATION_NOT_FOUND", message: "no such simulation" };
    if (simulationSnapshot.parentId !== quoteSnapshot.id) {
      return { ok: false, code: "SIMULATION_NOT_FOR_QUOTE", message: "the simulation belongs to a different quote" };
    }
    const sim = simulationFromSnapshot(simulationSnapshot);
    if (!sim || sim.status !== "SIMULATED") {
      return { ok: false, code: "SIMULATION_NOT_SUCCESSFUL", message: "only a successful simulation can back a paper fill" };
    }
    fillBasis = "EXECUTION_SIMULATION";
    inputAmount = sim.result.spent;
    outputAmount = sim.result.received;
  }

  try {
    const position = await db.paperPosition.create({
      data: {
        userId: params.userId,
        idempotencyKey: params.idempotencyKey,
        requestFingerprint: fingerprint,
        chain: quote.chain,
        tokenAddress: quote.tokenAddress,
        side: quote.side,
        venue: quote.venue,
        fillBasis,
        inputCurrency: quote.input.currency,
        inputSymbol: quote.input.symbol,
        inputDecimals: quote.input.decimals,
        inputAmount: new Prisma.Decimal(inputAmount),
        outputCurrency: quote.output.currency,
        outputSymbol: quote.output.symbol,
        outputDecimals: quote.output.decimals,
        outputAmount: new Prisma.Decimal(outputAmount),
        minimumOutput: new Prisma.Decimal(quote.output.minimum),
        quoteSnapshotId: quoteSnapshot.id,
        simulationSnapshotId: simulationSnapshot?.id ?? null,
      },
      include: WITH_EVIDENCE,
    });
    return { ok: true, created: true, position };
  } catch (error) {
    // Two identical requests racing: the loser reads the winner's row.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const winner = await db.paperPosition.findUnique({
        where: { userId_idempotencyKey: { userId: params.userId, idempotencyKey: params.idempotencyKey } },
        include: WITH_EVIDENCE,
      });
      if (winner) return replay(winner, fingerprint);
    }
    throw error;
  }
}

function replay(existing: PaperPositionWithEvidence, fingerprint: string): CreatePaperPositionResult {
  if (existing.requestFingerprint !== fingerprint) {
    return { ok: false, code: "IDEMPOTENCY_KEY_REUSED", message: "this idempotency key was already used for a different paper fill" };
  }
  return { ok: true, created: false, position: existing };
}

export async function listPaperPositions(db: PrismaClient, userId: string, limit = 100): Promise<PaperPositionWithEvidence[]> {
  return db.paperPosition.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: limit, include: WITH_EVIDENCE });
}
