/**
 * Phase 5B runtime response validation. Every field this module returns is
 * either a validated primitive or an untrusted `unknown`/passthrough blob —
 * nothing from a Helius/Solana RPC response is trusted without a schema.
 */

import { z } from "zod";

export const JsonRpcErrorSchema = z.object({
  code: z.number(),
  message: z.string(),
  data: z.unknown().optional(),
});

export const JsonRpcEnvelopeSchema = z.object({
  jsonrpc: z.string(),
  id: z.union([z.string(), z.number()]),
  result: z.unknown().optional(),
  error: JsonRpcErrorSchema.optional(),
});
export type JsonRpcEnvelope = z.infer<typeof JsonRpcEnvelopeSchema>;

/**
 * Minimal JSON tokenizer used only to distinguish object keys / numeric
 * literals / string contents from each other. It does not build a value
 * tree — it is purely a lexer, so it stays small while still being
 * string-aware (respects escaped quotes/backslashes) and format-aware
 * (recognizes decimals/exponents/negatives as NUMBER tokens without treating
 * them as safe to rewrite).
 */
type JsonToken =
  | { kind: "punct"; raw: "{" | "}" | "[" | "]" | ":" | "," }
  | { kind: "string"; raw: string }
  | { kind: "number"; raw: string }
  | { kind: "literal"; raw: string }
  | { kind: "ws"; raw: string };

function tokenizeJson(text: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];

    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      let j = i;
      while (j < n && (text[j] === " " || text[j] === "\t" || text[j] === "\n" || text[j] === "\r")) j += 1;
      tokens.push({ kind: "ws", raw: text.slice(i, j) });
      i = j;
      continue;
    }

    if (ch === "{" || ch === "}" || ch === "[" || ch === "]" || ch === ":" || ch === ",") {
      tokens.push({ kind: "punct", raw: ch });
      i += 1;
      continue;
    }

    if (ch === '"') {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const c = text[j];
        if (c === "\\") {
          // Skip the escape marker and whatever it escapes (handles \" and \\ alike).
          j += 2;
          continue;
        }
        if (c === '"') {
          j += 1;
          closed = true;
          break;
        }
        j += 1;
      }
      if (!closed) throw new SyntaxError("Unterminated string in JSON input");
      tokens.push({ kind: "string", raw: text.slice(i, j) });
      i = j;
      continue;
    }

    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      let j = i;
      if (text[j] === "-") j += 1;
      while (j < n && text[j] >= "0" && text[j] <= "9") j += 1;
      if (text[j] === ".") {
        j += 1;
        while (j < n && text[j] >= "0" && text[j] <= "9") j += 1;
      }
      if (text[j] === "e" || text[j] === "E") {
        j += 1;
        if (text[j] === "+" || text[j] === "-") j += 1;
        while (j < n && text[j] >= "0" && text[j] <= "9") j += 1;
      }
      tokens.push({ kind: "number", raw: text.slice(i, j) });
      i = j;
      continue;
    }

    if (text.startsWith("true", i)) {
      tokens.push({ kind: "literal", raw: "true" });
      i += 4;
      continue;
    }
    if (text.startsWith("false", i)) {
      tokens.push({ kind: "literal", raw: "false" });
      i += 5;
      continue;
    }
    if (text.startsWith("null", i)) {
      tokens.push({ kind: "literal", raw: "null" });
      i += 4;
      continue;
    }

    throw new SyntaxError(`Unexpected character ${JSON.stringify(ch)} at position ${i} in JSON input`);
  }
  return tokens;
}

function isPlainUnsignedInteger(raw: string): boolean {
  return /^\d+$/.test(raw);
}

/**
 * Rewrites bare (unquoted) unsigned-integer JSON values to quoted strings so
 * that values exceeding `Number.MAX_SAFE_INTEGER` (real for large-supply SPL
 * tokens) never round-trip through lossy `JSON.parse` float conversion.
 *
 * This is backed by a real string-aware tokenizer, not a regex over raw
 * text: a JSON string token immediately followed by a `:` punctuation token
 * is — by JSON grammar — necessarily an object key, never a string *value*
 * (nothing inside a quoted string can itself produce an unescaped `:` token,
 * because the tokenizer only emits `:` outside of strings). So a field-like
 * substring that merely appears inside a quoted string is structurally
 * impossible to mistake for a key here, regardless of nesting depth.
 *
 * Only rewrites when ALL of the following hold: the key is in
 * `allowedFieldNames`, the value token is a NUMBER, and that number is a
 * plain unsigned integer (no `-`, `.`, or `e`/`E`). A decimal, exponent, or
 * negative value under an allowlisted key is left as a raw JSON number —
 * schema validation (which expects a string) then correctly rejects it
 * rather than this function reinterpreting it.
 */
