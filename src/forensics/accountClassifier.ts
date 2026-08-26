/**
 * Phase 5C — conservative, evidence-only account classification.
 *
 * Deliberately does NOT maintain an exchange/locker/relayer address list
 * (phase5c.txt §8 forbids it). `EXCHANGE_CUSTODY`, `LIQUIDITY_LOCKER`, and
 * `RELAYER_OR_ROUTER` are declared in the classification type for schema
 * completeness/future evidence sources, but this module never produces them
 * without a verified, cited source — today it never produces them at all.
 * A large balance is never, by itself, evidence of anything.
 */

import { PublicKey } from "@solana/web3.js";
import { ForensicEvidence } from "./types";
import {
  KNOWN_LAUNCH_PROGRAM_IDS,
  PUMP_FUN_PROGRAM_ID,
  PUMPSWAP_PROGRAM_ID,
  SYSTEM_AND_PROGRAM_ACCOUNTS,
  VERIFIED_BURN_ACCOUNTS,
} from "./wellKnownAccounts";

export type AccountClassification =
  | "USER_WALLET"
  | "POOL_VAULT"
  | "BONDING_CURVE"
  | "PROGRAM_ACCOUNT"
  | "SYSTEM_ACCOUNT"
  | "BURN_ACCOUNT"
  | "LIQUIDITY_LOCKER"
  | "EXCHANGE_CUSTODY"
  | "RELAYER_OR_ROUTER"
  | "UNKNOWN";

export interface AccountClassificationResult {
  address: string;
  classification: AccountClassification;
  /** True only for classifications that justify exclusion from adjusted concentration. */
  excludableFromAdjustedConcentration: boolean;
  confidence: number;
  reasonCode: string;
  evidence: ForensicEvidence[];
}

export interface AccountClassificationInput {
  address: string;
  /** For a token account, the wallet/program that owns it (from DAS/holder data). */
  tokenAccountOwner?: string;
  /** The mint in whose context this classification runs, for PDA derivation. */
  mint?: string;
  /** True if this address was observed signing a transaction (structural proof it is not a PDA). */
  observedAsTransactionSigner?: boolean;
  evidenceId: () => string;
  now: () => Date;
}

function evidence(
  input: AccountClassificationInput,
  category: string,
  description: string,
  reasonCode: string
): ForensicEvidence {
  return {
    id: input.evidenceId(),
    category,
    description,
    reasonCode,
    source: "SOLANA_STANDARD_RPC",
    wallets: [input.address],
    retrievedAt: input.now(),
  };
}

function derivePumpFunBondingCurvePda(mint: string): string | undefined {
  try {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()],
      new PublicKey(PUMP_FUN_PROGRAM_ID)
    );
    return pda.toBase58();
  } catch {
    return undefined;
  }
}

export function classifyAccount(input: AccountClassificationInput): AccountClassificationResult {
  const candidates = [input.address, input.tokenAccountOwner].filter((v): v is string => Boolean(v));

  for (const candidate of candidates) {
    if (SYSTEM_AND_PROGRAM_ACCOUNTS.has(candidate)) {
      return {
        address: input.address,
        classification: "SYSTEM_ACCOUNT",
        excludableFromAdjustedConcentration: true,
        confidence: 1,
        reasonCode: "KNOWN_SYSTEM_OR_TOKEN_PROGRAM",
        evidence: [evidence(input, "ACCOUNT_CLASSIFICATION", `${candidate} is a known system/token program`, "KNOWN_SYSTEM_OR_TOKEN_PROGRAM")],
      };
    }
    if (VERIFIED_BURN_ACCOUNTS.has(candidate)) {
      return {
        address: input.address,
        classification: "BURN_ACCOUNT",
        excludableFromAdjustedConcentration: true,
        confidence: 1,
        reasonCode: "VERIFIED_BURN_ADDRESS",
        evidence: [evidence(input, "ACCOUNT_CLASSIFICATION", `${candidate} is the verified Solana incinerator address`, "VERIFIED_BURN_ADDRESS")],
      };
    }
  }

  if (input.mint) {
    const bondingCurvePda = derivePumpFunBondingCurvePda(input.mint);
    if (bondingCurvePda && candidates.includes(bondingCurvePda)) {
      return {
        address: input.address,
        classification: "BONDING_CURVE",
        excludableFromAdjustedConcentration: true,
        confidence: 0.95,
        reasonCode: "DERIVED_PUMPFUN_BONDING_CURVE_PDA",
        evidence: [
          evidence(
            input,
            "ACCOUNT_CLASSIFICATION",
            `${bondingCurvePda} is the deterministically-derived Pump.fun bonding-curve PDA for mint ${input.mint}`,
            "DERIVED_PUMPFUN_BONDING_CURVE_PDA"
          ),
        ],
      };
    }
  }

  for (const candidate of candidates) {
    if (candidate === PUMPSWAP_PROGRAM_ID) {
      return {
        address: input.address,
        classification: "POOL_VAULT",
        excludableFromAdjustedConcentration: true,
        confidence: 0.9,
        reasonCode: "OWNED_BY_PUMPSWAP_AMM_PROGRAM",
        evidence: [evidence(input, "ACCOUNT_CLASSIFICATION", `token account owned by the PumpSwap AMM program`, "OWNED_BY_PUMPSWAP_AMM_PROGRAM")],
      };
    }
    if (KNOWN_LAUNCH_PROGRAM_IDS.has(candidate)) {
      return {
        address: input.address,
        classification: "PROGRAM_ACCOUNT",
        excludableFromAdjustedConcentration: true,
        confidence: 0.9,
        reasonCode: "KNOWN_LAUNCH_PROGRAM_OWNED",
        evidence: [evidence(input, "ACCOUNT_CLASSIFICATION", `account owned by a known launch/migration program`, "KNOWN_LAUNCH_PROGRAM_OWNED")],
      };
    }
  }

  if (input.observedAsTransactionSigner) {
    return {
      address: input.address,
      classification: "USER_WALLET",
      excludableFromAdjustedConcentration: false,
      confidence: 0.8,
      reasonCode: "OBSERVED_AS_TRANSACTION_SIGNER",
      evidence: [
        evidence(
          input,
          "ACCOUNT_CLASSIFICATION",
          `${input.address} signed a transaction, which a program-derived address cannot do outside CPI`,
          "OBSERVED_AS_TRANSACTION_SIGNER"
        ),
      ],
    };
  }

  return {
    address: input.address,
    classification: "UNKNOWN",
    excludableFromAdjustedConcentration: false,
    confidence: 0,
    reasonCode: "NO_POSITIVE_CLASSIFICATION_EVIDENCE",
    evidence: [],
  };
}
