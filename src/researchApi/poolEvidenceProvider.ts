/**
 * Phase 7D.3 §5 — the API's access to live pool evidence.
 *
 * Deliberately lazy and failure-tolerant. `src/pons/config.ts` states that the read-only
 * API process must be able to boot in a deployment where it does not run the ingestion
 * worker, and therefore has no `ROBINHOOD_RPC_HTTPS` / `PONS_V2_FACTORY` configured. So
 * this resolves configuration on first use and, if anything is missing, reports
 * `RPC_UNAVAILABLE` rather than throwing at startup or 500-ing per request.
 *
 * The PoolManager and MemeHook addresses are read from the factory's own view functions
 * and cached, never hardcoded — a redeployed hook would otherwise silently produce wrong
 * PoolIds, which is worse than an outage because the numbers would look plausible.
 */

import type { Abi } from "viem";

import { PONS_V2_FACTORY_ABI } from "../pons/abiV2";
import { PonsChainClient, type ChainReader } from "../pons/chainClient";
import { loadPonsV2Config, loadRobinhoodChainConfig } from "../pons/config";
import { fetchPoolEvidence, type PoolEvidenceResult } from "../pons/v4PoolEvidenceService";

export interface PoolEvidenceProvider {
  fetch(tokenAddress: string): Promise<PoolEvidenceResult>;
}

interface ResolvedWiring {
  reader: ChainReader;
  factoryAddress: string;
  poolManagerAddress: string;
  hooksAddress: string;
}

/** How long a successful address resolution is trusted before being re-read. */
const WIRING_TTL_MS = 10 * 60_000;

export function createPoolEvidenceProvider(env: NodeJS.ProcessEnv = process.env): PoolEvidenceProvider {
  let cached: { wiring: ResolvedWiring; at: number } | null = null;

  async function resolveWiring(): Promise<
    { ok: true; wiring: ResolvedWiring } | { ok: false; detail: string }
  > {
    if (cached && Date.now() - cached.at < WIRING_TTL_MS) {
      return { ok: true, wiring: cached.wiring };
    }

    let factoryAddress: string;
    let reader: ChainReader;
    try {
      factoryAddress = loadPonsV2Config(env).factoryAddress;
      reader = new PonsChainClient({ config: loadRobinhoodChainConfig(env) });
    } catch (error) {
      // Not misconfiguration in every deployment — an API-only process legitimately has
      // no chain settings. Treated as "evidence unavailable here", not as a crash.
      return { ok: false, detail: `chain access not configured: ${(error as Error).message}` };
    }

    const [poolManager, memeHook] = await Promise.all([
      reader.readContract<string>({
        address: factoryAddress,
        abi: PONS_V2_FACTORY_ABI as unknown as Abi,
        functionName: "poolManager",
        args: [],
      }),
      reader.readContract<string>({
        address: factoryAddress,
        abi: PONS_V2_FACTORY_ABI as unknown as Abi,
        functionName: "memeHook",
        args: [],
      }),
    ]);

    if (poolManager.status === "UNAVAILABLE") {
      return { ok: false, detail: `poolManager(): ${poolManager.code}: ${poolManager.reason}` };
    }
    if (memeHook.status === "UNAVAILABLE") {
      return { ok: false, detail: `memeHook(): ${memeHook.code}: ${memeHook.reason}` };
    }

    const wiring: ResolvedWiring = {
      reader,
      factoryAddress,
      poolManagerAddress: poolManager.data,
      hooksAddress: memeHook.data,
    };
    cached = { wiring, at: Date.now() };
    return { ok: true, wiring };
  }

  return {
    async fetch(tokenAddress: string): Promise<PoolEvidenceResult> {
      const resolved = await resolveWiring();
      if (!resolved.ok) {
        return { status: "UNAVAILABLE", reason: "RPC_UNAVAILABLE", detail: resolved.detail };
      }
      return fetchPoolEvidence({ ...resolved.wiring, tokenAddress });
    },
  };
}