export function parseJsonPreservingIntegerFields(rawText: string, fieldNames: readonly string[]): unknown {
  const allowed = new Set(fieldNames);
  const tokens = tokenizeJson(rawText);
  let out = "";

  for (let idx = 0; idx < tokens.length; idx += 1) {
    const token = tokens[idx];

    if (token.kind === "string") {
      let j = idx + 1;
      while (j < tokens.length && tokens[j].kind === "ws") j += 1;
      const colon = tokens[j];

      if (colon && colon.kind === "punct" && colon.raw === ":") {
        let k = j + 1;
        while (k < tokens.length && tokens[k].kind === "ws") k += 1;
        const valueToken = tokens[k];
        const keyName = JSON.parse(token.raw) as string;

        if (
          valueToken &&
          valueToken.kind === "number" &&
          allowed.has(keyName) &&
          isPlainUnsignedInteger(valueToken.raw)
        ) {
          for (let m = idx; m <= k; m += 1) {
            out += m === k ? `"${valueToken.raw}"` : tokens[m].raw;
          }
          idx = k;
          continue;
        }
      }
    }

    out += token.raw;
  }

  return JSON.parse(out);
}

const contextSchema = z.object({
  slot: z.number().int().nonnegative(),
  apiVersion: z.string().optional(),
});

export const TokenSupplyResultSchema = z.object({
  context: contextSchema,
  value: z.object({
    amount: z.string(),
    decimals: z.number().int().nonnegative(),
    uiAmount: z.number().nullable(),
    uiAmountString: z.string().optional(),
  }),
});
export type TokenSupplyResult = z.infer<typeof TokenSupplyResultSchema>;

/** `amount`/`delegated_amount` are pre-processed to strings by `parseJsonPreservingIntegerFields`. */
export const DasTokenAccountEntrySchema = z
  .object({
    address: z.string(),
    mint: z.string(),
    owner: z.string(),
    amount: z.string(),
    delegated_amount: z.string().optional(),
    frozen: z.boolean().optional(),
  })
  .passthrough();
export type DasTokenAccountEntry = z.infer<typeof DasTokenAccountEntrySchema>;

export const DasTokenAccountsResultSchema = z.object({
  total: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
  cursor: z.string().nullable().optional(),
  before: z.string().nullable().optional(),
  after: z.string().nullable().optional(),
  last_indexed_slot: z.number().int().nonnegative().optional(),
  token_accounts: z.array(DasTokenAccountEntrySchema),
});
export type DasTokenAccountsResult = z.infer<typeof DasTokenAccountsResultSchema>;

export const TransactionsForAddressItemSchema = z
  .object({
    signature: z.string(),
    slot: z.number().int().nonnegative().optional(),
    err: z.unknown().nullable().optional(),
    blockTime: z.number().int().nullable().optional(),
    memo: z.string().nullable().optional(),
  })
  .passthrough();
export type TransactionsForAddressItem = z.infer<typeof TransactionsForAddressItemSchema>;

export const TransactionsForAddressResultSchema = z.object({
  data: z.array(TransactionsForAddressItemSchema),
  paginationToken: z.string().nullable().optional(),
});
export type TransactionsForAddressResult = z.infer<typeof TransactionsForAddressResultSchema>;

export const SignatureForAddressEntrySchema = z.object({
  signature: z.string(),
  slot: z.number().int().nonnegative().optional(),
  err: z.unknown().nullable().optional(),
  memo: z.string().nullable().optional(),
  blockTime: z.number().int().nullable().optional(),
  confirmationStatus: z.string().optional(),
});
export const SignaturesForAddressResultSchema = z.array(SignatureForAddressEntrySchema);
export type SignaturesForAddressResult = z.infer<typeof SignaturesForAddressResultSchema>;

/** Deliberately loose on `transaction`/`meta` — full decoding is Phase 5C's job. */
export const GetTransactionResultSchema = z
  .object({
    slot: z.number().int().nonnegative(),
    blockTime: z.number().int().nullable().optional(),
    transaction: z.unknown(),
    meta: z.unknown().nullable().optional(),
    version: z.union([z.number(), z.string()]).optional(),
  })
  .nullable();
export type GetTransactionResult = z.infer<typeof GetTransactionResultSchema>;

export const TokenLargestAccountEntrySchema = z.object({
  address: z.string(),
  amount: z.string(),
  decimals: z.number().int().nonnegative(),
  uiAmount: z.number().nullable(),
  uiAmountString: z.string().optional(),
});
export const TokenLargestAccountsResultSchema = z.object({
  context: contextSchema,
  value: z.array(TokenLargestAccountEntrySchema),
});
export type TokenLargestAccountsResult = z.infer<typeof TokenLargestAccountsResultSchema>;

const accountInfoValueSchema = z
  .object({
    data: z.union([z.tuple([z.string(), z.string()]), z.object({}).passthrough()]),
    executable: z.boolean(),
    lamports: z.number(),
    owner: z.string(),
    rentEpoch: z.number().optional(),
  })
  .nullable();

export const AccountInfoResultSchema = z.object({
  context: contextSchema,
  value: accountInfoValueSchema,
});
export type AccountInfoResult = z.infer<typeof AccountInfoResultSchema>;

export const MultipleAccountsResultSchema = z.object({
  context: contextSchema,
  value: z.array(accountInfoValueSchema),
});
export type MultipleAccountsResult = z.infer<typeof MultipleAccountsResultSchema>;
