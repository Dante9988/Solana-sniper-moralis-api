import { describe, expect, it } from "vitest";
import { canonicalAssetKey, resolveAsset } from "../assetResolver";
import { resolveTokenDiscoveryAsset } from "../tokenDiscoveryAssetAdapter";
import { TokenDiscoveryEvent } from "../../intelligence/types";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const EVM_ADDRESS = `0xAb${"0".repeat(38)}`;

const event = (mint: string, source: TokenDiscoveryEvent["source"] = "UNKNOWN"): TokenDiscoveryEvent => ({
  id: "event-1", signature: "signature", mint, source,
  discoveredAt: new Date("2026-08-25T00:00:00Z"), receivedAt: new Date("2026-08-25T00:00:01Z"), rawPayload: {},
});

describe("resolveAsset", () => {
  it("resolves and preserves a valid case-sensitive Solana mint", () => {
    const result = resolveAsset({ address: `  ${SOL_MINT}  ` });
    expect(result).toMatchObject({ status: "RESOLVED", asset: { chain: "SOLANA", chainId: "solana-mainnet", address: SOL_MINT, normalizedAddress: SOL_MINT } });
  });

  it("rejects an invalid Solana mint", () => {
    expect(resolveAsset({ address: "not-a-public-key", chain: "SOLANA" }).status).toBe("INVALID_ADDRESS");
  });

  it("resolves explicit Ethereum and BNB identities separately and normalizes EVM case", () => {
    const ethereum = resolveAsset({ address: EVM_ADDRESS, chain: "ETHEREUM" });
    const bnb = resolveAsset({ address: EVM_ADDRESS, chain: "BNB_SMART_CHAIN" });
    expect(ethereum).toMatchObject({ status: "RESOLVED", asset: { chainId: "1", normalizedAddress: EVM_ADDRESS.toLowerCase() } });
    expect(bnb).toMatchObject({ status: "RESOLVED", asset: { chainId: "56", normalizedAddress: EVM_ADDRESS.toLowerCase() } });
    if (ethereum.status === "RESOLVED" && bnb.status === "RESOLVED") {
      expect(canonicalAssetKey(ethereum.asset)).not.toBe(canonicalAssetKey(bnb.asset));
    }
  });

  it("returns AMBIGUOUS_CHAIN for a chainless valid EVM address", () => {
    expect(resolveAsset({ address: EVM_ADDRESS })).toEqual({
      status: "AMBIGUOUS_CHAIN", inputAddress: EVM_ADDRESS, candidateChains: ["ETHEREUM", "BNB_SMART_CHAIN"],
    });
  });

  it.each(["0x1234", "", "   "])("rejects malformed or empty input: %j", (address) => {
    expect(resolveAsset({ address }).status).toBe("INVALID_ADDRESS");
  });

  it("returns UNSUPPORTED_CHAIN rather than guessing", () => {
    expect(resolveAsset({ address: EVM_ADDRESS, chain: "POLYGON" }).status).toBe("UNSUPPORTED_CHAIN");
  });

  it("rejects incompatible address and chain combinations", () => {
    expect(resolveAsset({ address: EVM_ADDRESS, chain: "SOLANA" }).status).toBe("INVALID_ADDRESS");
    expect(resolveAsset({ address: SOL_MINT, chain: "ETHEREUM" }).status).toBe("INVALID_ADDRESS");
  });

  it("keeps symbol and name outside the canonical key", () => {
    const a = resolveAsset({ address: EVM_ADDRESS, chain: "ETHEREUM", symbol: "ONE", name: "First" });
    const b = resolveAsset({ address: EVM_ADDRESS, chain: "ETHEREUM", symbol: "TWO", name: "Second" });
    expect(a.status).toBe("RESOLVED"); expect(b.status).toBe("RESOLVED");
    if (a.status === "RESOLVED" && b.status === "RESOLVED") expect(canonicalAssetKey(a.asset)).toBe(canonicalAssetKey(b.asset));
  });
});

describe("resolveTokenDiscoveryAsset", () => {
  it("resolves current events explicitly as Solana", () => {
    expect(resolveTokenDiscoveryAsset(event(SOL_MINT, "PUMPFUN"))).toMatchObject({ status: "RESOLVED", asset: { chain: "SOLANA" } });
  });

  it("rejects invalid event mints and never uses event source as blockchain identity", () => {
    expect(resolveTokenDiscoveryAsset(event("invalid", "PUMPSWAP")).status).toBe("INVALID_ADDRESS");
    for (const source of ["PUMPFUN", "PUMPSWAP", "MIGRATION", "UNKNOWN"] as const) {
      expect(resolveTokenDiscoveryAsset(event(SOL_MINT, source))).toMatchObject({ status: "RESOLVED", asset: { chain: "SOLANA" } });
    }
  });
});
