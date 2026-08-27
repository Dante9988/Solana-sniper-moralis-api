/**
 * Phase 5C — deterministic wallet-cluster evidence graph (phase5c.txt §11).
 *
 * Builds relationships from already-collected evidence (launch-transaction
 * co-participation, one-hop funding) and classifies connected components.
 * Every false-positive control from §11 is enforced structurally:
 *  - `SAME_TRANSACTION` alone never yields CONFIRMED_BUNDLE.
 *  - A `COMMON_FEE_PAYER` that is merely a consequence of `SAME_TRANSACTION`
 *    is marked `independentSignal: false` and never counts a second time.
 *  - `LIKELY_COORDINATED` requires >=2 DISTINCT independent, non-timing
 *    signal TYPES.
 *  - Output is sorted deterministically (by wallet address), so results do
 *    not depend on input ordering.
 */

import { WalletCluster, WalletClusterClassification, WalletRelationship, WalletRelationshipType, ForensicEvidence } from "./types";
import { LaunchAcquirer, NON_BUYER_ACQUISITION_CLASSIFICATIONS } from "./launchTransactionAnalyzer";
import { WalletFundingEvidence } from "./walletFundingAnalyzer";

export interface ClusterAnalysisInput {
  launchSignature?: string;
  /** Full acquirer list; pool/vault/mint-destination acquisitions are excluded internally before clustering (phase5d.txt §1). */
  acquirers: LaunchAcquirer[];
  funding: Map<string, WalletFundingEvidence>;
  developerWallet?: string;
  evidenceId: () => string;
  now: () => Date;
}

/**
 * Wallets eligible to be treated as "buyers" for clustering purposes:
 * pool/vault funding and mint destinations are never bundled-buyer
 * acquisition, regardless of how large the delta was.
 */
export function eligibleBuyerWallets(acquirers: LaunchAcquirer[]): string[] {
  const wallets = new Set<string>();
  for (const a of acquirers) {
    if (!a.owner) continue;
    if (NON_BUYER_ACQUISITION_CLASSIFICATIONS.has(a.classification)) continue;
    wallets.add(a.owner);
  }
  return Array.from(wallets).sort();
}

/** Wallets whose acquisition is a `VERIFIED_BUY` — the only classification sniper-percentage evidence may use. */
export function verifiedBuyWallets(acquirers: LaunchAcquirer[]): ReadonlySet<string> {
  return new Set(acquirers.filter((a) => a.owner && a.classification === "VERIFIED_BUY").map((a) => a.owner as string));
}

export type ClusterRole = "BUNDLE" | "DEV_LINKED" | "SUSPECTED_COORDINATED" | "INDEPENDENT_SNIPER" | "INSIDER" | "UNKNOWN";

/**
 * A LIKELY_COORDINATED cluster is only ever an insider risk (not merely
 * "suspected coordination") when at least one member's acquisition carries a
 * deterministic privileged-access link — e.g. a direct token transfer
 * authorized by the developer/fee-payer (`INITIAL_DISTRIBUTION`). Coordination
 * and insider status are separate (phase5d.txt §3).
 */
export function deriveClusterRole(cluster: WalletCluster, privilegedAcquisitionWallets: ReadonlySet<string>): ClusterRole {
  switch (cluster.classification) {
    case "CONFIRMED_BUNDLE":
      return "BUNDLE";
    case "DEV_LINKED_CLUSTER":
      return "DEV_LINKED";
    case "INDEPENDENT_SNIPER":
      return "INDEPENDENT_SNIPER";
    case "LIKELY_COORDINATED":
      return cluster.memberWallets.some((w) => privilegedAcquisitionWallets.has(w)) ? "INSIDER" : "SUSPECTED_COORDINATED";
    case "UNKNOWN":
    default:
      return "UNKNOWN";
  }
}

const INDEPENDENT_NON_TIMING_TYPES: ReadonlySet<WalletRelationshipType> = new Set([
  "COMMON_FUNDER",
  "DIRECT_TRANSFER",
  "COMMON_FEE_PAYER",
  "RECURRING_COHORT",
]);

