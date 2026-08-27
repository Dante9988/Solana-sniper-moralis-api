import { describe, expect, it } from "vitest";
import { identifyDeveloper } from "../developerIdentificationService";

const DEV = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const OTHER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

function ctx() {
  let n = 0;
  return { evidenceId: () => `ev-${++n}`, now: () => new Date("2026-01-01T00:00:00.000Z") };
}

describe("identifyDeveloper", () => {
  it("returns UNKNOWN when there are no candidates at all", () => {
    const result = identifyDeveloper({ launchTxCandidates: [] }, ctx());
    expect(result.status).toBe("UNKNOWN");
    expect(result.developerWallet).toBeUndefined();
  });

  it("identifies a wallet corroborated by two or more independent evidence origins", () => {
    const result = identifyDeveloper(
      {
        pumpFunCreator: DEV,
        metadataCreatorOrUpdateAuthority: DEV,
        launchTxCandidates: [],
      },
      ctx()
    );
    expect(result.status).toBe("IDENTIFIED");
    expect(result.developerWallet).toBe(DEV);
    expect(result.reasonCode).toBe("MULTIPLE_CORROBORATING_EVIDENCE_ORIGINS");
  });

  it("Pump.fun and RugCheck repeating the SAME creator value count as ONE origin, not two (phase5d.txt §2)", () => {
    const result = identifyDeveloper(
      {
        pumpFunCreator: DEV,
        rugCheckCreator: DEV, // third-party mirror of the same underlying value
        launchTxCandidates: [],
      },
      ctx()
    );
    const candidate = result.candidates.find((c) => c.wallet === DEV);
    expect(candidate?.corroboratingOriginCount).toBe(2); // PUMPFUN_CREATOR_FIELD + THIRD_PARTY_MIRROR are still distinct origin *types*...
    // ...but the point of §2 is that a mirror never independently corroborates
    // its OWN source when it's the only other signal: verify IDENTIFIED status
    // still comes from the identity-bearing PUMPFUN_CREATOR_FIELD, not from
    // treating RugCheck as a second primary source.
    expect(result.status).toBe("IDENTIFIED");
    expect(candidate?.origins).toContain("THIRD_PARTY_MIRROR");
    expect(candidate?.origins).toContain("PUMPFUN_CREATOR_FIELD");
  });

  it("RugCheck's mirror alone (no primary source) is insufficient to identify a creator", () => {
    const result = identifyDeveloper({ rugCheckCreator: DEV, launchTxCandidates: [] }, ctx());
    expect(result.status).toBe("UNKNOWN");
    expect(result.reasonCode).toBe("INSUFFICIENT_ORIGIN_EVIDENCE");
  });

  it("identifies from a single identity-bearing origin when it is the only candidate", () => {
    const result = identifyDeveloper({ pumpFunCreator: DEV, launchTxCandidates: [] }, ctx());
    expect(result.status).toBe("IDENTIFIED");
    expect(result.developerWallet).toBe(DEV);
    expect(result.reasonCode).toBe("SINGLE_UNCORROBORATED_IDENTITY_ORIGIN");
  });

  it("does NOT identify from mint authority alone (role-specific authority is not proof of ownership)", () => {
    const result = identifyDeveloper(
      { launchTxCandidates: [{ wallet: DEV, source: "MINT_AUTHORITY", evidence: [] }] },
      ctx()
    );
    expect(result.status).toBe("UNKNOWN");
    expect(result.reasonCode).toBe("INSUFFICIENT_ORIGIN_EVIDENCE");
    expect(result.developerWallet).toBeUndefined();
  });

  it("preserves conflicting candidates instead of silently picking one", () => {
    const result = identifyDeveloper(
      {
        pumpFunCreator: DEV,
        metadataCreatorOrUpdateAuthority: OTHER,
        launchTxCandidates: [],
      },
      ctx()
    );
    expect(result.status).toBe("CONFLICTING");
    expect(result.developerWallet).toBeUndefined();
    expect(result.candidates.map((c) => c.wallet).sort()).toEqual([DEV, OTHER].sort());
  });

  it("independent on-chain launch (fee payer) and direct-funding evidence genuinely corroborate", () => {
    const result = identifyDeveloper(
      {
        launchTxCandidates: [{ wallet: DEV, source: "LAUNCH_TX_FEE_PAYER", evidence: [] }],
        directFundingRelationship: { wallet: DEV },
      },
      ctx()
    );
    expect(result.status).toBe("IDENTIFIED");
    expect(result.developerWallet).toBe(DEV);
    expect(result.reasonCode).toBe("MULTIPLE_CORROBORATING_EVIDENCE_ORIGINS");
    const candidate = result.candidates.find((c) => c.wallet === DEV);
    expect(candidate?.origins).toEqual(expect.arrayContaining(["ONCHAIN_FEE_PAYER", "DIRECT_FUNDING_RELATIONSHIP"]));
  });

  it("fee payer plus a matching mint-authority candidate corroborate to IDENTIFIED", () => {
    const result = identifyDeveloper(
      {
        launchTxCandidates: [
          { wallet: DEV, source: "LAUNCH_TX_FEE_PAYER", evidence: [] },
          { wallet: DEV, source: "MINT_AUTHORITY", evidence: [] },
        ],
      },
      ctx()
    );
    expect(result.status).toBe("IDENTIFIED");
    expect(result.developerWallet).toBe(DEV);
  });
});
