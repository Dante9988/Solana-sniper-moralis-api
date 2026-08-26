/**
 * Phase 5C — sanitized synthetic fixture builders. No real addresses,
 * signatures, or on-chain data. Used only to construct already-typed
 * `ForensicsClientResult<T>` values injected into a fake `ForensicsRpcClient`
 * — no test using these ever makes a network call.
 */

import {
  DasTokenAccountEntry,
  DasTokenAccountsResult,
  GetTransactionResult,
  Instruction,
  ParsedAccountKey,
  ParsedInstruction,
  TokenBalance,
} from "../rpcSchemas";
import { ForensicsClientFailureCode, ForensicsClientResult } from "../solanaForensicsClient";
import { SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "../wellKnownAccounts";

export function available<T>(data: T, opts: { contextSlot?: number; estimatedCredits?: number; source?: string } = {}): ForensicsClientResult<T> {
  return {
    status: "AVAILABLE",
    data,
    source: opts.source ?? "TEST_FIXTURE",
    fetchedAt: new Date("2026-01-01T00:00:00.000Z"),
    contextSlot: opts.contextSlot,
    estimatedCredits: opts.estimatedCredits ?? 1,
  };
}

export function unavailable<T>(code: ForensicsClientFailureCode, reason = "synthetic unavailable"): ForensicsClientResult<T> {
  return {
    status: "UNAVAILABLE",
    source: "TEST_FIXTURE",
    fetchedAt: new Date("2026-01-01T00:00:00.000Z"),
    code,
    reason,
    estimatedCredits: 1,
  };
}

export function accountKey(pubkey: string, opts: { signer?: boolean; writable?: boolean; source?: "transaction" | "lookupTable" } = {}): ParsedAccountKey {
  return { pubkey, signer: opts.signer ?? false, writable: opts.writable ?? true, source: opts.source };
}

export function parsedInstruction(programId: string, program: string, type: string, info: Record<string, unknown>): ParsedInstruction {
  return { program, programId, parsed: { type, info } };
}

export function systemTransfer(source: string, destination: string, lamports: number): ParsedInstruction {
  return parsedInstruction(SYSTEM_PROGRAM_ID, "system", "transfer", { source, destination, lamports });
}

export function initializeMint2(mint: string, mintAuthority: string, decimals = 6, freezeAuthority?: string): ParsedInstruction {
  return parsedInstruction(TOKEN_PROGRAM_ID, "spl-token", "initializeMint2", {
    mint,
    mintAuthority,
    decimals,
    ...(freezeAuthority ? { freezeAuthority } : {}),
  });
}

export function mintTo(mint: string, account: string, amount: string, programId: string = TOKEN_PROGRAM_ID): ParsedInstruction {
  return parsedInstruction(programId, "spl-token", "mintTo", { mint, account, amount });
}

export function tokenBalance(accountIndex: number, mint: string, owner: string, amount: string, decimals = 6): TokenBalance {
  return {
    accountIndex,
    mint,
    owner,
    uiTokenAmount: { amount, decimals, uiAmount: Number(amount) / 10 ** decimals, uiAmountString: amount },
  };
}

export interface BuildTransactionOptions {
  signature: string;
  slot: number;
  blockTime?: number | null;
  accountKeys: ParsedAccountKey[];
  instructions?: Instruction[];
  innerInstructions?: { index: number; instructions: Instruction[] }[];
  preTokenBalances?: TokenBalance[];
  postTokenBalances?: TokenBalance[];
  preBalances?: number[];
  postBalances?: number[];
}

export function buildTransaction(opts: BuildTransactionOptions): NonNullable<GetTransactionResult> {
  return {
    slot: opts.slot,
    blockTime: opts.blockTime ?? null,
    transaction: {
      signatures: [opts.signature],
      message: { accountKeys: opts.accountKeys, instructions: opts.instructions ?? [] },
    },
    meta: {
      err: null,
      preBalances: opts.preBalances ?? [],
      postBalances: opts.postBalances ?? [],
      preTokenBalances: opts.preTokenBalances ?? [],
      postTokenBalances: opts.postTokenBalances ?? [],
      innerInstructions: opts.innerInstructions ?? [],
    },
  };
}

export function dasEntry(address: string, mint: string, owner: string, amount: string): DasTokenAccountEntry {
  return { address, mint, owner, amount };
}

export function dasPage(entries: DasTokenAccountEntry[], opts: { cursor?: string | null; total?: number; contextSlot?: number } = {}): DasTokenAccountsResult {
  return {
    total: opts.total ?? entries.length,
    limit: 1000,
    cursor: opts.cursor ?? null,
    last_indexed_slot: opts.contextSlot ?? 1,
    token_accounts: entries,
  };
}

export const WELL_KNOWN = { SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID };
