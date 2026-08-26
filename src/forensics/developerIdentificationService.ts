/**
 * Phase 5C/5D — developer/creator identification.
 *
 * Accepts already-normalized candidate wallets as structured input (never
 * imports a network-calling intelligence worker). Corroboration is counted
 * by distinct underlying evidence ORIGIN, not by provider count — Pump.fun's
 * frontend and RugCheck may both just repeat one underlying source, so two
 * providers agreeing is not automatically two independent origins
 * (phase5d.txt §2). Preserves conflicts instead of silently picking a
 * winner; treats mint authority (and an unconfirmed third-party mirror)
 * alone as insufficient.
 */

import { ForensicEvidence } from "./types";
import { CreatorCandidate } from "./launchTransactionAnalyzer";

export type DeveloperIdentificationStatus = "IDENTIFIED" | "CONFLICTING" | "UNKNOWN";

export type CreatorEvidenceOrigin =
  | "ONCHAIN_LAUNCH_ACCOUNT"
  | "ONCHAIN_FEE_PAYER"
  | "ONCHAIN_MINT_AUTHORITY"
  | "ONCHAIN_METADATA_AUTHORITY"
  | "PUMPFUN_CREATOR_FIELD"
  | "DIRECT_FUNDING_RELATIONSHIP"
  | "THIRD_PARTY_MIRROR"
  | "UNKNOWN";

export interface DeveloperIdentificationInput {
  /** Already-normalized metadata/safety candidates from the existing intelligence layer — not fetched here. */
  pumpFunCreator?: string;
  /** RugCheck (or any third-party aggregator) is treated as a mirror of an underlying primary source, never an independently corroborating origin by itself. */
  rugCheckCreator?: string;
  metadataCreatorOrUpdateAuthority?: string;
  /** From `launchTransactionAnalyzer` — fee payer and any mint-initialization authority. */
  launchTxCandidates: CreatorCandidate[];
  /** Populated only when the caller has direct wallet-funding evidence connecting a candidate to a known launch authority. Not derived internally — Phase 5D's pipeline ordering does not yet compute this before identification runs. */
  directFundingRelationship?: { wallet: string };
}

export interface CreatorOriginProvenance {
  origin: CreatorEvidenceOrigin;
  /** The literal input field this provenance came from, for audit/debugging — never used for corroboration counting. */
  providerLabel: string;
}

export interface RankedCreatorCandidate {
  wallet: string;
  origins: CreatorEvidenceOrigin[];
  provenance: CreatorOriginProvenance[];
  corroboratingOriginCount: number;
}

export interface DeveloperIdentificationResult {
  status: DeveloperIdentificationStatus;
  developerWallet?: string;
  candidates: RankedCreatorCandidate[];
  reasonCode: string;
  evidence: ForensicEvidence[];
}

/** Origins strong enough to identify a creator on their own (uncorroborated). Mint authority and an unconfirmed third-party mirror are deliberately excluded. */
const IDENTITY_BEARING_ORIGINS: ReadonlySet<CreatorEvidenceOrigin> = new Set([
  "PUMPFUN_CREATOR_FIELD",
  "ONCHAIN_FEE_PAYER",
  "ONCHAIN_METADATA_AUTHORITY",
  "ONCHAIN_LAUNCH_ACCOUNT",
  "DIRECT_FUNDING_RELATIONSHIP",
]);

export function identifyDeveloper(
  input: DeveloperIdentificationInput,
  opts: { evidenceId: () => string; now: () => Date }
): DeveloperIdentificationResult {
  const byWallet = new Map<string, { origins: Set<CreatorEvidenceOrigin>; provenance: CreatorOriginProvenance[] }>();
  const record = (wallet: string | undefined, origin: CreatorEvidenceOrigin, providerLabel: string) => {
    if (!wallet) return;
    if (!byWallet.has(wallet)) byWallet.set(wallet, { origins: new Set(), provenance: [] });
    const entry = byWallet.get(wallet);
    if (!entry) return;
    entry.origins.add(origin);
    entry.provenance.push({ origin, providerLabel });
  };

  record(input.pumpFunCreator, "PUMPFUN_CREATOR_FIELD", "pumpFunCreator");
  record(input.rugCheckCreator, "THIRD_PARTY_MIRROR", "rugCheckCreator");
  record(input.metadataCreatorOrUpdateAuthority, "ONCHAIN_METADATA_AUTHORITY", "metadataCreatorOrUpdateAuthority");
  for (const candidate of input.launchTxCandidates) {
    record(
      candidate.wallet,
      candidate.source === "LAUNCH_TX_FEE_PAYER" ? "ONCHAIN_FEE_PAYER" : "ONCHAIN_MINT_AUTHORITY",
      `launchTxCandidates:${candidate.source}`
    );
  }
  record(input.directFundingRelationship?.wallet, "DIRECT_FUNDING_RELATIONSHIP", "directFundingRelationship");

  const candidates: RankedCreatorCandidate[] = Array.from(byWallet.entries())
    .map(([wallet, { origins, provenance }]) => ({
      wallet,
      origins: Array.from(origins).sort(),
      provenance,
      corroboratingOriginCount: origins.size,
    }))
    .sort((a, b) => b.corroboratingOriginCount - a.corroboratingOriginCount || a.wallet.localeCompare(b.wallet));

  const evidence: ForensicEvidence[] = candidates.map((c) => ({
    id: opts.evidenceId(),
    category: "CREATOR_CANDIDATE_RANKING",
    description: `${c.wallet} proposed by evidence origin(s): ${c.origins.join(", ")}`,
    reasonCode: "CREATOR_CANDIDATE",
    source: "OTHER",
    wallets: [c.wallet],
    retrievedAt: opts.now(),
  }));

  if (candidates.length === 0) {
    return { status: "UNKNOWN", candidates: [], reasonCode: "NO_CREATOR_CANDIDATES", evidence };
  }

  const top = candidates[0];

  if (top.corroboratingOriginCount >= 2) {
    return {
      status: "IDENTIFIED",
      developerWallet: top.wallet,
      candidates,
      reasonCode: "MULTIPLE_CORROBORATING_EVIDENCE_ORIGINS",
      evidence,
    };
  }

  if (candidates.length === 1) {
    const hasIdentityOrigin = top.origins.some((o) => IDENTITY_BEARING_ORIGINS.has(o));
    if (hasIdentityOrigin) {
      return {
        status: "IDENTIFIED",
        developerWallet: top.wallet,
        candidates,
        reasonCode: "SINGLE_UNCORROBORATED_IDENTITY_ORIGIN",
        evidence,
      };
    }
    return { status: "UNKNOWN", candidates, reasonCode: "INSUFFICIENT_ORIGIN_EVIDENCE", evidence };
  }

  return { status: "CONFLICTING", candidates, reasonCode: "CONFLICTING_CREATOR_CANDIDATES", evidence };
}
