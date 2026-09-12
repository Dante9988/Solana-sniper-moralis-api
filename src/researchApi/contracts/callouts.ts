/**
 * Phase 7F.2 — Zod contract for `/api/v1/callouts` (verifiable callouts & PnL sharing).
 *
 * Same rule as every other contract here: this is the single definition the route, the
 * OpenAPI document and the generated frontend client all derive from.
 */

import { z } from "./zodOpenApi";

export const CalloutSchema = z
  .object({
    tokenAddress: z.string().openapi({ example: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm" }),
    tokenSymbol: z.string().nullable().openapi({ example: "WIF" }),
    tokenName: z.string().nullable().openapi({ example: "dogwifhat" }),
    pnlPercentage: z
      .number()
      .openapi({ description: "Verified PnL at check time, in percent.", example: 650 }),
    initialMarketCap: z.number().openapi({ example: 18000 }),
    currentMarketCap: z.number().nullable().openapi({ example: 135000 }),
    multiple: z
      .number()
      .nullable()
      .openapi({ description: "currentMarketCap / initialMarketCap, or null when not computable.", example: 7.5 }),
    alertedAt: z.string().openapi({ description: "When the call was first made (ISO 8601)." }),
    verifiedAt: z
      .string()
      .nullable()
      .openapi({ description: "When the tracker last verified the PnL against market data (ISO 8601)." }),
    shared: z
      .boolean()
      .openapi({ description: "Whether the PnL card was actually shared to Discord/Telegram." }),
  })
  .openapi("Callout");

export const CalloutListResponseSchema = z
  .object({
    apiVersion: z.literal(1),
    callouts: z.array(CalloutSchema),
  })
  .openapi("CalloutListResponse");

export type Callout = z.infer<typeof CalloutSchema>;
