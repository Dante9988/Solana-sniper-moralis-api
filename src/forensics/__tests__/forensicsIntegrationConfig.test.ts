import { describe, expect, it } from "vitest";
import {
  isForensicsAiResynthesisEnabled,
  isForensicsEnqueueEnabled,
  isForensicsReconciliationEnabled,
} from "../forensicsIntegrationConfig";
import { ForensicsConfigError } from "../thresholds";

describe("Phase 5E feature flags — default to disabled", () => {
  it("all three flags default to false when unset", () => {
    expect(isForensicsEnqueueEnabled({})).toBe(false);
    expect(isForensicsReconciliationEnabled({})).toBe(false);
    expect(isForensicsAiResynthesisEnabled({})).toBe(false);
  });

  it("each flag can be explicitly enabled", () => {
    expect(isForensicsEnqueueEnabled({ FORENSICS_ENQUEUE_ENABLED: "true" })).toBe(true);
    expect(isForensicsReconciliationEnabled({ FORENSICS_RECONCILIATION_ENABLED: "true" })).toBe(true);
    expect(isForensicsAiResynthesisEnabled({ FORENSICS_AI_RESYNTHESIS_ENABLED: "true" })).toBe(true);
  });

  it("fails closed on a non-strict boolean value", () => {
    expect(() => isForensicsEnqueueEnabled({ FORENSICS_ENQUEUE_ENABLED: "yes" })).toThrow(ForensicsConfigError);
    expect(() => isForensicsReconciliationEnabled({ FORENSICS_RECONCILIATION_ENABLED: "1" })).toThrow(ForensicsConfigError);
  });
});
