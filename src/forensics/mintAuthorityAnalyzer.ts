/**
 * Phase 5C — mint/freeze authority and Token-2022 extension decoding.
 *
 * Reuses `@solana/spl-token`'s pure, offline decode functions (`unpackMint`,
 * `getExtensionTypes`) on account bytes already fetched through the Phase 5B
 * client. Never calls `@solana/spl-token`'s network-calling `getMint()` and
 * never constructs a `Connection` — read-only bytes in, typed data out.
 */

import { AccountInfo, PublicKey } from "@solana/web3.js";
import { ExtensionType, getExtensionTypes, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackMint } from "@solana/spl-token";
import { AuthorityState } from "./types";
import { ForensicsRpcClient } from "./solanaForensicsClient";

export interface MintAuthorityAnalysisResult extends AuthorityState {
  decimals?: number;
  /** Raw base-unit supply as decoded straight from the mint account, bigint-safe. */
  rawSupply?: string;
  contextSlot?: number;
  supportedExtensions: string[];
}

function unavailableResult(warnings: string[], tokenProgram: AuthorityState["tokenProgram"] = "UNKNOWN", contextSlot?: number): MintAuthorityAnalysisResult {
  return {
    tokenProgram,
    mintAuthority: undefined,
    freezeAuthority: undefined,
    warnings,
    decimals: undefined,
    rawSupply: undefined,
    contextSlot,
    supportedExtensions: [],
  };
}

export async function analyzeMintAuthority(
  client: ForensicsRpcClient,
  mint: string
): Promise<MintAuthorityAnalysisResult> {
  const result = await client.getAccountInfo(mint, {});
  if (result.status !== "AVAILABLE") {
    const detail = result.status === "UNAVAILABLE" ? `${result.code}: ${result.reason}` : result.reason;
    return unavailableResult([`mint account fetch failed: ${detail}`]);
  }

  const accountValue = result.data.value;
  if (!accountValue) {
    return unavailableResult(["mint account does not exist on-chain"], "UNKNOWN", result.contextSlot);
  }

  let tokenProgram: AuthorityState["tokenProgram"];
  let programId: PublicKey;
  if (accountValue.owner === TOKEN_PROGRAM_ID.toBase58()) {
    tokenProgram = "SPL_TOKEN";
    programId = TOKEN_PROGRAM_ID;
  } else if (accountValue.owner === TOKEN_2022_PROGRAM_ID.toBase58()) {
    tokenProgram = "TOKEN_2022";
    programId = TOKEN_2022_PROGRAM_ID;
  } else {
    return unavailableResult(
      [`mint account owner ${accountValue.owner} is neither the SPL Token nor Token-2022 program`],
      "UNKNOWN",
      result.contextSlot
    );
  }

  if (!Array.isArray(accountValue.data)) {
    return unavailableResult(["mint account data was not returned as a base64 tuple"], tokenProgram, result.contextSlot);
  }
  const buffer = Buffer.from(accountValue.data[0], "base64");

  const accountInfo: AccountInfo<Buffer> = {
    data: buffer,
    executable: accountValue.executable,
    lamports: accountValue.lamports,
    owner: new PublicKey(accountValue.owner),
    rentEpoch: accountValue.rentEpoch ?? 0,
  };

  try {
    const decoded = unpackMint(new PublicKey(mint), accountInfo, programId);
    const warnings: string[] = [];
    let supportedExtensions: string[] = [];
    if (tokenProgram === "TOKEN_2022" && decoded.tlvData.length > 0) {
      try {
        supportedExtensions = getExtensionTypes(decoded.tlvData).map((t) => ExtensionType[t] ?? `UNKNOWN_EXTENSION_${t}`);
      } catch (err) {
        warnings.push(`Token-2022 extension TLV parse failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return {
      tokenProgram,
      mintAuthority: decoded.mintAuthority ? decoded.mintAuthority.toBase58() : null,
      freezeAuthority: decoded.freezeAuthority ? decoded.freezeAuthority.toBase58() : null,
      warnings,
      decimals: decoded.decimals,
      rawSupply: decoded.supply.toString(),
      contextSlot: result.contextSlot,
      supportedExtensions,
    };
  } catch (err) {
    return unavailableResult(
      [`mint decode failed: ${err instanceof Error ? err.message : String(err)}`],
      tokenProgram,
      result.contextSlot
    );
  }
}
