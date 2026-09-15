/**
 * Phase 7D.4 §7 — vanity mint address inventory, reservation and handoff.
 *
 * Mechanism: OnlyPump-Vanity-Generator grinds Solana ed25519 keypairs whose address ends in
 * "pump"; the address becomes a pump.fun mint, whose keypair must co-sign the create transaction.
 * Robinhood Chain (Pons) has no equivalent — the Pons factory chooses the token address — so the
 * handoff is Solana-only and every other chain reports UNSUPPORTED.
 *
 * Invariants (enforced here and by CHECK constraints in the migration):
 *   - An address is handed to at most one reservation; reserve takes a row with FOR UPDATE SKIP
 *     LOCKED, so concurrent callers never receive the same address.
 *   - Reserve and consume are idempotent on their keys; a replay returns the original outcome.
 *   - Reservations expire; an expired reservation's address returns to the pool. A CONSUMED
 *     address never does.
 *   - Consume records that the launch service took the address. It signs nothing and broadcasts
 *     nothing; the launch itself is a separate, not-yet-enabled step.
 *   - The public handoff never contains the secret or its reference.
 */

import { randomUUID } from "node:crypto";

import { Prisma, type PrismaClient, type VanityAddress } from "@prisma/client";

export const VANITY_HANDOFF_VERSION = 1 as const;
export const VANITY_RESERVATION_TTL_MS = 15 * 60_000;
export const SUPPORTED_VANITY_CHAINS = ["solana"] as const;

export type VanityError = "UNSUPPORTED_CHAIN" | "NONE_AVAILABLE" | "NOT_FOUND" | "RESERVATION_EXPIRED" | "ALREADY_CONSUMED";
export type VanityResult<T> = { ok: true; value: T; created?: boolean } | { ok: false; code: VanityError; message: string };

export interface VanityHandoffV1 {
  version: typeof VANITY_HANDOFF_VERSION;
  reservationId: string;
  chain: "solana";
  address: string;
  generationType: "ed25519-keypair-suffix";
  suffix: string;
  status: "RESERVED" | "CONSUMED" | "EXPIRED" | "RELEASED";
  reservedAt: string;
  expiresAt: string;
  consumedAt: string | null;
  deployed: false;
  deployment: { program: "pump.fun"; role: "mint"; requiresServerSigner: true; note: string };
}

const DEPLOYMENT_NOTE = "Reserved for a future launch. No token exists at this address until a create transaction is confirmed on chain.";

export function toHandoff(row: Pick<VanityAddress, "address" | "suffix" | "status" | "reservationId" | "reservedAt" | "reservationExpiresAt" | "consumedAt">, now = new Date()): VanityHandoffV1 {
  if (!row.reservationId || !row.reservedAt || !row.reservationExpiresAt) throw new Error("row has no reservation");
  const status = row.status === "CONSUMED" ? "CONSUMED" : row.status === "RESERVED" ? (row.reservationExpiresAt <= now ? "EXPIRED" : "RESERVED") : "RELEASED";
  return {
    version: VANITY_HANDOFF_VERSION,
    reservationId: row.reservationId,
    chain: "solana",
    address: row.address,
    generationType: "ed25519-keypair-suffix",
    suffix: row.suffix,
    status,
    reservedAt: row.reservedAt.toISOString(),
    expiresAt: row.reservationExpiresAt.toISOString(),
    consumedAt: row.consumedAt?.toISOString() ?? null,
    deployed: false,
    deployment: { program: "pump.fun", role: "mint", requiresServerSigner: true, note: DEPLOYMENT_NOTE },
  };
}

const fail = <T>(code: VanityError, message: string): VanityResult<T> => ({ ok: false, code, message });

function isRetryable(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === "P2034" || error.code === "P2002") return true;
  return error.code === "P2010" && /40001|40P01/.test(`${(error.meta as { code?: string } | undefined)?.code ?? ""} ${error.message}`);
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (!isRetryable(error) || attempt >= 6) throw error;
      await new Promise((r) => setTimeout(r, 10 + Math.random() * 30 * (attempt + 1)));
    }
  }
}

export interface VanityAvailability {
  chain: string;
  supported: boolean;
  available: number;
  suffix: string | null;
  reason: string | null;
}

export async function getAvailability(db: PrismaClient, chain: string, now = new Date()): Promise<VanityAvailability> {
  if (!(SUPPORTED_VANITY_CHAINS as readonly string[]).includes(chain)) {
    return { chain, supported: false, available: 0, suffix: null, reason: chain === "robinhood" ? "Robinhood Chain token addresses are assigned by the Pons factory, so there is no vanity address to reserve." : "Vanity addresses are not offered on this chain." };
  }
  const rows = await db.$queryRaw<Array<{ suffix: string; n: bigint }>>`
    SELECT "suffix", count(*)::bigint AS n FROM "VanityAddress"
    WHERE "chain" = ${chain} AND ("status" = 'AVAILABLE' OR ("status" = 'RESERVED' AND "reservationExpiresAt" <= ${now}))
    GROUP BY "suffix" ORDER BY n DESC`;
  const available = rows.reduce((sum, r) => sum + Number(r.n), 0);
  return { chain, supported: true, available, suffix: rows[0]?.suffix ?? null, reason: available === 0 ? "No vanity addresses are in stock right now." : null };
}

