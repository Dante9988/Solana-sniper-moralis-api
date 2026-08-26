import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { analyzeLaunchTransaction } from "../launchTransactionAnalyzer";
import { makeFakeClient } from "../fixtures/fakeClient";
import { accountKey, available, buildTransaction, initializeMint2, mintTo, parsedInstruction, systemTransfer, tokenBalance, unavailable } from "../fixtures/syntheticBuilders";
import {
  PUMPSWAP_PROGRAM_ID,
  PUMP_FUN_PROGRAM_ID,
  PUMP_FUN_RAYDIUM_MIGRATION,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "../wellKnownAccounts";

const MINT = "So11111111111111111111111111111111111111112";
const DEV = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const BUYER_A = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const BUYER_B = "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS";
const SIG = "sig-launch-1";

function ctx() {
  let n = 0;
  return { evidenceId: () => `ev-${++n}`, now: () => new Date("2026-01-01T00:00:00.000Z") };
}

describe("analyzeLaunchTransaction", () => {
  it("returns UNAVAILABLE with no discovery signature", async () => {
    const client = makeFakeClient({});
    const result = await analyzeLaunchTransaction(client, { mint: MINT, discoverySource: "UNKNOWN" }, ctx());
    expect(result.coverage).toBe("UNAVAILABLE");
    expect(result.warnings[0]).toMatch(/no discovery signature/);
  });

  it("returns UNAVAILABLE when the RPC call fails", async () => {
    const client = makeFakeClient({ getTransaction: async () => unavailable("TIMEOUT") });
    const result = await analyzeLaunchTransaction(client, { mint: MINT, discoverySignature: SIG, discoverySource: "UNKNOWN" }, ctx());
    expect(result.coverage).toBe("UNAVAILABLE");
  });

  it("returns UNAVAILABLE when the transaction is not found (null result)", async () => {
    const client = makeFakeClient({ getTransaction: async () => available(null) });
    const result = await analyzeLaunchTransaction(client, { mint: MINT, discoverySignature: SIG, discoverySource: "UNKNOWN" }, ctx());
    expect(result.coverage).toBe("UNAVAILABLE");
    expect(result.warnings[0]).toMatch(/not found/);
  });

  it("legitimate distributed launch: buyers with SOL-balance-decrease evidence classify VERIFIED_BUY, full supply reconstruction", async () => {
    const tx = buildTransaction({
      signature: SIG,
      slot: 1000,
      blockTime: 1_700_000_000,
      accountKeys: [
        accountKey(DEV, { signer: true }),
        accountKey(BUYER_A, { signer: true }),
        accountKey(BUYER_B, { signer: true }),
      ],
      instructions: [
        parsedInstruction(PUMP_FUN_PROGRAM_ID, "unknown", "create", { accounts: [] }),
        initializeMint2(MINT, DEV),
        mintTo(MINT, "mintToDestination", "1000000000"),
      ],
      preBalances: [10_000_000_000, 5_000_000_000, 5_000_000_000],
      postBalances: [10_000_000_000, 4_000_000_000, 4_500_000_000], // both buyers' SOL decreased -> VERIFIED_BUY
      preTokenBalances: [],
      postTokenBalances: [tokenBalance(1, MINT, BUYER_A, "600000000"), tokenBalance(2, MINT, BUYER_B, "400000000")],
    });
    const client = makeFakeClient({ getTransaction: async () => available(tx) });
    const result = await analyzeLaunchTransaction(client, { mint: MINT, discoverySignature: SIG, discoverySource: "PUMPFUN" }, ctx());

    expect(result.coverage).toBe("COMPLETE");
    expect(result.slot).toBe(1000);
    expect(result.feePayer).toBe(DEV);
    expect(result.mintInitializationFound).toBe(true);
    expect(result.mintToInstructionsFound).toBe(1);
    expect(result.acquirers).toHaveLength(2);
    for (const acquirer of result.acquirers) {
      expect(acquirer.classification).toBe("VERIFIED_BUY");
    }
    expect(result.acquirers.find((a) => a.owner === BUYER_A)?.acquiredAmountRaw).toBe("600000000");
    expect(result.launchSupply.status).toBe("COMPLETE");
    expect(result.launchSupply.rawSupply).toBe(1000000000n);
    expect(result.derivedSource).toBe("PUMPFUN");
    expect(result.creatorCandidates.some((c) => c.wallet === DEV && c.source === "LAUNCH_TX_FEE_PAYER")).toBe(true);
    expect(result.creatorCandidates.some((c) => c.wallet === DEV && c.source === "MINT_AUTHORITY")).toBe(true);
  });

  it("marks launch supply UNAVAILABLE when no mint-to instruction accounts for the token (insufficient evidence)", async () => {
    const tx = buildTransaction({
      signature: SIG,
      slot: 1000,
      accountKeys: [accountKey(DEV, { signer: true }), accountKey(BUYER_A, { signer: true })],
      instructions: [],
      postTokenBalances: [tokenBalance(0, MINT, BUYER_A, "100")],
    });
    const client = makeFakeClient({ getTransaction: async () => available(tx) });
    const result = await analyzeLaunchTransaction(client, { mint: MINT, discoverySignature: SIG, discoverySource: "UNKNOWN" }, ctx());
    expect(result.launchSupply.status).toBe("UNAVAILABLE");
    expect(result.launchSupply.limitation).toBeTruthy();
    // Acquirers are still recorded even without a reconstructable supply.
    expect(result.acquirers).toHaveLength(1);
    expect(result.acquirers[0].owner).toBe(BUYER_A);
    expect(result.acquirers[0].acquiredAmountRaw).toBe("100");
  });

  it("derives source PUMPSWAP from on-chain program-ID evidence, never from a config label", async () => {
    const tx = buildTransaction({
      signature: SIG,
      slot: 1,
      accountKeys: [accountKey(DEV, { signer: true })],
      instructions: [parsedInstruction(PUMPSWAP_PROGRAM_ID, "unknown", "swap", {})],
    });
    const client = makeFakeClient({ getTransaction: async () => available(tx) });
    const result = await analyzeLaunchTransaction(client, { mint: MINT, discoverySignature: SIG, discoverySource: "PUMPFUN" }, ctx());
    expect(result.derivedSource).toBe("PUMPSWAP");
  });

  it("derives source MIGRATION from the Raydium migration program ID", async () => {
    const tx = buildTransaction({
      signature: SIG,
      slot: 1,
      accountKeys: [accountKey(DEV, { signer: true })],
      instructions: [parsedInstruction(PUMP_FUN_RAYDIUM_MIGRATION, "unknown", "migrate", {})],
    });
    const client = makeFakeClient({ getTransaction: async () => available(tx) });
    const result = await analyzeLaunchTransaction(client, { mint: MINT, discoverySignature: SIG, discoverySource: "UNKNOWN" }, ctx());
    expect(result.derivedSource).toBe("MIGRATION");
  });

  it("stays UNKNOWN when no known launch program ID is present, regardless of the configured label", async () => {
    const tx = buildTransaction({
      signature: SIG,
      slot: 1,
      accountKeys: [accountKey(DEV, { signer: true })],
      instructions: [systemTransfer(DEV, BUYER_A, 1)],
    });
    const client = makeFakeClient({ getTransaction: async () => available(tx) });
    const result = await analyzeLaunchTransaction(client, { mint: MINT, discoverySignature: SIG, discoverySource: "PUMPSWAP" }, ctx());
    expect(result.derivedSource).toBe("UNKNOWN");
  });

  it("supports a versioned transaction with an address-lookup-table-sourced account key", async () => {
    const tx = buildTransaction({
      signature: SIG,
      slot: 1,
      accountKeys: [accountKey(DEV, { signer: true, source: "transaction" }), accountKey(BUYER_A, { signer: false, source: "lookupTable" })],
      instructions: [],
      postTokenBalances: [tokenBalance(1, MINT, BUYER_A, "50")],
    });
    const client = makeFakeClient({ getTransaction: async () => available(tx) });
    const result = await analyzeLaunchTransaction(client, { mint: MINT, discoverySignature: SIG, discoverySource: "UNKNOWN" }, ctx());
    expect(result.coverage).toBe("COMPLETE");
    expect(result.accountKeys.map((a) => a.pubkey)).toContain(BUYER_A);
    expect(result.acquirers[0].acquiredAmountRaw).toBe("50");
  });

  it("does not double-count a buyer's pre-existing balance as newly acquired (delta only)", async () => {
    const tx = buildTransaction({
      signature: SIG,
      slot: 1,
      accountKeys: [accountKey(BUYER_A, { signer: true })],
      instructions: [],
      preTokenBalances: [tokenBalance(0, MINT, BUYER_A, "100")],
      postTokenBalances: [tokenBalance(0, MINT, BUYER_A, "150")],
    });
    const client = makeFakeClient({ getTransaction: async () => available(tx) });
    const result = await analyzeLaunchTransaction(client, { mint: MINT, discoverySignature: SIG, discoverySource: "UNKNOWN" }, ctx());
    expect(result.acquirers[0].acquiredAmountRaw).toBe("50");
  });
});

describe("analyzeLaunchTransaction — acquisition classification (phase5d.txt §1)", () => {
  it("classifies a delta into the bonding-curve PDA as POOL_OR_VAULT_FUNDING, never a buy", async () => {
    const [bondingCurvePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("bonding-curve"), new PublicKey(MINT).toBuffer()],
      new PublicKey(PUMP_FUN_PROGRAM_ID)
    );
    const pda = bondingCurvePda.toBase58();
    const tx = buildTransaction({
      signature: SIG,
      slot: 1,
      accountKeys: [accountKey(DEV, { signer: true }), accountKey(pda, { signer: false })],
      instructions: [],
      postTokenBalances: [tokenBalance(1, MINT, pda, "999999999")],
    });
    const client = makeFakeClient({ getTransaction: async () => available(tx) });
    const result = await analyzeLaunchTransaction(client, { mint: MINT, discoverySignature: SIG, discoverySource: "UNKNOWN" }, ctx());
    expect(result.acquirers[0].classification).toBe("POOL_OR_VAULT_FUNDING");
  });

  it("classifies the mintTo destination account as MINT_DESTINATION", async () => {
    const tx = buildTransaction({
      signature: SIG,
      slot: 1,
      accountKeys: [accountKey(DEV, { signer: true }), accountKey(BUYER_A, { signer: true })],
      instructions: [mintTo(MINT, "mintDestTokenAccount", "1000")],
      postTokenBalances: [tokenBalance(1, MINT, BUYER_A, "1000")],
    });
    // Overwrite so the token-account address at accountIndex 1 IS the mintTo destination.
    tx.transaction.message.accountKeys[1] = accountKey("mintDestTokenAccount", { signer: false });
    const client = makeFakeClient({ getTransaction: async () => available(tx) });
    const result = await analyzeLaunchTransaction(client, { mint: MINT, discoverySignature: SIG, discoverySource: "UNKNOWN" }, ctx());
    expect(result.acquirers[0].classification).toBe("MINT_DESTINATION");
  });

  it("classifies an unexplained receipt (airdrop-like, no SOL decrease, no distribution instruction) as TOKEN_RECEIPT", async () => {
    const tx = buildTransaction({
      signature: SIG,
      slot: 1,
      accountKeys: [accountKey(DEV, { signer: true }), accountKey(BUYER_A, { signer: false })],
      instructions: [],
      preBalances: [10_000, 5_000],
      postBalances: [9_995, 5_000], // buyer's SOL balance unchanged (only fee payer paid)
      postTokenBalances: [tokenBalance(1, MINT, BUYER_A, "777")],
    });
    const client = makeFakeClient({ getTransaction: async () => available(tx) });
    const result = await analyzeLaunchTransaction(client, { mint: MINT, discoverySignature: SIG, discoverySource: "UNKNOWN" }, ctx());
    expect(result.acquirers[0].classification).toBe("TOKEN_RECEIPT");
  });

  it("classifies a direct transfer authorized by the fee payer as INITIAL_DISTRIBUTION", async () => {
    const tx = buildTransaction({
      signature: SIG,
      slot: 1,
      accountKeys: [accountKey(DEV, { signer: true }), accountKey(BUYER_A, { signer: false })],
      instructions: [
        parsedInstruction(TOKEN_PROGRAM_ID, "spl-token", "transfer", {
          source: "devTokenAccount",
          destination: BUYER_A,
          authority: DEV,
          amount: "500",
        }),
      ],
      postTokenBalances: [tokenBalance(1, MINT, BUYER_A, "500")],
    });
    const client = makeFakeClient({ getTransaction: async () => available(tx) });
    const result = await analyzeLaunchTransaction(client, { mint: MINT, discoverySignature: SIG, discoverySource: "UNKNOWN" }, ctx());
    expect(result.acquirers[0].classification).toBe("INITIAL_DISTRIBUTION");
  });

  it("classifies a wallet whose SOL balance decreased in the same tx as VERIFIED_BUY", async () => {
    const tx = buildTransaction({
      signature: SIG,
      slot: 1,
      accountKeys: [accountKey(DEV, { signer: true }), accountKey(BUYER_A, { signer: true })],
      instructions: [],
      preBalances: [10_000, 5_000_000],
      postBalances: [10_000, 4_000_000],
      postTokenBalances: [tokenBalance(1, MINT, BUYER_A, "1000")],
    });
    const client = makeFakeClient({ getTransaction: async () => available(tx) });
    const result = await analyzeLaunchTransaction(client, { mint: MINT, discoverySignature: SIG, discoverySource: "UNKNOWN" }, ctx());
    expect(result.acquirers[0].classification).toBe("VERIFIED_BUY");
  });

  it("classifies an acquisition with no resolvable owner as UNKNOWN_ACQUISITION", async () => {
    const tx = buildTransaction({
      signature: SIG,
      slot: 1,
      accountKeys: [accountKey(DEV, { signer: true })],
      instructions: [],
      postTokenBalances: [{ accountIndex: 1, mint: MINT, owner: undefined, uiTokenAmount: { amount: "42", decimals: 6, uiAmount: null } } as never],
    });
    const client = makeFakeClient({ getTransaction: async () => available(tx) });
    const result = await analyzeLaunchTransaction(client, { mint: MINT, discoverySignature: SIG, discoverySource: "UNKNOWN" }, ctx());
    expect(result.acquirers[0].classification).toBe("UNKNOWN_ACQUISITION");
  });

  it("preserves positive deltas as evidence even for non-buy classifications", async () => {
    const tx = buildTransaction({
      signature: SIG,
      slot: 1,
      accountKeys: [accountKey(DEV, { signer: true }), accountKey(BUYER_A, { signer: false })],
      instructions: [],
      postTokenBalances: [tokenBalance(1, MINT, BUYER_A, "10")],
    });
    const client = makeFakeClient({ getTransaction: async () => available(tx) });
    const result = await analyzeLaunchTransaction(client, { mint: MINT, discoverySignature: SIG, discoverySource: "UNKNOWN" }, ctx());
    expect(result.acquirers[0].evidence.length).toBeGreaterThan(0);
  });
});
