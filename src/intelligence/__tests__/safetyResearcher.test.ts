import { beforeEach, describe, expect, it, vi } from "vitest";
import { pumpfunEvent } from "./fixtures/syntheticEvents";
import { cleanRugCheckReport, ruggedRugCheckReport } from "./fixtures/syntheticRugCheckReport";

vi.mock("../../services/safetyCheckService", () => ({
  fetchRugCheckReport: vi.fn(),
  fetchSolSnifferReport: vi.fn(),
}));

import { fetchRugCheckReport, fetchSolSnifferReport } from "../../services/safetyCheckService";
import { safetyResearcher } from "../workers/safetyResearcher";

const mockedFetchRugCheckReport = vi.mocked(fetchRugCheckReport);
const mockedFetchSolSnifferReport = vi.mocked(fetchSolSnifferReport);

describe("safetyResearcher", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("reports no risk factors and full confidence for a clean token with both sources", async () => {
    mockedFetchRugCheckReport.mockResolvedValue(cleanRugCheckReport);
    mockedFetchSolSnifferReport.mockResolvedValue({
      auditRisk: { mintDisabled: true, freezeDisabled: true, lpBurned: true },
      raw: {},
    });

    const result = await safetyResearcher(pumpfunEvent);

    expect(result.fatal).toBeUndefined();
    expect(result.data.riskFactors).toHaveLength(0);
    expect(result.data.confidence).toBe(1);
    expect(result.data.mintAuthority).toBeUndefined();
    expect(result.data.freezeAuthority).toBeUndefined();
  });

  it("flags risk factors for a rugged token", async () => {
    mockedFetchRugCheckReport.mockResolvedValue(ruggedRugCheckReport);
    mockedFetchSolSnifferReport.mockResolvedValue(null);

    const result = await safetyResearcher(pumpfunEvent);

    expect(result.fatal).toBeUndefined();
    expect(result.data.mintAuthority).toBe("SomeMintAuthority");
    expect(result.data.freezeAuthority).toBe("SomeFreezeAuthority");
    expect(result.data.riskFactors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Mint authority is not renounced"),
        expect.stringContaining("Freeze authority is not renounced"),
        expect.stringContaining("Token metadata is mutable"),
        expect.stringContaining("RugCheck flags this token as rugged"),
      ])
    );
    expect(result.data.topHolderConcentrationPct).toBe(40);
    expect(result.data.confidence).toBe(0.5); // only one of two sources available
  });

  it("returns fatal when both sources are unavailable", async () => {
    mockedFetchRugCheckReport.mockResolvedValue(null);
    mockedFetchSolSnifferReport.mockResolvedValue(null);

    const result = await safetyResearcher(pumpfunEvent);

    expect(result.fatal).toBeDefined();
    expect(result.data.confidence).toBe(0);
  });

  it("never claims a token is safe -- absence of risk factors is not a verdict", async () => {
    mockedFetchRugCheckReport.mockResolvedValue(cleanRugCheckReport);
    mockedFetchSolSnifferReport.mockResolvedValue(null);

    const result = await safetyResearcher(pumpfunEvent);

    // Partial evidence: risk factors may be empty, but confidence reflects
    // that only one of two sources was actually checked.
    expect(result.data.confidence).toBeLessThan(1);
  });
});