function buildRelationships(input: ClusterAnalysisInput): WalletRelationship[] {
  const relationships: WalletRelationship[] = [];
  const buyerWallets = eligibleBuyerWallets(input.acquirers);

  for (let i = 0; i < buyerWallets.length; i += 1) {
    for (let j = i + 1; j < buyerWallets.length; j += 1) {
      relationships.push({
        type: "SAME_TRANSACTION",
        wallets: [buyerWallets[i], buyerWallets[j]],
        reasonCode: "BOTH_ACQUIRED_IN_LAUNCH_TRANSACTION",
        independentSignal: true,
        evidence: input.launchSignature
          ? [
              {
                id: input.evidenceId(),
                category: "WALLET_RELATIONSHIP",
                description: `${buyerWallets[i]} and ${buyerWallets[j]} both acquired the token in the launch transaction`,
                reasonCode: "SAME_TRANSACTION",
                source: "SOLANA_STANDARD_RPC",
                signature: input.launchSignature,
                wallets: [buyerWallets[i], buyerWallets[j]],
                retrievedAt: input.now(),
              },
            ]
          : [],
      });
    }
  }

  const fundingEntries = Array.from(input.funding.entries())
    .filter(([, f]) => f.completeness === "FOUND_WITHIN_BOUND")
    .sort(([a], [b]) => a.localeCompare(b));

  for (let i = 0; i < fundingEntries.length; i += 1) {
    const [walletA, fundA] = fundingEntries[i];
    if (input.developerWallet && fundA.funderWallet === input.developerWallet) {
      relationships.push({
        type: "DEV_FUNDED",
        wallets: [walletA, input.developerWallet].sort() as [string, string],
        reasonCode: "FUNDED_DIRECTLY_BY_DEVELOPER",
        independentSignal: true,
        evidence: fundA.evidence,
      });
    }

    for (let j = i + 1; j < fundingEntries.length; j += 1) {
      const [walletB, fundB] = fundingEntries[j];

      if (fundA.funderWallet && fundA.funderWallet === fundB.funderWallet) {
        relationships.push({
          type: "COMMON_FUNDER",
          wallets: [walletA, walletB],
          reasonCode: "SHARED_FUNDING_SOURCE",
          independentSignal: true,
          evidence: [...fundA.evidence, ...fundB.evidence],
        });
      }
      // A shared fee payer on the *funding* transactions is independent of
      // the launch transaction's own (trivially shared) fee payer.
      if (fundA.feePayer && fundA.feePayer === fundB.feePayer) {
        relationships.push({
          type: "COMMON_FEE_PAYER",
          wallets: [walletA, walletB],
          reasonCode: "SHARED_FUNDING_TX_FEE_PAYER",
          independentSignal: true,
          evidence: [...fundA.evidence, ...fundB.evidence],
        });
      }
    }
  }

  return relationships;
}

