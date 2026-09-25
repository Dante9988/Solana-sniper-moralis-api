import { afterEach, describe, expect, it } from "vitest";

import { loopEnabled } from "../scripts/ponsWorkerMain";

/**
 * Phase 7D.5 — the Pons V1 loops can be paused locally to measure what they cost the one
 * usable wide-range RPC endpoint, and to stand them down while V1 is dormant.
 *
 * The property that matters most is the default: an existing deployment that sets none of
 * these variables must behave exactly as it did before. Pausing must never be something
 * that happens by accident, and it never touches a checkpoint, so re-enabling resumes from
 * where the loop stopped.
 */
const NAME = "PONS_TEST_LOOP_SWITCH";

afterEach(() => {
  delete process.env[NAME];
});

describe("V1 loop switches", () => {
  it("defaults to enabled when unset — existing deployments are unchanged", () => {
    delete process.env[NAME];
    expect(loopEnabled(NAME)).toBe(true);
  });

  it("treats an empty or whitespace value as unset, not as a pause", () => {
    for (const value of ["", "   "]) {
      process.env[NAME] = value;
      expect(loopEnabled(NAME), `value ${JSON.stringify(value)}`).toBe(true);
    }
  });

  it.each(["false", "FALSE", "False", "0", "off", "OFF", "no"])("pauses on %s", (value) => {
    process.env[NAME] = value;
    expect(loopEnabled(NAME)).toBe(false);
  });

  it.each(["true", "1", "on", "yes", "anything-else"])("stays enabled on %s", (value) => {
    process.env[NAME] = value;
    expect(loopEnabled(NAME)).toBe(true);
  });
});