export async function reserveVanityAddress(db: PrismaClient, params: { userId: string; chain: string; idempotencyKey: string; now?: Date }): Promise<VanityResult<VanityHandoffV1>> {
  const now = params.now ?? new Date();
  if (!(SUPPORTED_VANITY_CHAINS as readonly string[]).includes(params.chain)) return fail("UNSUPPORTED_CHAIN", "vanity addresses are only available for Solana launches");
  return withRetry(() =>
    db.$transaction(async (tx) => {
      // Serialises one user's concurrent reserves so they cannot each take a different address.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`vanity:${params.userId}`}))::text`;
      const prior = await tx.vanityAddress.findUnique({ where: { reservedBy_reserveIdempotencyKey: { reservedBy: params.userId, reserveIdempotencyKey: params.idempotencyKey } } });
      if (prior) return { ok: true, created: false, value: toHandoff(prior, now) } as const;
      // One live reservation per user: a second key returns the existing one rather than draining stock.
      const live = await tx.vanityAddress.findFirst({ where: { reservedBy: params.userId, status: "RESERVED", reservationExpiresAt: { gt: now }, chain: params.chain } });
      if (live) return { ok: true, created: false, value: toHandoff(live, now) } as const;
      const [pick] = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "VanityAddress"
        WHERE "chain" = ${params.chain} AND ("status" = 'AVAILABLE' OR ("status" = 'RESERVED' AND "reservationExpiresAt" <= ${now}))
        ORDER BY "importedAt", "id" LIMIT 1 FOR UPDATE SKIP LOCKED`;
      if (!pick) return fail<VanityHandoffV1>("NONE_AVAILABLE", "no vanity addresses are available right now");
      const row = await tx.vanityAddress.update({
        where: { id: pick.id },
        data: { status: "RESERVED", reservationId: randomUUID(), reservedBy: params.userId, reservedAt: now, reservationExpiresAt: new Date(now.getTime() + VANITY_RESERVATION_TTL_MS), reserveIdempotencyKey: params.idempotencyKey },
      });
      return { ok: true, created: true, value: toHandoff(row, now) } as const;
    })
  );
}

export async function getReservation(db: PrismaClient, userId: string, reservationId: string, now = new Date()): Promise<VanityHandoffV1 | null> {
  const row = await db.vanityAddress.findFirst({ where: { reservationId, reservedBy: userId } });
  return row ? toHandoff(row, now) : null;
}

export async function getActiveReservation(db: PrismaClient, userId: string, chain: string, now = new Date()): Promise<VanityHandoffV1 | null> {
  const row = await db.vanityAddress.findFirst({ where: { reservedBy: userId, chain, OR: [{ status: "CONSUMED" }, { status: "RESERVED", reservationExpiresAt: { gt: now } }] }, orderBy: { reservedAt: "desc" } });
  return row ? toHandoff(row, now) : null;
}

/** The owner gives the address back. Idempotent; a consumed address cannot be released. */
export async function releaseReservation(db: PrismaClient, params: { userId: string; reservationId: string; now?: Date }): Promise<VanityResult<{ released: true }>> {
  const now = params.now ?? new Date();
  return withRetry(() =>
    db.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<Array<{ id: string; status: string; reservedBy: string | null }>>`
        SELECT "id", "status", "reservedBy" FROM "VanityAddress" WHERE "reservationId" = ${params.reservationId} FOR UPDATE`;
      if (!row || row.reservedBy !== params.userId) return fail<{ released: true }>("NOT_FOUND", "no such reservation");
      if (row.status === "CONSUMED") return fail<{ released: true }>("ALREADY_CONSUMED", "this address was already handed to the launch service");
      await tx.vanityAddress.update({
        where: { id: row.id },
        data: { status: "AVAILABLE", reservationId: null, reservedBy: null, reservedAt: null, reservationExpiresAt: null, reserveIdempotencyKey: null, updatedAt: now },
      });
      return { ok: true, value: { released: true } } as const;
    })
  );
}

/**
 * Internal only (launch service, API key). Marks the address as taken for a launch so it can never
 * be reserved again. Signs nothing and broadcasts nothing.
 */
export async function consumeReservation(db: PrismaClient, params: { reservationId: string; idempotencyKey: string; now?: Date }): Promise<VanityResult<VanityHandoffV1 & { secretRef: string }>> {
  const now = params.now ?? new Date();
  type Out = VanityHandoffV1 & { secretRef: string };
  return withRetry(() =>
    db.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "VanityAddress" WHERE "reservationId" = ${params.reservationId} FOR UPDATE`;
      if (!locked) return fail<Out>("NOT_FOUND", "no such reservation");
      const row = await tx.vanityAddress.findUniqueOrThrow({ where: { id: locked.id } });
      if (row.status === "CONSUMED") {
        if (row.consumeIdempotencyKey === params.idempotencyKey) return { ok: true, created: false, value: { ...toHandoff(row, now), secretRef: row.secretRef } } as const;
        return fail<Out>("ALREADY_CONSUMED", "this reservation was already consumed");
      }
      if (row.status !== "RESERVED" || !row.reservationExpiresAt || row.reservationExpiresAt <= now) return fail<Out>("RESERVATION_EXPIRED", "the reservation expired; reserve again");
      const updated = await tx.vanityAddress.update({ where: { id: row.id }, data: { status: "CONSUMED", consumedAt: now, consumeIdempotencyKey: params.idempotencyKey } });
      return { ok: true, created: true, value: { ...toHandoff(updated, now), secretRef: updated.secretRef } } as const;
    })
  );
}

/** Addresses ever exposed publicly can never be used; retire any that slipped into stock. */
export async function retireAddresses(db: PrismaClient, addresses: readonly string[], reason: string): Promise<number> {
  if (addresses.length === 0) return 0;
  const r = await db.vanityAddress.updateMany({ where: { address: { in: [...addresses] }, status: { in: ["AVAILABLE", "RESERVED"] } }, data: { status: "RETIRED", retiredReason: reason, reservationId: null, reservedBy: null, reservedAt: null, reservationExpiresAt: null, reserveIdempotencyKey: null } });
  return r.count;
}
