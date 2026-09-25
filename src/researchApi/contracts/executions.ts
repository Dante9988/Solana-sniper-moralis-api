/**
 * Phase 7E.1 — contracts for real, wallet-signed execution.
 *
 * The shapes deliberately mirror the paper-trading contracts next door, because the two
 * flows should look the same to a client right up to the point where one spends money and
 * the other does not. The differences are the ones that matter:
 *
 *   - an ExecutionPlan contains CALLDATA, which the user's wallet signs (§3: never a key);
 *   - a submission records a transaction hash, which is not a result (§2);
 *   - state comes from the chain, not from the browser (§15).
 *
 * Amounts are decimal strings in base units, always, with `decimals` alongside.
 */

import { z } from "./zodOpenApi";

export const EXECUTIONS_API_VERSION = 1 as const;

const DecimalString = z.string().regex(/^\d+$/).openapi({ description: "Non-negative integer in base units, as a decimal string.", example: "10000000000000000" });
const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const TxHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

export const ExecutionStateSchema = z
  .enum([
    "QUOTE_READY",
    "SIMULATING",
    "SIMULATION_FAILED",
    "READY_FOR_REVIEW",
    "AWAITING_SIGNATURE",
    "USER_REJECTED",
    "SUBMITTED",
    "CONFIRMING",
    "CONFIRMED",
    "REVERTED",
    "DROPPED",
    "REPLACED",
    "UNKNOWN",
  ])
  .openapi("ExecutionState");

export const ExecutionVenueSchema = z.enum(["ROBINHOOD_PONS_CURVE", "ROBINHOOD_UNISWAP_V4"]).openapi("ExecutionVenue");

const UnsignedTransactionSchema = z
  .object({
    chainId: z.number().int(),
    to: Address,
    data: z.string().regex(/^0x[0-9a-fA-F]*$/),
    value: DecimalString.openapi({ description: "Native value to attach, in wei." }),
    gasLimit: DecimalString.nullable().openapi({ description: "Null means the wallet should estimate." }),
    description: z.string().openapi({ description: "Plain-language sentence to show the user before they sign." }),
  })
  .openapi("UnsignedTransaction");

const ApprovalRequirementSchema = z
  .object({
    kind: z.enum(["ERC20_TO_CURVE", "ERC20_TO_PERMIT2", "PERMIT2_TO_ROUTER"]),
    token: Address,
    tokenSymbol: z.string().nullable(),
    spender: Address,
    required: DecimalString.openapi({ description: "Exactly the trade's input amount. Never an unlimited allowance." }),
    current: DecimalString,
    currentExpiresAt: z.string().nullable().openapi({ description: "Permit2 allowances expire; null for a plain ERC-20 allowance." }),
    satisfied: z.boolean(),
    transaction: UnsignedTransactionSchema,
  })
  .openapi("ApprovalRequirement");

export const ExecutionPlanSchema = z
  .object({
    venue: ExecutionVenueSchema,
    route: z.object({ kind: z.enum(["BONDING_CURVE", "UNIVERSAL_ROUTER"]), target: Address }),
    chainId: z.number().int(),
    walletAddress: Address.openapi({ description: "The wallet that will sign. Claimed by the caller, not cryptographically proven." }),
    side: z.enum(["buy", "sell"]),
    tokenAddress: Address,
    approvals: z.array(ApprovalRequirementSchema).openapi({ description: "In order. Every unsatisfied approval must be signed and confirmed before the swap." }),
    swap: UnsignedTransactionSchema,
    poolId: z.string().nullable(),
    deadline: DecimalString.nullable().openapi({ description: "Unix seconds; null on the bonding curve, which has no deadline." }),
    expectedOutput: DecimalString,
    minimumOutput: DecimalString,
    quoteBlock: z.object({ number: DecimalString, hash: z.string(), timestamp: DecimalString }),
    calldataVersion: z.string(),
  })
  .openapi("ExecutionPlan");

export const CreateIntentRequestSchema = z
  .object({
    quoteId: z.string().uuid(),
    simulationId: z.string().uuid().optional(),
    walletAddress: Address,
  })
  .openapi("CreateExecutionIntentRequest");

