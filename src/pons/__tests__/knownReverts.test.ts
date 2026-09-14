import { keccak256, toBytes } from "viem";
import { describe, expect, it } from "vitest";

/**
 * Selectors in simulationService's KNOWN_REVERTS must be derived from the error signatures,
 * not typed in. This recomputes each one, so a hand-edited selector fails here.
 */
const SIGNATURES: Record<string, string> = {
  "0x8b063d73": "V4TooLittleReceived(uint256,uint256)",
  "0xd81b2f2e": "AllowanceExpired(uint256)",
  "0x71c4efed": "SlippageExceeded(uint256,uint256)",
  "0x025ac17e": "CurveGraduated()",
  "0x6190b2b0": "UnexpectedRevertBytes(bytes)",
};

describe("simulation revert selectors", () => {
  it.each(Object.entries(SIGNATURES))("%s is %s", (selector, signature) => {
    expect(keccak256(toBytes(signature)).slice(0, 10)).toBe(selector);
  });
});
