import { PublicKey } from "@solana/web3.js";
import { MintLayout, MINT_SIZE } from "@solana/spl-token";
import { describe, expect, it } from "vitest";
import { analyzeMintAuthority } from "../mintAuthorityAnalyzer";
import { makeFakeClient } from "../fixtures/fakeClient";
import { available, unavailable } from "../fixtures/syntheticBuilders";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "../wellKnownAccounts";

const MINT = "So11111111111111111111111111111111111111112";
const AUTHORITY = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const FREEZE = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

function encodeMintBuffer(opts: {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  supply: bigint;
  decimals: number;
  extensionsTlv?: Buffer;
}): Buffer {
  const base = Buffer.alloc(MINT_SIZE);
  MintLayout.encode(
    {
      mintAuthorityOption: opts.mintAuthority ? 1 : 0,
      mintAuthority: new PublicKey(opts.mintAuthority ?? "11111111111111111111111111111111"),
      supply: opts.supply,
      decimals: opts.decimals,
      isInitialized: true,
      freezeAuthorityOption: opts.freezeAuthority ? 1 : 0,
      freezeAuthority: new PublicKey(opts.freezeAuthority ?? "11111111111111111111111111111111"),
    },
    base
  );
  if (!opts.extensionsTlv) return base;
  // Token-2022 with extensions: padded to ACCOUNT_SIZE (165), then a 1-byte
  // AccountType.Mint (=1) discriminator, then raw TLV entries.
  const ACCOUNT_SIZE = 165;
  const padded = Buffer.concat([base, Buffer.alloc(ACCOUNT_SIZE - base.length)]);
  const withAccountType = Buffer.concat([padded, Buffer.from([1])]);
  return Buffer.concat([withAccountType, opts.extensionsTlv]);
}

function tlvEntry(type: number, length: number): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt16LE(type, 0);
  header.writeUInt16LE(length, 2);
  return Buffer.concat([header, Buffer.alloc(length)]);
}

function accountInfoResult(owner: string, dataBuffer: Buffer, contextSlot = 100) {
  const data: [string, string] = [dataBuffer.toString("base64"), "base64"];
  return available(
    { context: { slot: contextSlot }, value: { data, executable: false, lamports: 1461600, owner, rentEpoch: 0 } },
    { contextSlot }
  );
}

describe("analyzeMintAuthority", () => {
  it("decodes an SPL Token mint with active mint and freeze authorities", async () => {
    const buf = encodeMintBuffer({ mintAuthority: AUTHORITY, freezeAuthority: FREEZE, supply: 1_000_000_000_000n, decimals: 6 });
    const client = makeFakeClient({ getAccountInfo: async () => accountInfoResult(TOKEN_PROGRAM_ID, buf) });
    const result = await analyzeMintAuthority(client, MINT);
    expect(result.tokenProgram).toBe("SPL_TOKEN");
    expect(result.mintAuthority).toBe(AUTHORITY);
    expect(result.freezeAuthority).toBe(FREEZE);
    expect(result.decimals).toBe(6);
    expect(result.rawSupply).toBe("1000000000000");
    expect(result.warnings).toEqual([]);
  });

  it("decodes renounced (null) authorities as provably absent, not undefined", async () => {
    const buf = encodeMintBuffer({ mintAuthority: null, freezeAuthority: null, supply: 500n, decimals: 2 });
    const client = makeFakeClient({ getAccountInfo: async () => accountInfoResult(TOKEN_PROGRAM_ID, buf) });
    const result = await analyzeMintAuthority(client, MINT);
    expect(result.mintAuthority).toBeNull();
    expect(result.freezeAuthority).toBeNull();
  });

  it("decodes a Token-2022 mint and reports detected extensions", async () => {
    const tlv = tlvEntry(3, 32); // MintCloseAuthority
    const buf = encodeMintBuffer({ mintAuthority: AUTHORITY, freezeAuthority: null, supply: 42n, decimals: 9, extensionsTlv: tlv });
    const client = makeFakeClient({ getAccountInfo: async () => accountInfoResult(TOKEN_2022_PROGRAM_ID, buf) });
    const result = await analyzeMintAuthority(client, MINT);
    expect(result.tokenProgram).toBe("TOKEN_2022");
    expect(result.supportedExtensions).toContain("MintCloseAuthority");
  });

  it("returns UNAVAILABLE (never fabricated authorities) when the account fetch fails", async () => {
    const client = makeFakeClient({ getAccountInfo: async () => unavailable("TIMEOUT") });
    const result = await analyzeMintAuthority(client, MINT);
    expect(result.tokenProgram).toBe("UNKNOWN");
    expect(result.mintAuthority).toBeUndefined();
    expect(result.freezeAuthority).toBeUndefined();
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("returns UNKNOWN token program when the account owner is neither SPL Token nor Token-2022", async () => {
    const buf = encodeMintBuffer({ mintAuthority: AUTHORITY, freezeAuthority: null, supply: 1n, decimals: 0 });
    const client = makeFakeClient({ getAccountInfo: async () => accountInfoResult("11111111111111111111111111111111", buf) });
    const result = await analyzeMintAuthority(client, MINT);
    expect(result.tokenProgram).toBe("UNKNOWN");
    expect(result.mintAuthority).toBeUndefined();
  });

  it("handles a non-existent mint account without crashing", async () => {
    const client = makeFakeClient({
      getAccountInfo: async () => available({ context: { slot: 1 }, value: null }, { contextSlot: 1 }),
    });
    const result = await analyzeMintAuthority(client, MINT);
    expect(result.tokenProgram).toBe("UNKNOWN");
    expect(result.warnings[0]).toMatch(/does not exist/);
  });
});