function findConnectedComponents(wallets: string[], relationships: WalletRelationship[]): string[][] {
  const parent = new Map<string, string>();
  const find = (w: string): string => {
    if (!parent.has(w)) parent.set(w, w);
    let root = w;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    parent.set(w, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const w of wallets) find(w);
  for (const rel of relationships) union(rel.wallets[0], rel.wallets[1]);

  const groups = new Map<string, Set<string>>();
  for (const w of wallets) {
    const root = find(w);
    if (!groups.has(root)) groups.set(root, new Set());
    groups.get(root)?.add(w);
  }
  return Array.from(groups.values())
    .map((set) => Array.from(set).sort())
    .sort((a, b) => a[0].localeCompare(b[0]));
}

function classify(
  members: string[],
  relationships: WalletRelationship[],
  verifiedBuyers: ReadonlySet<string>
): { classification: WalletClusterClassification; confidence: number; reasonCodes: string[] } {
  const memberSet = new Set(members);
  // At least one endpoint, not both: a DEV_FUNDED edge references the
  // developer wallet, which is evidence context, not an enumerated buyer
  // member of this cluster's `memberWallets` output.
  const relevant = relationships.filter((r) => memberSet.has(r.wallets[0]) || memberSet.has(r.wallets[1]));

  const hasSameTransaction = relevant.some((r) => r.type === "SAME_TRANSACTION");
  const hasIndependentControlSignal = relevant.some(
    (r) => r.independentSignal && (r.type === "COMMON_FUNDER" || r.type === "COMMON_FEE_PAYER" || r.type === "DIRECT_TRANSFER")
  );

  if (hasSameTransaction && hasIndependentControlSignal) {
    return {
      classification: "CONFIRMED_BUNDLE",
      confidence: 0.9,
      reasonCodes: ["SAME_TRANSACTION_PLUS_INDEPENDENT_CONTROL_EVIDENCE"],
    };
  }

  const hasDevFunded = relevant.some((r) => r.type === "DEV_FUNDED" && r.independentSignal);
  if (hasDevFunded) {
    return { classification: "DEV_LINKED_CLUSTER", confidence: 0.75, reasonCodes: ["DEVELOPER_FUNDED"] };
  }

  const distinctIndependentTypes = new Set(
    relevant.filter((r) => r.independentSignal && INDEPENDENT_NON_TIMING_TYPES.has(r.type)).map((r) => r.type)
  );
  if (distinctIndependentTypes.size >= 2) {
    return {
      classification: "LIKELY_COORDINATED",
      confidence: 0.6,
      reasonCodes: Array.from(distinctIndependentTypes).sort(),
    };
  }

  // Sniper percentages require verified or sufficiently supported market
  // acquisition (phase5d.txt §1) — an isolated wallet whose acquisition
  // wasn't a VERIFIED_BUY (e.g. an unexplained token receipt) cannot be
  // confidently labeled an independent sniper.
  if (members.length === 1 && verifiedBuyers.has(members[0])) {
    return { classification: "INDEPENDENT_SNIPER", confidence: 0.5, reasonCodes: ["EARLY_VERIFIED_BUY_NO_LINKAGE_EVIDENCE"] };
  }

  return { classification: "UNKNOWN", confidence: 0.2, reasonCodes: ["INSUFFICIENT_LINKAGE_EVIDENCE"] };
}

/** Deterministic regardless of input ordering — callers must not rely on array position, only on wallet membership. */
export function buildWalletClusters(input: ClusterAnalysisInput): WalletCluster[] {
  const relationships = buildRelationships(input);
  const wallets = eligibleBuyerWallets(input.acquirers);
  // Components are formed ONLY from independent, non-timing signals.
  // SAME_TRANSACTION/SAME_SLOT/LAUNCH_WINDOW are true for every pair of
  // launch buyers by construction (they're all in the one launch tx), so
  // using them to merge components would collapse every buyer into a single
  // cluster regardless of any real relationship — exactly the false-positive
  // this module exists to prevent. Those timing signals still feed
  // `classify()` below to potentially escalate an already-evidence-linked
  // component to CONFIRMED_BUNDLE.
  const structuralTypes: ReadonlySet<WalletRelationshipType> = new Set([
    "COMMON_FUNDER",
    "COMMON_FEE_PAYER",
    "DIRECT_TRANSFER",
    "DEV_FUNDED",
  ]);
  const structuralRelationships = relationships.filter((r) => structuralTypes.has(r.type));
  const components = findConnectedComponents(wallets, structuralRelationships);
  const verifiedBuyers = verifiedBuyWallets(input.acquirers);

  const clusters: WalletCluster[] = components.map((members) => {
    const { classification, confidence, reasonCodes } = classify(members, relationships, verifiedBuyers);
    const memberSet = new Set(members);
    const clusterRelationships = relationships.filter((r) => memberSet.has(r.wallets[0]) || memberSet.has(r.wallets[1]));
    const evidence: ForensicEvidence[] = clusterRelationships.flatMap((r) => r.evidence);
    return {
      id: `cluster:${members[0]}`,
      classification,
      confidence,
      memberWallets: members,
      relationships: clusterRelationships,
      reasonCodes,
      evidence,
    };
  });

  return clusters.sort((a, b) => a.memberWallets[0].localeCompare(b.memberWallets[0]));
}
