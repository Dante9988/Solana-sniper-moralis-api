import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import artifact from "../quote/generated/routeSimulator.json";

/**
 * The backend sends generated/routeSimulator.json's bytecode in eth_call state overrides.
 * It must be built from the Solidity the fork suite verified. Editing the contract without
 * re-running `FOUNDRY_PROFILE=fork forge build && node scripts/export-simulator.mjs` fails here.
 */
describe("route simulator artifact", () => {
  it("was exported from the current evm-verification/src/PonsRouteSimulator.sol", () => {
    const source = readFileSync(join(__dirname, "../../../evm-verification/src/PonsRouteSimulator.sol"));
    expect(createHash("sha256").update(source).digest("hex")).toBe(artifact.sourceSha256);
  });

  it("was compiled with the fork profile's settings and exposes the simulator entrypoints", () => {
    expect(artifact.compiler).toMatchObject({ solc: expect.stringMatching(/^0\.8\.26/), viaIR: true, optimizerRuns: 44444444, evmVersion: "cancun" });
    expect(artifact.runtimeBytecode).toMatch(/^0x[0-9a-f]+$/);
    const names = (artifact.abi as { name?: string }[]).map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(["simulateRouter", "simulateCurveBuy", "simulateCurveSell"]));
  });
});
