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
import { fetchMarketEvidence, type MarketEvidenceOutcome } from "../pons/quote/marketEvidenceService";

export interface QuoteEngine {
  quote(request: QuoteRequest): Promise<QuoteOutcome>;
  simulate(quote: PonsQuote): Promise<SimulationOutcome>;
  marketEvidence(tokenAddress: string): Promise<MarketEvidenceOutcome>;
}

/**
 * The terminal polls market evidence. Several viewers of one token would otherwise each
 * cost a full pinned read group, so results are shared for a few seconds and concurrent
 * requests join the one in flight. `observedAt` inside the evidence always reports when the
 * chain was actually read, so a cached answer never masquerades as a fresh one.
 */
export const MARKET_EVIDENCE_CACHE_MS = 8_000;

export function createQuoteEngine(env: NodeJS.ProcessEnv = process.env): QuoteEngine {
  let wiring: { caller: ChainCaller; factoryAddress: string } | null = null;
  const evidenceCache = new Map<string, { at: number; value: Promise<MarketEvidenceOutcome> }>();
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
    async marketEvidence(tokenAddress) {
      const w = resolve();
      if (!w) return { status: "UNAVAILABLE", reason: "RPC_UNAVAILABLE", detail: `chain access not configured: ${wiringError}` };
      const key = tokenAddress.toLowerCase();
      const hit = evidenceCache.get(key);
      if (hit && Date.now() - hit.at < MARKET_EVIDENCE_CACHE_MS) return hit.value;
      const value = fetchMarketEvidence(key, { caller: w.caller, factoryAddress: w.factoryAddress });
      evidenceCache.set(key, { at: Date.now(), value });
      // An outage must not be served from cache after it clears.
      value.then((v) => v.status === "UNAVAILABLE" && evidenceCache.delete(key)).catch(() => evidenceCache.delete(key));
      if (evidenceCache.size > 500) evidenceCache.delete(evidenceCache.keys().next().value as string);
      return value;
    },
  };
}
