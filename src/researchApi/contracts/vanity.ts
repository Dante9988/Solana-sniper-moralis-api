/**
 * Phase 7D.4 §7 — vanity address handoff contracts (v1). Public keys and reservation state only:
 * no private key and no keystore reference ever appears in a user-facing response.
 */

import { z } from "./zodOpenApi";

export const VanityChainQuerySchema = z.object({ chain: z.enum(["solana", "robinhood"]).default("solana") });

export const VanityAvailabilityResponseSchema = z
  .object({
    chain: z.string(),
    supported: z.boolean(),
    available: z.number().int().openapi({ description: "Addresses that can be reserved now." }),
    suffix: z.string().nullable(),
    reason: z.string().nullable(),
  })
  .openapi("VanityAvailability");

export const VanityHandoffSchema = z
  .object({
    version: z.literal(1),
    reservationId: z.string(),
    chain: z.literal("solana"),
    address: z.string(),
    generationType: z.literal("ed25519-keypair-suffix"),
    suffix: z.string(),
    status: z.enum(["RESERVED", "CONSUMED", "EXPIRED", "RELEASED"]),
    reservedAt: z.string(),
    expiresAt: z.string(),
    consumedAt: z.string().nullable(),
    deployed: z.literal(false).openapi({ description: "Always false: a reservation is not a token. Deployment is confirmed on chain, elsewhere." }),
    deployment: z.object({ program: z.literal("pump.fun"), role: z.literal("mint"), requiresServerSigner: z.literal(true), note: z.string() }),
  })
  .openapi("VanityHandoffV1");

export const ReserveVanityRequestSchema = z.object({ chain: z.enum(["solana", "robinhood"]) }).openapi("ReserveVanityRequest");
export const VanityReservationResponseSchema = z.object({ created: z.boolean(), reservation: VanityHandoffSchema }).openapi("VanityReservationResponse");
export const ActiveVanityReservationResponseSchema = z.object({ reservation: VanityHandoffSchema.nullable() }).openapi("ActiveVanityReservationResponse");
export const ConsumeVanityResponseSchema = z
  .object({ created: z.boolean(), reservation: VanityHandoffSchema, secretRef: z.string().openapi({ description: "Opaque server-side keystore reference for the launch signer. Internal callers only." }) })
  .openapi("ConsumeVanityResponse");
