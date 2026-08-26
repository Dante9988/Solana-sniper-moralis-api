import { describe, expect, it } from "vitest";
import { buildWalletClusters, deriveClusterRole } from "../walletClusterService";
import { WalletFundingEvidence } from "../walletFundingAnalyzer";
import { LaunchAcquirer, LaunchAcquisitionClassification } from "../launchTransactionAnalyzer";
import { WalletCluster } from "../types";

const A = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const B = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const C = "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS";
const FUNDER = "8UviNr47S8eL32qUyVjaB1Diveh1KYtmx4Pe2YnjhZDL";
const DEV = "AVmDft8deQEo78bRKcGN5ZMf3hyjeLBK4Rd4xVfUdCFM";

function ctx() {
  let n = 0;
  return { evidenceId: () => `ev-${++n}`, now: () => new Date("2026-01-01T00:00:00.000Z") };
}

function acquirer(owner: string, amount: bigint, classification: LaunchAcquisitionClassification = "VERIFIED_BUY"): LaunchAcquirer {
  return { owner, tokenAccount: `${owner}-tokacct`, acquiredAmountRaw: amount.toString(), classification, evidence: [] };
}

function noFunding(wallets: string[]): Map<string, WalletFundingEvidence> {
  const map = new Map<string, WalletFundingEvidence>();
  for (const w of wallets) map.set(w, { recipientWallet: w, completeness: "NOT_FOUND_WITHIN_BOUND", evidence: [], warnings: [] });
  return map;
}

function fundedBy(wallet: string, funder: string, feePayer?: string): WalletFundingEvidence {
  return { recipientWallet: wallet, funderWallet: funder, completeness: "FOUND_WITHIN_BOUND", feePayer, evidence: [], warnings: [] };
}

describe("buildWalletClusters — false-positive controls", () => {
  it("same-transaction-only buyers, with no other evidence, never merge into one cluster or become CONFIRMED_BUNDLE from timing alone", () => {
    const clusters = buildWalletClusters({
      launchSignature: "sig1",
      acquirers: [acquirer(A, 10n), acquirer(B, 10n)],
      funding: noFunding([A, B]),
      ...ctx(),
    });
    expect(clusters).toHaveLength(2);
    for (const cluster of clusters) {
      expect(cluster.classification).toBe("INDEPENDENT_SNIPER");
      expect(cluster.classification).not.toBe("CONFIRMED_BUNDLE");
    }
  });

  it("SAME_TRANSACTION plus an independent common-funder signal yields CONFIRMED_BUNDLE", () => {
    const funding = new Map<string, WalletFundingEvidence>();
    funding.set(A, fundedBy(A, FUNDER));
    funding.set(B, fundedBy(B, FUNDER));
    const clusters = buildWalletClusters({
      launchSignature: "sig1",
      acquirers: [acquirer(A, 10n), acquirer(B, 10n)],
      funding,
      ...ctx(),
    });
    expect(clusters[0].classification).toBe("CONFIRMED_BUNDLE");
    expect(clusters[0].reasonCodes).toContain("SAME_TRANSACTION_PLUS_INDEPENDENT_CONTROL_EVIDENCE");
  });

  it("never claims a confirmed Jito bundle from slot/transaction adjacency alone (reasonCodes never claim Jito)", () => {
    const clusters = buildWalletClusters({
      launchSignature: "sig1",
      acquirers: [acquirer(A, 10n), acquirer(B, 10n)],
      funding: noFunding([A, B]),
      ...ctx(),
    });
    expect(JSON.stringify(clusters)).not.toMatch(/jito/i);
  });

  it("a common fee payer that is only common because of SAME_TRANSACTION does not, by itself, upgrade to CONFIRMED_BUNDLE", () => {
    const funding = new Map<string, WalletFundingEvidence>();
    funding.set(A, fundedBy(A, "FunderA1111111111111111111111111111111111", "FeePayerA111111111111111111111111111111"));
    funding.set(B, fundedBy(B, "FunderB1111111111111111111111111111111111", "FeePayerB111111111111111111111111111111"));
    const clusters = buildWalletClusters({
      launchSignature: "sig1",
      acquirers: [acquirer(A, 10n), acquirer(B, 10n)],
      funding,
      ...ctx(),
    });
    expect(clusters).toHaveLength(2);
    for (const cluster of clusters) expect(cluster.classification).not.toBe("CONFIRMED_BUNDLE");
  });

  it("developer-funded wallet forms a DEV_LINKED_CLUSTER", () => {
    const funding = new Map<string, WalletFundingEvidence>();
    funding.set(A, fundedBy(A, DEV));
    const clusters = buildWalletClusters({
      launchSignature: "sig1",
      acquirers: [acquirer(A, 10n)],
      funding,
      developerWallet: DEV,
      ...ctx(),
    });
    const clusterWithA = clusters.find((c) => c.memberWallets.includes(A));
    expect(clusterWithA?.classification).toBe("DEV_LINKED_CLUSTER");
  });

  it("developer funding alone does not automatically prove a launch bundle (stays DEV_LINKED_CLUSTER, not CONFIRMED_BUNDLE)", () => {
    const funding = new Map<string, WalletFundingEvidence>();
    funding.set(A, fundedBy(A, DEV));
    const clusters = buildWalletClusters({
      launchSignature: "sig1",
      acquirers: [acquirer(A, 10n)],
      funding,
      developerWallet: DEV,
      ...ctx(),
    });
    const clusterWithA = clusters.find((c) => c.memberWallets.includes(A));
    expect(clusterWithA?.classification).not.toBe("CONFIRMED_BUNDLE");
  });

  it("SAME_TRANSACTION plus COMMON_FUNDER between two launch co-buyers escalates to CONFIRMED_BUNDLE", () => {
    const funding = new Map<string, WalletFundingEvidence>();
    funding.set(B, fundedBy(B, FUNDER));
    funding.set(C, fundedBy(C, FUNDER));
    const clusters = buildWalletClusters({
      launchSignature: "sig1",
      acquirers: [acquirer(B, 10n), acquirer(C, 10n)],
      funding,
      ...ctx(),
    });
    expect(clusters[0].classification).toBe("CONFIRMED_BUNDLE");
  });

  it("isolated early VERIFIED_BUY buyer with no relationship evidence is classified INDEPENDENT_SNIPER", () => {
    const clusters = buildWalletClusters({
      launchSignature: "sig1",
      acquirers: [acquirer(A, 10n, "VERIFIED_BUY")],
      funding: noFunding([A]),
      ...ctx(),
    });
    expect(clusters[0].classification).toBe("INDEPENDENT_SNIPER");
  });

  it("an isolated wallet whose acquisition was NOT a verified buy stays UNKNOWN, never INDEPENDENT_SNIPER", () => {
    const clusters = buildWalletClusters({
      launchSignature: "sig1",
      acquirers: [acquirer(A, 10n, "TOKEN_RECEIPT")],
      funding: noFunding([A]),
      ...ctx(),
    });
    expect(clusters[0].classification).toBe("UNKNOWN");
  });

  it("pool/vault funding and mint-destination acquisitions never enter clustering at all", () => {
    const clusters = buildWalletClusters({
      launchSignature: "sig1",
      acquirers: [acquirer(A, 10n, "POOL_OR_VAULT_FUNDING"), acquirer(B, 10n, "MINT_DESTINATION")],
      funding: noFunding([A, B]),
      ...ctx(),
    });
    expect(clusters).toHaveLength(0);
  });

  it("a funder found for only one of two co-buyers creates no relationship between them (no false COMMON_FUNDER)", () => {
    const funding = new Map<string, WalletFundingEvidence>();
    funding.set(A, fundedBy(A, FUNDER));
    const clusters = buildWalletClusters({
      launchSignature: "sig1",
      acquirers: [acquirer(A, 10n), acquirer(B, 10n)],
      funding,
      ...ctx(),
    });
    expect(clusters).toHaveLength(2);
    for (const cluster of clusters) expect(cluster.classification).not.toBe("CONFIRMED_BUNDLE");
  });

  it("is deterministic regardless of acquirers input ordering", () => {
    const funding = new Map<string, WalletFundingEvidence>();
    funding.set(A, fundedBy(A, FUNDER));
    funding.set(B, fundedBy(B, FUNDER));
    const forward = buildWalletClusters({
      launchSignature: "sig1",
      acquirers: [acquirer(A, 10n), acquirer(B, 20n)],
      funding,
      ...ctx(),
    });
    const reversed = buildWalletClusters({
      launchSignature: "sig1",
      acquirers: [acquirer(B, 20n), acquirer(A, 10n)],
      funding,
      ...ctx(),
    });
    expect(forward.map((c) => ({ classification: c.classification, memberWallets: c.memberWallets }))).toEqual(
      reversed.map((c) => ({ classification: c.classification, memberWallets: c.memberWallets }))
    );
  });
});

