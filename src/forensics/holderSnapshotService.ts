/**
 * Phase 5C — holder snapshot and owner aggregation.
 *
 * Aggregates DAS token accounts by owner (multiple accounts owned by one
 * wallet count as one holder) using bigint balances throughout. Raw/adjusted
 * top-10, largest-non-system-holder, and holder-count are only computed when
 * pagination reached natural (COMPLETE) termination — a partial page set
 * cannot honestly claim to contain the true top holders.
 */

import { AmountEntry, calculateAdjustedConcentration, calculateLargestHolderPct, calculatePercentage, sumAmounts } from "./percentageCalculations";
import { classifyAccount } from "./accountClassifier";
import { CoverageStatus, ExcludedAccountEvidence, ForensicEvidence, HolderConcentration } from "./types";
import { ForensicsRpcClient } from "./solanaForensicsClient";

export interface OwnerBalance {
  owner: string;
  balance: bigint;
  tokenAccounts: string[];
}

export interface HolderSnapshotResult {
  coverage: CoverageStatus;
  holderPagesFetched: number;
  contextSlot?: number;
  /** Sorted descending by balance, ties broken by owner address for determinism. */
  owners: OwnerBalance[];
  holderConcentration: HolderConcentration;
  warnings: string[];
  evidence: ForensicEvidence[];
}

function compareOwners(a: OwnerBalance, b: OwnerBalance): number {
  if (a.balance > b.balance) return -1;
  if (a.balance < b.balance) return 1;
  return a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0;
}

export async function buildHolderSnapshot(
  client: ForensicsRpcClient,
  mint: string,
  opts: { maxPages: number; currentSupply?: bigint; evidenceId: () => string; now: () => Date }
): Promise<HolderSnapshotResult> {
  const paginated = await client.getTokenAccountsPaginated(mint, { maxPages: opts.maxPages });
  const warnings = [...paginated.warnings];

  const byOwner = new Map<string, { balance: bigint; tokenAccounts: string[] }>();
  for (const page of paginated.pages) {
    for (const entry of page.token_accounts) {
      const amount = BigInt(entry.amount);
      const existing = byOwner.get(entry.owner);
      if (existing) {
        existing.balance += amount;
        existing.tokenAccounts.push(entry.address);
      } else {
        byOwner.set(entry.owner, { balance: amount, tokenAccounts: [entry.address] });
      }
    }
  }

  const owners: OwnerBalance[] = Array.from(byOwner.entries())
    .map(([owner, v]) => ({ owner, balance: v.balance, tokenAccounts: v.tokenAccounts }))
    .sort(compareOwners);

  const complete = paginated.status === "COMPLETE";
  const evidence: ForensicEvidence[] = [];
  const excludedAccounts: ExcludedAccountEvidence[] = [];

  let rawTop10Pct: number | undefined;
  let adjustedTop10Pct: number | undefined;
  let largestNonSystemHolderPct: number | undefined;
  let holderCount: number | undefined;

  if (complete) {
    holderCount = owners.length;
    const top10 = owners.slice(0, 10);
    const top10Amounts: AmountEntry[] = top10.map((h) => ({ wallet: h.owner, amount: h.balance }));
    rawTop10Pct = calculatePercentage(sumAmounts(top10Amounts), opts.currentSupply);

    for (const holder of top10) {
      const classification = classifyAccount({
        address: holder.owner,
        mint,
        evidenceId: opts.evidenceId,
        now: opts.now,
      });
      if (classification.excludableFromAdjustedConcentration) {
        excludedAccounts.push({ address: holder.owner, reasonCode: classification.reasonCode, evidence: classification.evidence });
        evidence.push(...classification.evidence);
      }
    }
    const excludedSet = new Set(excludedAccounts.map((e) => e.address));
    adjustedTop10Pct = calculateAdjustedConcentration(top10Amounts, excludedSet, opts.currentSupply);

    const allAmounts: AmountEntry[] = owners.map((h) => ({ wallet: h.owner, amount: h.balance }));
    largestNonSystemHolderPct = calculateLargestHolderPct(allAmounts, excludedSet, opts.currentSupply);
  } else {
    warnings.push("top-10/adjusted-top-10/largest-holder/holder-count withheld: holder pagination did not reach complete coverage");
  }

  return {
    coverage: paginated.status,
    holderPagesFetched: paginated.pagesFetched,
    contextSlot: paginated.contextSlot,
    owners,
    holderConcentration: {
      rawTop10Pct,
      adjustedTop10Pct,
      largestNonSystemHolderPct,
      holderCount,
      excludedAccounts,
    },
    warnings,
    evidence,
  };
}

/** Look up a specific wallet's current balance in an already-built snapshot. Zero only under COMPLETE coverage. */
export function currentBalanceOf(snapshot: HolderSnapshotResult, wallet: string): bigint | undefined {
  if (snapshot.coverage !== "COMPLETE") return undefined;
  return snapshot.owners.find((o) => o.owner === wallet)?.balance ?? 0n;
}

/** Sum of current balances for a wallet set. `undefined` unless the snapshot has COMPLETE coverage. */
export function currentHoldingsOf(snapshot: HolderSnapshotResult, wallets: readonly string[]): AmountEntry[] | undefined {
  if (snapshot.coverage !== "COMPLETE") return undefined;
  return wallets.map((wallet) => ({ wallet, amount: currentBalanceOf(snapshot, wallet) ?? 0n }));
}
