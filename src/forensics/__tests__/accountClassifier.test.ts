import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { classifyAccount } from "../accountClassifier";
import { PUMP_FUN_PROGRAM_ID, PUMPSWAP_PROGRAM_ID, SOLANA_INCINERATOR_ADDRESS, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID } from "../wellKnownAccounts";

const MINT = "So11111111111111111111111111111111111111112";
const WALLET = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";

function ctx() {
  let n = 0;
  return { evidenceId: () => `ev-${++n}`, now: () => new Date("2026-01-01T00:00:00.000Z") };
}

describe("classifyAccount", () => {
  it("classifies a known system/token program as SYSTEM_ACCOUNT, excludable", () => {
    const result = classifyAccount({ address: TOKEN_PROGRAM_ID, ...ctx() });
    expect(result.classification).toBe("SYSTEM_ACCOUNT");
    expect(result.excludableFromAdjustedConcentration).toBe(true);
    expect(result.confidence).toBe(1);
  });

  it("classifies the token account owner (not the token account address itself) when owner is a system program", () => {
    const result = classifyAccount({ address: "SomeTokenAccountAddress11111111111111111", tokenAccountOwner: SYSTEM_PROGRAM_ID, ...ctx() });
    expect(result.classification).toBe("SYSTEM_ACCOUNT");
  });

  it("classifies the verified Solana incinerator address as BURN_ACCOUNT", () => {
    const result = classifyAccount({ address: SOLANA_INCINERATOR_ADDRESS, ...ctx() });
    expect(result.classification).toBe("BURN_ACCOUNT");
    expect(result.excludableFromAdjustedConcentration).toBe(true);
  });

  it("derives the Pump.fun bonding-curve PDA for a given mint and classifies it as BONDING_CURVE", () => {
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), new PublicKey(MINT).toBuffer()], new PublicKey(PUMP_FUN_PROGRAM_ID));
    const result = classifyAccount({ address: pda.toBase58(), mint: MINT, ...ctx() });
    expect(result.classification).toBe("BONDING_CURVE");
    expect(result.excludableFromAdjustedConcentration).toBe(true);
  });

  it("classifies a token account owned by the PumpSwap AMM program as POOL_VAULT", () => {
    const result = classifyAccount({ address: "SomePoolVaultTokenAccount1111111111111111", tokenAccountOwner: PUMPSWAP_PROGRAM_ID, ...ctx() });
    expect(result.classification).toBe("POOL_VAULT");
    expect(result.excludableFromAdjustedConcentration).toBe(true);
  });

  it("classifies an observed transaction signer as USER_WALLET, non-excludable", () => {
    const result = classifyAccount({ address: WALLET, observedAsTransactionSigner: true, ...ctx() });
    expect(result.classification).toBe("USER_WALLET");
    expect(result.excludableFromAdjustedConcentration).toBe(false);
  });

  it("classifies an unrecognized large-balance account as UNKNOWN, remaining included (never excluded on size alone)", () => {
    const result = classifyAccount({ address: "SomeLargeUnknownHolder1111111111111111111", ...ctx() });
    expect(result.classification).toBe("UNKNOWN");
    expect(result.excludableFromAdjustedConcentration).toBe(false);
    expect(result.confidence).toBe(0);
  });

  it("never produces EXCHANGE_CUSTODY, LIQUIDITY_LOCKER, or RELAYER_OR_ROUTER without a verified source (none exists yet)", () => {
    const addresses = [WALLET, TOKEN_PROGRAM_ID, SOLANA_INCINERATOR_ADDRESS, "RandomAddress111111111111111111111111111"];
    for (const address of addresses) {
      const result = classifyAccount({ address, ...ctx() });
      expect(["EXCHANGE_CUSTODY", "LIQUIDITY_LOCKER", "RELAYER_OR_ROUTER"]).not.toContain(result.classification);
    }
  });
});
