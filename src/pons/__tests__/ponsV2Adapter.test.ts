import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { encodeAbiParameters, encodeEventTopics, getAbiItem } from "viem";
import { ponsV2Adapter, RawPonsV2TokenDiscovery, RawPonsV2Graduation, RawPonsV2PoolInitialized, RawPonsV2Swap } from "../ponsV2Adapter";
import { UNISWAP_V4_POOL_MANAGER_ABI } from "../abiV2";
import type { RawEvmLog } from "../ponsAdapter";

const FIXTURES_DIR = path.join(__dirname, "fixtures");

function loadRawLog(name: string): RawEvmLog & { enrichment?: { supply: string } } {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8"));
}

describe("ponsV2Adapter.decodeTokenDiscovered", () => {
  it("decodes a real on-chain V2 TokenLaunched log (block 52687031, PonsV2LaunchFactory)", () => {
    const fixture = loadRawLog("token_launched_v2_52687031.json");
    const raw: RawPonsV2TokenDiscovery = {
      log: { ...fixture, blockNumber: BigInt(fixture.blockNumber as unknown as string) },
      enrichment: { supply: BigInt(fixture.enrichment!.supply) },
    };

    const result = ponsV2Adapter.decodeTokenDiscovered(raw);

    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      kind: "tokenDiscovered",
      chain: "robinhood",
      venue: "pons_v2",
      tokenAddress: "0x07EBB29a38Fbcb41563817e5E19f2ceC619C90D2",
      deployer: "0x232f26fF2C2F4CB6F548eF1Be7e817bdb4C397cd",
      poolAddress: null,
      quoteAddress: "0x0000000000000000000000000000000000000000",
      supply: "1000000000000000000000000000",
      initialBuyAmount: "0",
      curveAddress: "0x62e4aa27046b0CBd28d76D0Ec7C56C5a32CE3aF4",
    });
    expect(result?.provenance).toEqual({
      sourceHeight: "52687031",
      sourceHash: "0xa6578e453fcb26944f47976ca459b2cba1fd8d29066962ebd4617bc3477a5334",
      sourceTxHash: "0x3e9dcd19093da517aa3001975828065c846d785a4ac7858af76d52d4eec90914",
      sourceIndex: 78,
    });
  });

  it("fails closed (returns null) on a log that isn't TokenLaunched", () => {
    const fixture = loadRawLog("pool_graduated_v2_52687031.json");
    const raw: RawPonsV2TokenDiscovery = {
      log: { ...fixture, blockNumber: BigInt(fixture.blockNumber as unknown as string) },
      enrichment: { supply: 0n },
    };

    expect(ponsV2Adapter.decodeTokenDiscovered(raw)).toBeNull();
  });
});

describe("ponsV2Adapter.decodeTokenGraduated", () => {
  it("decodes a real on-chain PoolGraduated log — the migration to Uniswap V4", () => {
    const fixture = loadRawLog("pool_graduated_v2_52687031.json");
    const raw: RawPonsV2Graduation = {
      log: { ...fixture, blockNumber: BigInt(fixture.blockNumber as unknown as string) },
    };

    const result = ponsV2Adapter.decodeTokenGraduated(raw);

    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      kind: "tokenGraduated",
      chain: "robinhood",
      venue: "pons_v2",
      tokenAddress: "0x07EBB29a38Fbcb41563817e5E19f2ceC619C90D2",
      positionId: "1534854",
      tokenAmount: "204081632653061224517562126",
      pairTokenAmount: "4200000000000000002",
    });
    expect(result?.provenance).toEqual({
      sourceHeight: "52687031",
      sourceHash: "0xa6578e453fcb26944f47976ca459b2cba1fd8d29066962ebd4617bc3477a5334",
      sourceTxHash: "0x3e9dcd19093da517aa3001975828065c846d785a4ac7858af76d52d4eec90914",
      sourceIndex: 111,
    });
  });

  it("fails closed (returns null) on a log that isn't PoolGraduated", () => {
    const fixture = loadRawLog("token_launched_v2_52687031.json");
    const raw: RawPonsV2Graduation = {
      log: { ...fixture, blockNumber: BigInt(fixture.blockNumber as unknown as string) },
    };

    expect(ponsV2Adapter.decodeTokenGraduated(raw)).toBeNull();
  });
});

describe("ponsV2Adapter.decodeLaunchMetadata", () => {
  it("decodes the real launchToken() calldata from the internal call inside tx 0x3e9dcd19...eec90914 (pulled via Blockscout raw-trace, verified against the factory's real ABI)", () => {
    const input = fs.readFileSync(path.join(FIXTURES_DIR, "launch_token_calldata_v2_52687031.txt"), "utf8").trim();

    const result = ponsV2Adapter.decodeLaunchMetadata(input);

    expect(result).toEqual({
      name: "Bundle Cat",
      symbol: "BUN",
      logoUrl: "https://ipfs.io/ipfs/bafkreieze2bpf4nioez3zpnwxeccbtmz62leeiw5dgotksrl7j7umja5xi",
      description: "Protecting the trenches, one bundle at a time. Launched on mosh.trade.",
      socials: {
        twitter: "https://x.com/uv",
        telegram: "https://t.me/moshtrade",
        discord: "",
        website: "https://mosh.trade",
        farcaster: "",
      },
    });
  });

  it("fails closed (returns null) on calldata that isn't a launchToken/launchTokenFor call", () => {
    expect(ponsV2Adapter.decodeLaunchMetadata("0xdeadbeef")).toBeNull();
    expect(ponsV2Adapter.decodeLaunchMetadata("0x")).toBeNull();
  });
});

