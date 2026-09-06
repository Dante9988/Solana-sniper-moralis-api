import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { ponsAdapter, RawEvmLog, RawPonsTokenDiscovery, RawPonsSwap } from "../ponsAdapter";

const FIXTURES_DIR = path.join(__dirname, "fixtures");

function loadRawLog(name: string): RawEvmLog & { enrichment?: { supply: string; isToken0: boolean; poolFee: number } } {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8"));
}

describe("ponsAdapter.decodeTokenDiscovered", () => {
  it("decodes a real on-chain TokenLaunched log (block 9019252, verified against github.com/ponsdotdev/ponsfamily's ABI)", () => {
    const fixture = loadRawLog("token_launched_9019252.json");
    const raw: RawPonsTokenDiscovery = {
      log: { ...fixture, blockNumber: BigInt(fixture.blockNumber as unknown as string) },
      enrichment: {
        supply: BigInt(fixture.enrichment!.supply),
        isToken0: fixture.enrichment!.isToken0,
        poolFee: fixture.enrichment!.poolFee,
      },
    };

    const result = ponsAdapter.decodeTokenDiscovered(raw);

    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      kind: "tokenDiscovered",
      chain: "robinhood",
      venue: "pons",
      tokenAddress: "0x055650555Be80649397084Cd3f8a09b4350e8612",
      deployer: "0xb6E60E418E198AaD0360BE847863e0477420239a",
      poolAddress: "0x8f4F723f10fc7bAD28742d25c91158C728557C4c",
      quoteAddress: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      supply: "1000000000000000000000000000",
      initialBuyAmount: "10000000000000000",
    });
    expect(result?.provenance).toEqual({
      sourceHeight: "9019252",
      sourceHash: "0xe1a0051a3071790e0bd5d93ae261e53310111e42e30adb13673be30b0e6f460c",
      sourceTxHash: "0x92476c6f12444023711b221057dcffab166f673027479008f959ca37f5f21eb7",
      sourceIndex: 15,
    });
  });

  it("fails closed (returns null) on a log that isn't TokenLaunched", () => {
    const fixture = loadRawLog("swap_9019252.json");
    const raw: RawPonsTokenDiscovery = {
      log: { ...fixture, blockNumber: BigInt(fixture.blockNumber as unknown as string) },
      enrichment: { supply: 0n, isToken0: true, poolFee: 0 },
    };

    expect(ponsAdapter.decodeTokenDiscovered(raw)).toBeNull();
  });
});

describe("ponsAdapter.decodeTrade", () => {
  it("decodes a real on-chain Swap log as the dev's initial buy (matches TokenLaunched's initialBuyAmount)", () => {
    const fixture = loadRawLog("swap_9019252.json");
    const raw: RawPonsSwap = {
      log: { ...fixture, blockNumber: BigInt(fixture.blockNumber as unknown as string) },
      tokenAddress: "0x055650555Be80649397084Cd3f8a09b4350e8612",
      quoteAddress: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      isToken0: true,
    };

    const result = ponsAdapter.decodeTrade(raw);

    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      kind: "tradeExecuted",
      chain: "robinhood",
      venue: "pons",
      tokenAddress: "0x055650555Be80649397084Cd3f8a09b4350e8612",
      poolAddress: "0x8f4f723f10fc7bad28742d25c91158c728557c4c",
      side: "buy",
      tokenAmount: "7249784874772468972176245",
      quoteAmount: "10000000000000000",
      trader: "0xb6E60E418E198AaD0360BE847863e0477420239a",
    });
    // priceQuote is quoteAmount/tokenAmount at 18-decimal scale, a tiny number here.
    expect(result?.priceQuote).not.toBe("0");
    expect(result?.priceUsd).toBeNull();
  });

  it("fails closed (returns null) on a log that isn't Swap", () => {
    const fixture = loadRawLog("token_launched_9019252.json");
    const raw: RawPonsSwap = {
      log: { ...fixture, blockNumber: BigInt(fixture.blockNumber as unknown as string) },
      tokenAddress: "0x055650555Be80649397084Cd3f8a09b4350e8612",
      quoteAddress: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      isToken0: true,
    };

    expect(ponsAdapter.decodeTrade(raw)).toBeNull();
  });
});
