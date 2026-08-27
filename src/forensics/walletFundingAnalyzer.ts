/**
 * Phase 5C — one-hop bounded wallet funding analysis (phase5c.txt §10).
 *
 * For each candidate wallet, searches a bounded window of its transaction
 * history for a System Program transfer that funded it. Never expands
 * beyond one hop, never claims a wallet's "original creator" from a bounded
 * search, and never treats a shared exchange/router/relayer/faucet/fee
 * sponsor as coordination evidence by itself (that judgment is made by
 * `walletClusterService`, not here — this module only records the fact).
 */

import { ForensicEvidence } from "./types";
import { isParsedInstruction } from "./rpcSchemas";
import { ForensicsRpcClient } from "./solanaForensicsClient";
import { SYSTEM_PROGRAM_ID } from "./wellKnownAccounts";

export type WalletFundingCompleteness = "FOUND_WITHIN_BOUND" | "NOT_FOUND_WITHIN_BOUND" | "UNAVAILABLE";

export interface WalletFundingEvidence {
  recipientWallet: string;
  funderWallet?: string;
  fundingSignature?: string;
  slot?: number;
  blockTime?: Date;
  lamports?: string;
  feePayer?: string;
  completeness: WalletFundingCompleteness;
  /** Count of transactions observed for this wallet within the bounded funding-search window (informational only — see `analyzeFreshWalletStatus` for the fresh-wallet determination). */
  observedTransactionCount?: number;
  evidence: ForensicEvidence[];
  warnings: string[];
}

export async function analyzeWalletFunding(
  client: ForensicsRpcClient,
  wallet: string,
  opts: { maxTransactions: number; evidenceId: () => string; now: () => Date }
): Promise<WalletFundingEvidence> {
  const result = await client.getTransactionsForAddress(wallet, {
    transactionDetails: "full",
    limit: opts.maxTransactions,
  });

  if (result.status === "UNAVAILABLE") {
    return {
      recipientWallet: wallet,
      completeness: "UNAVAILABLE",
      evidence: [],
      warnings: [`funding search unavailable: ${result.code}: ${result.reason}`],
    };
  }

  const items = result.data.data;
  let earliest: {
    funder: string;
    signature: string;
    slot?: number;
    blockTime?: Date;
    lamports: bigint;
    feePayer?: string;
  } | undefined;

  for (const item of items) {
    if (!item.transaction || !item.meta) continue;
    const accountKeys = item.transaction.message.accountKeys;
    const feePayer = accountKeys[0]?.pubkey;
    const allInstructions = [
      ...item.transaction.message.instructions,
      ...((item.meta.innerInstructions ?? []).flatMap((g) => g.instructions)),
    ];

    for (const instr of allInstructions) {
      if (instr.programId !== SYSTEM_PROGRAM_ID || !isParsedInstruction(instr)) continue;
      if (instr.parsed.type !== "transfer" && instr.parsed.type !== "transferWithSeed") continue;
      const info = instr.parsed.info;
      const destination = typeof info.destination === "string" ? info.destination : undefined;
      const source = typeof info.source === "string" ? info.source : undefined;
      const lamportsRaw = info.lamports;
      if (destination !== wallet || !source) continue;
      const lamports = typeof lamportsRaw === "number" ? BigInt(lamportsRaw) : typeof lamportsRaw === "string" ? BigInt(lamportsRaw) : 0n;

      if (!earliest || (item.slot !== undefined && earliest.slot !== undefined && item.slot < earliest.slot)) {
        earliest = {
          funder: source,
          signature: item.signature,
          slot: item.slot,
          blockTime: item.blockTime ? new Date(item.blockTime * 1000) : undefined,
          lamports,
          feePayer,
        };
      }
    }
  }

  const boundedWarning =
    result.status === "PARTIAL"
      ? `funding search bounded/partial: ${result.reason}`
      : `funding search bounded to ${opts.maxTransactions} most-recent transactions; this is not proof of the wallet's original creation funding`;

  if (!earliest) {
    return {
      recipientWallet: wallet,
      completeness: "NOT_FOUND_WITHIN_BOUND",
      observedTransactionCount: items.length,
      evidence: [],
      warnings: [boundedWarning],
    };
  }

  return {
    recipientWallet: wallet,
    funderWallet: earliest.funder,
    fundingSignature: earliest.signature,
    slot: earliest.slot,
    blockTime: earliest.blockTime,
    lamports: earliest.lamports.toString(),
    feePayer: earliest.feePayer,
    completeness: "FOUND_WITHIN_BOUND",
    observedTransactionCount: items.length,
    evidence: [
      {
        id: opts.evidenceId(),
        category: "WALLET_FUNDING",
        description: `${wallet} received a System Program transfer from ${earliest.funder}`,
        reasonCode: "ONE_HOP_BOUNDED_SYSTEM_TRANSFER",
        source: "SOLANA_STANDARD_RPC",
        signature: earliest.signature,
        slot: earliest.slot,
        wallets: [wallet, earliest.funder],
        amounts: { [wallet]: earliest.lamports.toString() },
        retrievedAt: opts.now(),
      },
    ],
    warnings: [boundedWarning],
  };
}

