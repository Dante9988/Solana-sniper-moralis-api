import axios from "axios";
import { RugResponseExtended } from "../types";

/**
 * Read-only RugCheck.xyz / SolSniffer clients for the intelligence layer.
 *
 * Deliberately independent of src/transactions.ts: that file's
 * getRugCheckConfirmed()/getSolSnifferConfirmed() collapse the evidence into
 * a pass/fail boolean against trading config, and getRugCheckConfirmed()
 * also writes into the trading tracker's SQLite DB (insertNewToken) as a
 * side effect. This module returns the raw evidence instead, and never
 * imports ./config, ./tracker/db, or anything wallet/keypair related.
 */

const AXIOS_TIMEOUT = 10000;

export interface SolSnifferAuditRisk {
  mintDisabled?: boolean;
  freezeDisabled?: boolean;
  lpBurned?: boolean;
  [key: string]: unknown;
}

export interface SolSnifferReport {
  auditRisk: SolSnifferAuditRisk | null;
  raw: unknown;
}

export async function fetchRugCheckReport(
  tokenMint: string
): Promise<RugResponseExtended | null> {
  try {
    const response = await axios.get<RugResponseExtended>(
      `https://api.rugcheck.xyz/v1/tokens/${tokenMint}/report`,
      { timeout: AXIOS_TIMEOUT }
    );
    return response.data ?? null;
  } catch (error) {
    console.error(`safetyCheckService: RugCheck fetch failed for ${tokenMint}:`, error);
    return null;
  }
}

export async function fetchSolSnifferReport(
  tokenMint: string
): Promise<SolSnifferReport | null> {
  try {
    const response = await axios.get(
      `https://solsniffer.com/api/v2/token/${tokenMint}`,
      {
        headers: {
          "X-API-KEY": process.env.SOLSNIFFER_API_KEY || "",
          accept: "application/json",
        },
        timeout: AXIOS_TIMEOUT,
      }
    );
    const auditRisk = response.data?.tokenData?.auditRisk ?? null;
    return { auditRisk, raw: response.data ?? null };
  } catch (error) {
    console.error(`safetyCheckService: SolSniffer fetch failed for ${tokenMint}:`, error);
    return null;
  }
}
