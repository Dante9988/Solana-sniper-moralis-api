import { describe, expect, it } from "vitest";
import {
  DasTokenAccountsResultSchema,
  JsonRpcEnvelopeSchema,
  parseJsonPreservingIntegerFields,
  TokenSupplyResultSchema,
} from "../rpcSchemas";

const FIELDS = ["amount", "delegated_amount"];

describe("parseJsonPreservingIntegerFields — tokenizer hardening", () => {
  it("preserves a value above Number.MAX_SAFE_INTEGER exactly", () => {
    const raw = `{"amount":123456789012345678901234}`;
    const parsed = parseJsonPreservingIntegerFields(raw, FIELDS) as { amount: string };
    expect(parsed.amount).toBe("123456789012345678901234");
    expect(BigInt(parsed.amount)).toBe(123456789012345678901234n);
  });

  it("preserves a maximum-realistic SPL supply amount (u64 max)", () => {
    const u64Max = "18446744073709551615";
    const raw = `{"amount":${u64Max}}`;
    const parsed = parseJsonPreservingIntegerFields(raw, FIELDS) as { amount: string };
    expect(parsed.amount).toBe(u64Max);
  });

  it("rewrites the target field inside nested objects and arrays", () => {
    const raw = `{"outer":{"list":[{"amount":1000000000000000000},{"nested":{"amount":2}}]}}`;
    const parsed = parseJsonPreservingIntegerFields(raw, FIELDS) as {
      outer: { list: [{ amount: string }, { nested: { amount: string } }] };
    };
    expect(parsed.outer.list[0].amount).toBe("1000000000000000000");
    expect(parsed.outer.list[1].nested.amount).toBe("2");
  });

  it("does not rewrite the field name when it appears only inside a string VALUE", () => {
    const raw = `{"note":"the amount:123 field is just text","other":5}`;
    const parsed = parseJsonPreservingIntegerFields(raw, FIELDS) as { note: string; other: number };
    expect(parsed.note).toBe("the amount:123 field is just text");
    expect(parsed.other).toBe(5);
  });

  it("handles escaped quotes inside strings without breaking key detection", () => {
    const raw = `{"label":"a \\"quoted\\" word","amount":42}`;
    const parsed = parseJsonPreservingIntegerFields(raw, FIELDS) as { label: string; amount: string };
    expect(parsed.label).toBe('a "quoted" word');
    expect(parsed.amount).toBe("42");
  });

  it("handles escaped backslashes inside strings without breaking key detection", () => {
    const raw = `{"path":"C:\\\\Users\\\\amount","amount":7}`;
    const parsed = parseJsonPreservingIntegerFields(raw, FIELDS) as { path: string; amount: string };
    expect(parsed.path).toBe("C:\\Users\\amount");
    expect(parsed.amount).toBe("7");
  });

  it("leaves already-quoted string fields untouched", () => {
    const raw = `{"amount":"9999999999999999999"}`;
    const parsed = parseJsonPreservingIntegerFields(raw, FIELDS) as { amount: string };
    expect(parsed.amount).toBe("9999999999999999999");
  });

  it("does not touch adjacent non-target fields with similar names", () => {
    const raw = `{"amountUsd":42,"amount":7,"delegated_amount_max":9}`;
    const parsed = parseJsonPreservingIntegerFields(raw, FIELDS) as {
      amountUsd: number;
      amount: string;
      delegated_amount_max: number;
    };
    expect(parsed.amountUsd).toBe(42);
    expect(parsed.amount).toBe("7");
    expect(parsed.delegated_amount_max).toBe(9);
  });

  it("does not rewrite a decimal value under an allowlisted key (left for schema rejection)", () => {
    const raw = `{"amount":1.5}`;
    const parsed = parseJsonPreservingIntegerFields(raw, FIELDS) as { amount: number };
    expect(parsed.amount).toBe(1.5);
    expect(typeof parsed.amount).toBe("number");
  });

  it("does not rewrite an exponent-notation value under an allowlisted key", () => {
    const raw = `{"amount":1e21}`;
    const parsed = parseJsonPreservingIntegerFields(raw, FIELDS) as { amount: number };
    expect(typeof parsed.amount).toBe("number");
  });

  it("does not rewrite a negative value under an allowlisted key", () => {
    const raw = `{"amount":-5}`;
    const parsed = parseJsonPreservingIntegerFields(raw, FIELDS) as { amount: number };
    expect(parsed.amount).toBe(-5);
    expect(typeof parsed.amount).toBe("number");
  });

  it("throws on malformed/truncated JSON instead of returning a wrong value", () => {
    expect(() => parseJsonPreservingIntegerFields(`{"amount":123`, FIELDS)).toThrow();
    expect(() => parseJsonPreservingIntegerFields(`{"amount":"unterminated`, FIELDS)).toThrow();
  });

  it("handles a large but well-formed response without mutating unrelated data", () => {
    const accounts = Array.from({ length: 500 }, (_, i) => `{"address":"A${i}","amount":${i}}`).join(",");
    const raw = `{"total":500,"accounts":[${accounts}]}`;
    const parsed = parseJsonPreservingIntegerFields(raw, ["amount"]) as {
      total: number;
      accounts: { address: string; amount: string }[];
    };
    expect(parsed.total).toBe(500);
    expect(parsed.accounts).toHaveLength(500);
    expect(parsed.accounts[499].amount).toBe("499");
    expect(parsed.accounts[499].address).toBe("A499");
  });

  it("does not mutate valid unrelated JSON when the allowlist matches nothing present", () => {
    const raw = `{"a":1,"b":"two","c":[1,2,3],"d":{"e":true,"f":null}}`;
    const parsed = parseJsonPreservingIntegerFields(raw, ["not_present"]);
    expect(parsed).toEqual(JSON.parse(raw));
  });

  it("preserves the exact integer digit string (no float rounding) at the safe-integer boundary", () => {
    const atBoundaryPlusOne = "9007199254740993"; // MAX_SAFE_INTEGER (2^53-1) + 2, unsafe if parsed as Number
    const raw = `{"amount":${atBoundaryPlusOne}}`;
    const parsed = parseJsonPreservingIntegerFields(raw, FIELDS) as { amount: string };
    expect(parsed.amount).toBe(atBoundaryPlusOne);
  });
});