export type FreshWalletStatus = "FRESH" | "NOT_FRESH" | "UNKNOWN";

export interface FreshWalletResult {
  wallet: string;
  status: FreshWalletStatus;
  /** The exact required bounded label — only meaningful when `status === "FRESH"`. */
  definition: string;
  reason: string;
  evidence: ForensicEvidence[];
}

/**
 * Determines fresh-wallet status against a specific pre-launch lookback
 * window (phase5d.txt §4). A wallet is only ever labeled `FRESH` when:
 *  - the transaction-history query succeeded,
 *  - the pre-launch window was actually covered (either the wallet's entire
 *    history terminated naturally within budget, or the scan reached/passed
 *    the launch slot without finding earlier activity),
 *  - no qualifying activity was found strictly before the launch slot,
 *  - the launch transaction itself is excluded from the "prior activity" test,
 *  - pagination/budget/deadline did not truncate required coverage.
 * Every other case is `UNKNOWN` — never a "newly created" claim, and never
 * inferred from a zero-length result under incomplete coverage.
 */
export async function analyzeFreshWalletStatus(
  client: ForensicsRpcClient,
  wallet: string,
  opts: {
    launchSlot?: number;
    launchSignature?: string;
    maxPages: number;
    limitPerPage: number;
    definitionLabel: string;
    evidenceId: () => string;
    now: () => Date;
  }
): Promise<FreshWalletResult> {
  if (opts.launchSlot === undefined) {
    return {
      wallet,
      status: "UNKNOWN",
      definition: opts.definitionLabel,
      reason: "launch slot is unavailable; pre-launch activity cannot be tested",
      evidence: [],
    };
  }

  const paginated = await client.getTransactionsForAddressPaginated(wallet, {
    maxPages: opts.maxPages,
    limit: opts.limitPerPage,
    transactionDetails: "signatures",
    sortOrder: "asc",
  });

  if (paginated.status === "UNAVAILABLE") {
    return {
      wallet,
      status: "UNKNOWN",
      definition: opts.definitionLabel,
      reason: `transaction-history query unavailable: ${paginated.warnings.join("; ") || "no detail"}`,
      evidence: [],
    };
  }

  let sawAtOrPastLaunch = false;
  for (const item of paginated.items) {
    if (item.signature === opts.launchSignature) continue;
    if (item.slot === undefined) continue;
    if (item.slot < opts.launchSlot) {
      return {
        wallet,
        status: "NOT_FRESH",
        definition: opts.definitionLabel,
        reason: `prior activity found at slot ${item.slot}, before the launch slot ${opts.launchSlot}`,
        evidence: [
          {
            id: opts.evidenceId(),
            category: "FRESH_WALLET_CHECK",
            description: `${wallet} has activity before the launch transaction`,
            reasonCode: "PRE_LAUNCH_ACTIVITY_FOUND",
            source: "SOLANA_STANDARD_RPC",
            signature: item.signature,
            slot: item.slot,
            wallets: [wallet],
            retrievedAt: opts.now(),
          },
        ],
      };
    }
    if (item.slot >= opts.launchSlot) sawAtOrPastLaunch = true;
  }

  // Ascending scan found nothing before the launch slot. Coverage is
  // sufficient either because pagination terminated naturally (we've seen
  // the wallet's entire history) or because we scanned at/past the launch
  // slot without finding disqualifying activity (the pre-launch window is
  // fully covered even if later history wasn't).
  if (paginated.status === "COMPLETE" || sawAtOrPastLaunch) {
    return {
      wallet,
      status: "FRESH",
      definition: opts.definitionLabel,
      reason: "no activity observed before the launch transaction within the covered window",
      evidence: [
        {
          id: opts.evidenceId(),
          category: "FRESH_WALLET_CHECK",
          description: `${wallet}: ${opts.definitionLabel}`,
          reasonCode: "NO_PRE_LAUNCH_ACTIVITY_WITHIN_COVERED_WINDOW",
          source: "SOLANA_STANDARD_RPC",
          wallets: [wallet],
          retrievedAt: opts.now(),
        },
      ],
    };
  }

  return {
    wallet,
    status: "UNKNOWN",
    definition: opts.definitionLabel,
    reason: `pagination/budget cutoff before reaching the launch slot (${paginated.warnings.join("; ") || "coverage truncated"})`,
    evidence: [],
  };
}