describe("deriveClusterRole — coordination is not automatically insider status (phase5d.txt §3)", () => {
  function makeLikelyCoordinatedCluster(members: string[]): WalletCluster {
    return { id: "c1", classification: "LIKELY_COORDINATED", confidence: 0.6, memberWallets: members, relationships: [], reasonCodes: [], evidence: [] };
  }

  it("a LIKELY_COORDINATED cluster with no privileged-access link is SUSPECTED_COORDINATED, not INSIDER", () => {
    const cluster = makeLikelyCoordinatedCluster([A, B]);
    expect(deriveClusterRole(cluster, new Set())).toBe("SUSPECTED_COORDINATED");
  });

  it("a LIKELY_COORDINATED cluster with a privileged (INITIAL_DISTRIBUTION) member is INSIDER", () => {
    const cluster = makeLikelyCoordinatedCluster([A, B]);
    expect(deriveClusterRole(cluster, new Set([A]))).toBe("INSIDER");
  });

  it("maps CONFIRMED_BUNDLE/DEV_LINKED_CLUSTER/INDEPENDENT_SNIPER/UNKNOWN to their direct role counterparts", () => {
    const base = { id: "c", confidence: 0.5, memberWallets: [A], relationships: [], reasonCodes: [], evidence: [] };
    expect(deriveClusterRole({ ...base, classification: "CONFIRMED_BUNDLE" }, new Set())).toBe("BUNDLE");
    expect(deriveClusterRole({ ...base, classification: "DEV_LINKED_CLUSTER" }, new Set())).toBe("DEV_LINKED");
    expect(deriveClusterRole({ ...base, classification: "INDEPENDENT_SNIPER" }, new Set())).toBe("INDEPENDENT_SNIPER");
    expect(deriveClusterRole({ ...base, classification: "UNKNOWN" }, new Set())).toBe("UNKNOWN");
  });
});
