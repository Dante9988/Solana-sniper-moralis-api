import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, parseAbiParameters, type Hex } from "viem";

import { DiscoveryV2Listener } from "../discoveryV2Listener";
import { ERC20_ABI } from "../abi";
import { MULTICALL3, MULTICALL3_ABI } from "../quote/protocol";
import { TEST_CONFIG } from "./testSupport";

/**
 * Phase 7D.5 — batched V2 enrichment must return exactly what the per-token reads returned.
 *
 * Enrichment was the dominant cost of a V2 discovery tick: ~254 launches × 3 `eth_call`s.
 * Batching them into one Multicall3 `aggregate3` is only safe if it is indistinguishable
 * from the old path for every token, including the ones that fail.
 */

const TOKENS = [
  "0x1111111111111111111111111111111111111111",
  "0x2222222222222222222222222222222222222222",
  "0x3333333333333333333333333333333333333333",
];

/** name/symbol values chosen to be awkward: unicode, empty, and very long. */
const META: Record<string, { supply: bigint; name: string; symbol: string }> = {
  [TOKENS[0]]: { supply: 10n ** 27n, name: "Ordinary Token", symbol: "ORD" },
  [TOKENS[1]]: { supply: 1n, name: "牛市 🐂 Ünicode", symbol: "" },
  [TOKENS[2]]: { supply: 2n ** 255n, name: "L".repeat(400), symbol: "LONG" },
};

function erc20Result(fn: "totalSupply" | "name" | "symbol", token: string): Hex {
  const m = META[token];
  return encodeFunctionResult({ abi: ERC20_ABI, functionName: fn, result: fn === "totalSupply" ? m.supply : fn === "name" ? m.name : m.symbol } as never);
}

/** A client that answers both the per-token path and the aggregate3 path from one source of truth. */
function makeClient(opts: { reverting?: Set<string>; failCall?: "unavailable" | null } = {}) {
  const reverting = opts.reverting ?? new Set<string>();
  const counts = { readContract: 0, call: 0 };

  const readContract = vi.fn(async ({ address, functionName }: { address: string; functionName: string }) => {
    counts.readContract += 1;
    if (reverting.has(address.toLowerCase())) {
      return { status: "UNAVAILABLE", source: "t", fetchedAt: new Date(), code: "RPC_ERROR", reason: "execution reverted", attempts: 1 };
    }
    const m = META[address];
    const value = functionName === "totalSupply" ? m.supply : functionName === "name" ? m.name : m.symbol;
    return { status: "AVAILABLE", data: value, source: "t", fetchedAt: new Date(), attempts: 1 };
  });

  const call = vi.fn(async ({ to, data }: { to: string; data: Hex; blockNumber: bigint }) => {
    counts.call += 1;
    if (opts.failCall === "unavailable") {
      return { status: "UNAVAILABLE", source: "t", fetchedAt: new Date(), code: "RPC_ERROR", reason: "provider down", attempts: 1 };
    }
    expect(to.toLowerCase()).toBe(MULTICALL3.toLowerCase());
    const { args } = decodeFunctionData({ abi: MULTICALL3_ABI, data });
    const calls = args![0] as readonly { target: Hex; allowFailure: boolean; callData: Hex }[];
    const results = calls.map((c) => {
      const target = c.target.toLowerCase();
      if (reverting.has(target)) return { success: false, returnData: "0x" as Hex };
      const { functionName } = decodeFunctionData({ abi: ERC20_ABI, data: c.callData });
      return { success: true, returnData: erc20Result(functionName as never, c.target) };
    });
    const encoded = encodeAbiParameters(parseAbiParameters("(bool success, bytes returnData)[]"), [results as never]);
    return { status: "AVAILABLE", data: { kind: "SUCCESS", data: encoded }, source: "t", fetchedAt: new Date(), attempts: 1 };
  });

  return { readContract, call, counts };
}

