/**
 * Phase 7D.3.2 §5 — the API's access to quoting and simulation.
 *
 * Same discipline as poolEvidenceProvider.ts: resolved lazily, so an API-only deployment
 * without chain settings still boots, and every missing dependency becomes a structured
 * UNAVAILABLE result rather than a crash or a 500. One FailoverChainClient is shared by
 * quotes and simulations so endpoint health and cooldowns are learned once.
 */

import type { ChainCaller } from "../pons/chainClient";
import { loadPonsV2Config, loadRobinhoodChainConfig } from "../pons/config";
import { FailoverChainClient } from "../pons/failoverChainClient";
import { quotePonsV2, type PonsQuote, type QuoteOutcome, type QuoteRequest } from "../pons/quote/quoteService";
import { simulateQuote, type SimulationOutcome } from "../pons/quote/simulationService";

export interface QuoteEngine {
  quote(request: QuoteRequest): Promise<QuoteOutcome>;
  simulate(quote: PonsQuote): Promise<SimulationOutcome>;
}

export function createQuoteEngine(env: NodeJS.ProcessEnv = process.env): QuoteEngine {
  let wiring: { caller: ChainCaller; factoryAddress: string } | null = null;
  let wiringError: string | null = null;

  function resolve(): { caller: ChainCaller; factoryAddress: string } | null {
    if (wiring) return wiring;
    try {
      wiring = {
        caller: new FailoverChainClient({ config: loadRobinhoodChainConfig(env), env }),
        factoryAddress: loadPonsV2Config(env).factoryAddress,
      };
      wiringError = null;
      return wiring;
    } catch (error) {
      wiringError = (error as Error).message;
      return null;
    }
  }

  return {
    async quote(request) {
      const w = resolve();
      if (!w) return { status: "UNAVAILABLE", reason: "RPC_UNAVAILABLE", detail: `chain access not configured: ${wiringError}` };
      return quotePonsV2(request, { caller: w.caller, factoryAddress: w.factoryAddress });
    },
    async simulate(quote) {
      const w = resolve();
      if (!w) return { status: "UNAVAILABLE", reason: "RPC_UNAVAILABLE", detail: `chain access not configured: ${wiringError}` };
      return simulateQuote(quote, { caller: w.caller });
    },
  };
}
