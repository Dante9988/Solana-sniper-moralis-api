#!/usr/bin/env node
/**
 * Phase 7D.3.2 §5 — export the route simulator's runtime bytecode to the backend.
 *
 * The backend sends this code in an eth_call state override. It must be exactly the code
 * test/fork/PonsRouteSimulatorFork.t.sol exercised, so it is read from the fork profile's
 * build output (out-fork), together with a hash of the source it was built from. A backend
 * test recomputes that hash, so editing the Solidity without re-exporting fails CI.
 *
 * Usage: FOUNDRY_PROFILE=fork forge build && node scripts/export-simulator.mjs
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = "evm-verification/src/PonsRouteSimulator.sol";
const source = readFileSync(join(here, "src/PonsRouteSimulator.sol"));
const artifact = JSON.parse(readFileSync(join(here, "out-fork/PonsRouteSimulator.sol/PonsRouteSimulator.json"), "utf8"));
const settings = artifact.metadata?.settings ?? {};

const out = {
  contract: "PonsRouteSimulator",
  sourcePath,
  sourceSha256: createHash("sha256").update(source).digest("hex"),
  compiler: {
    solc: artifact.metadata?.compiler?.version ?? null,
    viaIR: settings.viaIR ?? null,
    optimizerRuns: settings.optimizer?.runs ?? null,
    evmVersion: settings.evmVersion ?? null,
  },
  runtimeBytecode: artifact.deployedBytecode.object,
  abi: artifact.abi,
};

const target = join(here, "../src/pons/quote/generated/routeSimulator.json");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${target} (${(out.runtimeBytecode.length - 2) / 2} bytes, source ${out.sourceSha256.slice(0, 12)})`);
