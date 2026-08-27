import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import * as wellKnown from "../wellKnownAccounts";

describe("wellKnownAccounts — constant integrity", () => {
  const addressConstants: Record<string, string> = {
    SYSTEM_PROGRAM_ID: wellKnown.SYSTEM_PROGRAM_ID,
    TOKEN_PROGRAM_ID: wellKnown.TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID: wellKnown.TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID: wellKnown.ASSOCIATED_TOKEN_PROGRAM_ID,
    COMPUTE_BUDGET_PROGRAM_ID: wellKnown.COMPUTE_BUDGET_PROGRAM_ID,
    PUMP_FUN_PROGRAM_ID: wellKnown.PUMP_FUN_PROGRAM_ID,
    PUMPSWAP_PROGRAM_ID: wellKnown.PUMPSWAP_PROGRAM_ID,
    PUMP_FUN_RAYDIUM_MIGRATION: wellKnown.PUMP_FUN_RAYDIUM_MIGRATION,
    SOLANA_INCINERATOR_ADDRESS: wellKnown.SOLANA_INCINERATOR_ADDRESS,
  };

  it.each(Object.entries(addressConstants))("%s is a valid, round-tripping base58 pubkey", (_name, value) => {
    const pk = new PublicKey(value);
    expect(pk.toBase58()).toBe(value);
  });

  it("matches the exact program IDs verified in src/services/pumpSwapService.ts", () => {
    expect(wellKnown.PUMPSWAP_PROGRAM_ID).toBe("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
    expect(wellKnown.PUMP_FUN_PROGRAM_ID).toBe("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
    expect(wellKnown.PUMP_FUN_RAYDIUM_MIGRATION).toBe("39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg");
  });

  it("SYSTEM_AND_PROGRAM_ACCOUNTS never includes an unverified exchange/locker address", () => {
    // Structural guard: this set may only ever grow from the explicit
    // constants above, never from a separately-maintained address list.
    for (const addr of wellKnown.SYSTEM_AND_PROGRAM_ACCOUNTS) {
      expect(Object.values(addressConstants)).toContain(addr);
    }
  });
});

describe("wellKnownAccounts — provenance (phase5d.txt §5)", () => {
  it("every entry carries classification, accountType, provenance, and an exclusion rationale", () => {
    for (const entry of wellKnown.WELL_KNOWN_ACCOUNTS) {
      expect(entry.classification).toBeTruthy();
      expect(["program", "burn", "other"]).toContain(entry.accountType);
      expect(entry.provenance.length).toBeGreaterThan(20);
      expect(entry.exclusionRationale.length).toBeGreaterThan(10);
    }
  });

  it("no entry's provenance is a bare 'looks like a valid key' claim", () => {
    for (const entry of wellKnown.WELL_KNOWN_ACCOUNTS) {
      expect(entry.provenance.toLowerCase()).not.toMatch(/^(valid|syntactically valid)/);
    }
  });

  it("KNOWN_LAUNCH_PROGRAM_IDS and SYSTEM_AND_PROGRAM_ACCOUNTS are disjoint (a launch program is never classified as a generic system program)", () => {
    for (const addr of wellKnown.KNOWN_LAUNCH_PROGRAM_IDS) {
      expect(wellKnown.SYSTEM_AND_PROGRAM_ACCOUNTS.has(addr)).toBe(false);
    }
  });

  it("VERIFIED_BURN_ACCOUNTS contains only accountType 'burn' entries", () => {
    const burnAddresses = new Set(wellKnown.WELL_KNOWN_ACCOUNTS.filter((e) => e.accountType === "burn").map((e) => e.address));
    expect(wellKnown.VERIFIED_BURN_ACCOUNTS).toEqual(burnAddresses);
  });
});