describe("JsonRpcEnvelopeSchema", () => {
  it("accepts a valid success envelope", () => {
    expect(JsonRpcEnvelopeSchema.safeParse({ jsonrpc: "2.0", id: "x", result: { ok: true } }).success).toBe(true);
  });

  it("accepts a valid error envelope", () => {
    const result = JsonRpcEnvelopeSchema.safeParse({
      jsonrpc: "2.0",
      id: "x",
      error: { code: -32602, message: "Invalid params" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a malformed envelope", () => {
    expect(JsonRpcEnvelopeSchema.safeParse({ notJsonRpc: true }).success).toBe(false);
  });
});

describe("TokenSupplyResultSchema", () => {
  it("validates a well-formed getTokenSupply result", () => {
    const result = TokenSupplyResultSchema.safeParse({
      context: { slot: 12345 },
      value: { amount: "1000000000", decimals: 6, uiAmount: 1000, uiAmountString: "1000" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a result with a numeric (non-string) amount, never reinterpreting it", () => {
    const result = TokenSupplyResultSchema.safeParse({
      context: { slot: 1 },
      value: { amount: 1000000000, decimals: 6, uiAmount: 1000 },
    });
    expect(result.success).toBe(false);
  });
});

describe("DasTokenAccountsResultSchema", () => {
  it("validates a well-formed page", () => {
    const result = DasTokenAccountsResultSchema.safeParse({
      total: 1,
      limit: 1,
      cursor: null,
      last_indexed_slot: 999,
      token_accounts: [{ address: "A", mint: "M", owner: "O", amount: "12345" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a page missing required fields", () => {
    expect(
      DasTokenAccountsResultSchema.safeParse({ total: 1, limit: 1, token_accounts: [{}] }).success
    ).toBe(false);
  });
});