describe("ponsV2Adapter.decodePoolInitialized", () => {
  it("reads the real PoolId off the Initialize log that accompanied this token's graduation (same tx, verified live against the real PoolManager contract)", () => {
    const fixture = loadRawLog("pool_initialized_v2_52687031.json");
    const raw: RawPonsV2PoolInitialized = {
      log: { ...fixture, blockNumber: BigInt(fixture.blockNumber as unknown as string) },
    };

    // Real log: currency0 = native ETH (0x0), currency1 = our token — so
    // the token is currency1, isToken0 must be false.
    const result = ponsV2Adapter.decodePoolInitialized(raw, "0x07EBB29a38Fbcb41563817e5E19f2ceC619C90D2");

    expect(result).toEqual({
      poolId: "0x06e308b77bdafd691d179645296ce8c40e33c6af4a879a913efc7eedc402581c",
      isToken0: false,
    });
  });

  it("returns null when the Initialize log isn't for the given token", () => {
    const fixture = loadRawLog("pool_initialized_v2_52687031.json");
    const raw: RawPonsV2PoolInitialized = {
      log: { ...fixture, blockNumber: BigInt(fixture.blockNumber as unknown as string) },
    };

    expect(ponsV2Adapter.decodePoolInitialized(raw, "0x000000000000000000000000000000000000dEaD")).toBeNull();
  });

  it("fails closed (returns null) on a log that isn't Initialize", () => {
    const fixture = loadRawLog("pool_graduated_v2_52687031.json");
    const raw: RawPonsV2PoolInitialized = {
      log: { ...fixture, blockNumber: BigInt(fixture.blockNumber as unknown as string) },
    };

    expect(ponsV2Adapter.decodePoolInitialized(raw, "0x07EBB29a38Fbcb41563817e5E19f2ceC619C90D2")).toBeNull();
  });
});

describe("ponsV2Adapter.decodeTrade (Uniswap V4 PoolManager Swap)", () => {
  const TOKEN = "0x07EBB29a38Fbcb41563817e5E19f2ceC619C90D2" as const;
  const QUOTE = "0x0000000000000000000000000000000000000000" as const;
  const POOL_ID = "0x06e308b77bdafd691d179645296ce8c40e33c6af4a879a913efc7eedc402581c" as const;

  /**
   * The real PoolManager ABI (abiV2.ts, Blockscout-verified) is what's
   * under test — only the specific numeric values here are synthetic,
   * built the same way testSupport.ts's existing makeSwapLog/
   * makeTokenLaunchedLog helpers already construct V1 test logs (real ABI,
   * viem's own encoder, not hand-typed hex).
   */
  function makeV4SwapLog(params: { amount0: bigint; amount1: bigint; sender?: `0x${string}` }): RawEvmLog {
    const sender = params.sender ?? (`0x${"d0".repeat(20)}` as `0x${string}`);
    const eventAbi = getAbiItem({ abi: UNISWAP_V4_POOL_MANAGER_ABI, name: "Swap" });
    const topics = encodeEventTopics({ abi: UNISWAP_V4_POOL_MANAGER_ABI, eventName: "Swap", args: { id: POOL_ID, sender } });
    const nonIndexed = eventAbi.inputs.filter((i) => !i.indexed);
    const data = encodeAbiParameters(nonIndexed, [params.amount0, params.amount1, 0n, 0n, 0, 0]);
    return {
      address: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
      topics: topics as readonly `0x${string}`[],
      data,
      blockNumber: 57_400_000n,
      blockHash: "0xhash-57400000",
      transactionHash: "0xtx-v4-swap",
      logIndex: 0,
    };
  }

  it("decodes a buy (token flowed OUT of the pool to the trader — negative signed amount on the token's side)", () => {
    const log = makeV4SwapLog({ amount0: -7_000_000_000_000_000_000n, amount1: 10_000_000_000_000_000n });
    const raw: RawPonsV2Swap = { log, tokenAddress: TOKEN, quoteAddress: QUOTE, isToken0: true };

    const result = ponsV2Adapter.decodeTrade(raw);

    expect(result).toMatchObject({
      kind: "tradeExecuted",
      chain: "robinhood",
      venue: "pons_v2",
      tokenAddress: TOKEN,
      poolAddress: null,
      side: "buy",
      tokenAmount: "7000000000000000000",
      quoteAmount: "10000000000000000",
      quoteAddress: QUOTE,
    });
    expect(result?.priceUsd).toBeNull();
  });

  it("decodes a sell (token flowed IN to the pool — positive signed amount on the token's side)", () => {
    const log = makeV4SwapLog({ amount0: 5_000_000_000_000_000_000n, amount1: -6_000_000_000_000_000n });
    const raw: RawPonsV2Swap = { log, tokenAddress: TOKEN, quoteAddress: QUOTE, isToken0: true };

    const result = ponsV2Adapter.decodeTrade(raw);

    expect(result).toMatchObject({ side: "sell", tokenAmount: "5000000000000000000", quoteAmount: "6000000000000000" });
  });

  it("fails closed (returns null) on a log that isn't Swap", () => {
    const fixture = loadRawLog("pool_initialized_v2_52687031.json");
    const raw: RawPonsV2Swap = {
      log: { ...fixture, blockNumber: BigInt(fixture.blockNumber as unknown as string) },
      tokenAddress: TOKEN,
      quoteAddress: QUOTE,
      isToken0: false,
    };

    expect(ponsV2Adapter.decodeTrade(raw)).toBeNull();
  });
});