function listener(client: object) {
  return new DiscoveryV2Listener({
    chainClient: client as never,
    db: {} as never,
    config: TEST_CONFIG,
    v2Config: { factoryAddress: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e" } as never,
  });
}

// `fetchEnrichmentBatch` and `fetchEnrichment` are private; exercise them as the tick does.
const batch = (l: DiscoveryV2Listener, addrs: string[], block: bigint) =>
  (l as unknown as { fetchEnrichmentBatch(a: readonly string[], b: bigint): Promise<Map<string, unknown> | null> }).fetchEnrichmentBatch(addrs, block);
const single = (l: DiscoveryV2Listener, addr: string) =>
  (l as unknown as { fetchEnrichment(a: string): Promise<unknown> }).fetchEnrichment(addr);

describe("batched V2 enrichment", () => {
  it("returns exactly what the per-token path returns, at the same block", async () => {
    const batched = await batch(listener(makeClient()), TOKENS, 12_345n);
    expect(batched).not.toBeNull();

    const perToken = listener(makeClient());
    for (const token of TOKENS) {
      expect(batched!.get(token), `token ${token}`).toEqual(await single(perToken, token));
    }
  });

  it("collapses three reads per token into one round trip", async () => {
    const batchedClient = makeClient();
    await batch(listener(batchedClient), TOKENS, 1n);

    const perTokenClient = makeClient();
    const l = listener(perTokenClient);
    for (const token of TOKENS) await single(l, token);

    expect(batchedClient.counts.call).toBe(1);
    expect(perTokenClient.counts.readContract).toBe(TOKENS.length * 3);
  });

  it("fails only the reverting token — one bad token never discards the batch", async () => {
    const reverting = new Set([TOKENS[1]]);
    const result = await batch(listener(makeClient({ reverting })), TOKENS, 7n);

    expect(result!.get(TOKENS[1])).toMatchObject({ status: "FAILED" });
    // A FAILED outcome is what keeps the row PENDING and retryable.
    expect(result!.get(TOKENS[0])).toMatchObject({ status: "COMPLETE", symbol: "ORD" });
    expect(result!.get(TOKENS[2])).toMatchObject({ status: "COMPLETE", symbol: "LONG" });
  });

  it("preserves unusual metadata verbatim — unicode, empty symbol, 400-char name, max supply", async () => {
    const result = await batch(listener(makeClient()), TOKENS, 1n);
    expect(result!.get(TOKENS[1])).toMatchObject({ name: "牛市 🐂 Ünicode", symbol: "", supply: 1n });
    expect(result!.get(TOKENS[2])).toMatchObject({ name: "L".repeat(400), supply: 2n ** 255n });
  });

  it("fails one token when it has no code at that block, instead of taking down the batch", async () => {
    // eth_call to an address with no code returns 0x with success:true. Reading a token at
    // a block before it was deployed does exactly this — verified live on 2026-09-19.
    const client = makeClient();
    client.call.mockImplementationOnce(async ({ data }: { to: string; data: Hex; blockNumber: bigint }) => {
      const { args } = decodeFunctionData({ abi: MULTICALL3_ABI, data });
      const calls = args![0] as readonly { target: Hex; callData: Hex }[];
      const results = calls.map((c) =>
        c.target.toLowerCase() === TOKENS[0]
          ? { success: true, returnData: "0x" as Hex }
          : { success: true, returnData: erc20Result(decodeFunctionData({ abi: ERC20_ABI, data: c.callData }).functionName as never, c.target) }
      );
      return {
        status: "AVAILABLE",
        data: { kind: "SUCCESS", data: encodeAbiParameters(parseAbiParameters("(bool success, bytes returnData)[]"), [results as never]) },
        source: "t",
        fetchedAt: new Date(),
        attempts: 1,
      };
    });

    const result = await batch(listener(client), TOKENS, 1n);

    expect(result!.get(TOKENS[0])).toMatchObject({ status: "FAILED" });
    expect(result!.get(TOKENS[1])).toMatchObject({ status: "COMPLETE" });
    expect(result!.get(TOKENS[2])).toMatchObject({ status: "COMPLETE" });
  });

  it("returns null when the provider cannot serve the batch, so the caller falls back", async () => {
    const result = await batch(listener(makeClient({ failCall: "unavailable" })), TOKENS, 1n);
    expect(result).toBeNull();
  });

  it("returns null when the client has no eth_call at all", async () => {
    const { readContract } = makeClient();
    const result = await batch(listener({ readContract }), TOKENS, 1n);
    expect(result).toBeNull();
  });

  it("asks for every read at the one block it was given", async () => {
    const client = makeClient();
    await batch(listener(client), TOKENS, 9_999n);
    expect(client.call.mock.calls[0][0].blockNumber).toBe(9_999n);
  });
});