const Unavailable = z.object({
  apiVersion: z.literal(EXECUTIONS_API_VERSION),
  status: z.literal("UNAVAILABLE"),
  reason: z.string(),
  detail: z.string(),
  retryable: z.literal(true),
});

/**
 * `REFUSED` is a 200, like every other "we looked and the answer is no" in this API.
 * `reason` is a stable code a client can branch on; `detail` is for a human.
 */
export const CreateIntentResponseSchema = z
  .discriminatedUnion("status", [
    z.object({
      apiVersion: z.literal(EXECUTIONS_API_VERSION),
      status: z.literal("READY"),
      intentId: z.string().uuid(),
      state: ExecutionStateSchema,
      plan: ExecutionPlanSchema,
    }),
    z.object({
      apiVersion: z.literal(EXECUTIONS_API_VERSION),
      status: z.literal("REFUSED"),
      reason: z.string().openapi({ example: "REAL_TRADING_DISABLED" }),
      detail: z.string(),
    }),
    Unavailable,
  ])
  .openapi("CreateExecutionIntentResponse");

export const CreateSubmissionRequestSchema = z
  .object({
    transactionHash: TxHash.openapi({ description: "The hash the user's wallet returned. Never a signature or a signed payload." }),
  })
  .openapi("CreateExecutionSubmissionRequest");

export const ExecutionReceiptSchema = z
  .object({
    status: ExecutionStateSchema,
    blockNumber: DecimalString,
    blockHash: z.string(),
    gasUsed: DecimalString,
    effectiveGasPrice: DecimalString.nullable(),
    actualInput: DecimalString.nullable().openapi({ description: "From the venue's own event. Null when no recognised event was found — never back-filled from the quote." }),
    actualOutput: DecimalString.nullable(),
    matchedWallet: z.boolean().openapi({ description: "The venue's event named this wallet as recipient. Always false on Uniswap V4, whose Swap event carries no recipient." }),
    failureReason: z.string().nullable(),
    reconciledAt: z.string(),
  })
  .openapi("ExecutionReceipt");

export const ExecutionSubmissionSchema = z
  .object({
    id: z.string().uuid(),
    transactionHash: TxHash,
    submittedAt: z.string(),
    receipt: ExecutionReceiptSchema.nullable(),
  })
  .openapi("ExecutionSubmission");

export const ExecutionSchema = z
  .object({
    id: z.string().uuid(),
    state: ExecutionStateSchema,
    stateLabel: z.string().openapi({ description: "User-facing wording for `state`, owned by the backend so the UI and API cannot drift." }),
    chain: z.string(),
    chainId: z.number().int(),
    walletAddress: Address,
    tokenAddress: Address,
    side: z.enum(["buy", "sell"]),
    venue: ExecutionVenueSchema,
    route: z.string(),
    input: z.object({ currency: Address, symbol: z.string().nullable(), decimals: z.number().int(), amount: DecimalString }),
    output: z.object({ currency: Address, symbol: z.string().nullable(), decimals: z.number().int() }),
    expectedOutput: DecimalString,
    minimumOutput: DecimalString,
    slippageBps: z.number().int(),
    quoteSnapshotId: z.string().uuid(),
    simulationSnapshotId: z.string().uuid().nullable(),
    failureReason: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    submissions: z.array(ExecutionSubmissionSchema),
    /** Never omitted, never true. A real trade is not practice, and the client must not guess. */
    paper: z.literal(false),
  })
  .openapi("Execution");

export const ExecutionResponseSchema = z
  .object({ apiVersion: z.literal(EXECUTIONS_API_VERSION), execution: ExecutionSchema })
  .openapi("ExecutionResponse");

export const ExecutionListResponseSchema = z
  .object({ apiVersion: z.literal(EXECUTIONS_API_VERSION), executions: z.array(ExecutionSchema) })
  .openapi("ExecutionListResponse");

export const ExecutionIdParamSchema = z.object({ intentId: z.string().uuid() }).openapi("ExecutionIdParam");
