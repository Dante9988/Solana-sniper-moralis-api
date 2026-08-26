/**
 * Phase 5C/5D — authoritative, verifiable well-known Solana program/account IDs.
 *
 * A syntactically valid public key is not proof of classification
 * (phase5d.txt §5) — every entry below carries structured provenance: how it
 * was verified, why it is a program/pool/vault/burn/other account, and why
 * excluding it from adjusted holder concentration is permitted. These are the
 * ONLY accounts this module ever classifies without transaction-level
 * evidence — never an unverified exchange/locker address list.
 */

export type WellKnownAccountType = "program" | "burn" | "other";

export interface WellKnownAccountEntry {
  address: string;
  name: string;
  classification: string;
  accountType: WellKnownAccountType;
  /** How this address was verified — the source of truth, not just "looks right". */
  provenance: string;
  /** Why excluding this account from adjusted holder concentration is permitted. */
  exclusionRationale: string;
}

export const WELL_KNOWN_ACCOUNTS: readonly WellKnownAccountEntry[] = [
  {
    address: "11111111111111111111111111111111",
    name: "SYSTEM_PROGRAM_ID",
    classification: "SYSTEM_PROGRAM",
    accountType: "program",
    provenance:
      "Solana's native System Program — a fixed, protocol-level address (32 zero bytes), verified against @solana/web3.js's own SystemProgram.programId constant.",
    exclusionRationale: "A native protocol program can never be a token holder in the economic sense; any balance under it is not user-controlled supply.",
  },
  {
    address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    name: "TOKEN_PROGRAM_ID",
    classification: "TOKEN_PROGRAM",
    accountType: "program",
    provenance: "The SPL Token program — verified against @solana/spl-token's TOKEN_PROGRAM_ID constant (node_modules/@solana/spl-token/lib/cjs/constants.js).",
    exclusionRationale: "The token program itself never holds a user balance of the tokens it manages.",
  },
  {
    address: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    name: "TOKEN_2022_PROGRAM_ID",
    classification: "TOKEN_PROGRAM",
    accountType: "program",
    provenance: "The SPL Token-2022 program — verified against @solana/spl-token's TOKEN_2022_PROGRAM_ID constant.",
    exclusionRationale: "The token program itself never holds a user balance of the tokens it manages.",
  },
  {
    address: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    name: "ASSOCIATED_TOKEN_PROGRAM_ID",
    classification: "SYSTEM_PROGRAM",
    accountType: "program",
    provenance: "The SPL Associated Token Account program — verified against @solana/spl-token's ASSOCIATED_TOKEN_PROGRAM_ID constant.",
    exclusionRationale: "A program address, never itself a token holder.",
  },
  {
    address: "ComputeBudget111111111111111111111111111111",
    name: "COMPUTE_BUDGET_PROGRAM_ID",
    classification: "SYSTEM_PROGRAM",
    accountType: "program",
    provenance: "Solana's native Compute Budget program — a fixed protocol-level address, referenced only for instruction-program-ID identification, never expected to hold tokens.",
    exclusionRationale: "A native protocol program, never a token holder.",
  },
  {
    address: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
    name: "PUMP_FUN_PROGRAM_ID",
    classification: "LAUNCH_PROGRAM",
    accountType: "program",
    provenance: "Pump.fun's bonding-curve program — verified against this repository's existing src/services/pumpSwapService.ts (in production use since Phase 2 for mint-log parsing) and the Phase 5 capability audit.",
    exclusionRationale: "A program address; token accounts it directly owns are bonding-curve/vault state, not a discretionary user holding (see BONDING_CURVE PDA derivation in accountClassifier.ts).",
  },
  {
    address: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
    name: "PUMPSWAP_PROGRAM_ID",
    classification: "LAUNCH_PROGRAM",
    accountType: "program",
    provenance: "The real PumpSwap AMM program — verified against src/services/pumpSwapService.ts and the Phase 5 capability audit, which specifically identified this address as the correct PumpSwap program (distinct from the Pump.fun bonding-curve program the active listener currently mislabels).",
    exclusionRationale: "A program address; token accounts it owns are AMM pool vaults, not discretionary user holdings.",
  },
  {
    address: "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg",
    name: "PUMP_FUN_RAYDIUM_MIGRATION",
    classification: "LAUNCH_PROGRAM",
    accountType: "program",
    provenance: "The Pump.fun-to-Raydium migration account — verified against src/services/pumpSwapService.ts.",
    exclusionRationale: "A program/migration-controlled address, not a discretionary user holding.",
  },
  {
    address: "1nc1nerator11111111111111111111111111111111",
    name: "SOLANA_INCINERATOR_ADDRESS",
    classification: "VERIFIED_BURN_DESTINATION",
    accountType: "burn",
    provenance:
      "The conventional Solana community 'incinerator' burn address — nobody holds its private key. Verified as a valid 32-byte base58 public key and cross-checked against public documentation (sol-incinerator.com) during Phase 5D. Note: a transfer here does not itself reduce SPL total supply (no burn instruction executes) — it only makes the balance permanently unreachable.",
    exclusionRationale: "Tokens sent here are provably unreachable by any private key; while not a supply-reducing burn, they can never re-enter circulation, so counting them as a discretionary holding would misrepresent risk.",
  },
] as const;

function findAddress(name: string): string {
  const entry = WELL_KNOWN_ACCOUNTS.find((e) => e.name === name);
  if (!entry) throw new Error(`wellKnownAccounts: missing required entry ${name}`);
  return entry.address;
}

export const SYSTEM_PROGRAM_ID = findAddress("SYSTEM_PROGRAM_ID");
export const TOKEN_PROGRAM_ID = findAddress("TOKEN_PROGRAM_ID");
export const TOKEN_2022_PROGRAM_ID = findAddress("TOKEN_2022_PROGRAM_ID");
export const ASSOCIATED_TOKEN_PROGRAM_ID = findAddress("ASSOCIATED_TOKEN_PROGRAM_ID");
export const COMPUTE_BUDGET_PROGRAM_ID = findAddress("COMPUTE_BUDGET_PROGRAM_ID");
export const PUMP_FUN_PROGRAM_ID = findAddress("PUMP_FUN_PROGRAM_ID");
export const PUMPSWAP_PROGRAM_ID = findAddress("PUMPSWAP_PROGRAM_ID");
export const PUMP_FUN_RAYDIUM_MIGRATION = findAddress("PUMP_FUN_RAYDIUM_MIGRATION");
export const SOLANA_INCINERATOR_ADDRESS = findAddress("SOLANA_INCINERATOR_ADDRESS");

export const SYSTEM_AND_PROGRAM_ACCOUNTS: ReadonlySet<string> = new Set(
  WELL_KNOWN_ACCOUNTS.filter((e) => e.accountType === "program" && e.classification !== "LAUNCH_PROGRAM").map((e) => e.address)
);

export const KNOWN_LAUNCH_PROGRAM_IDS: ReadonlySet<string> = new Set(
  WELL_KNOWN_ACCOUNTS.filter((e) => e.classification === "LAUNCH_PROGRAM").map((e) => e.address)
);

export const VERIFIED_BURN_ACCOUNTS: ReadonlySet<string> = new Set(
  WELL_KNOWN_ACCOUNTS.filter((e) => e.accountType === "burn").map((e) => e.address)
);
