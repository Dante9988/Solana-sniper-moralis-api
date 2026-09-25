/**
 * Phase 7E.1 — the API's access to transaction building.
 *
 * Same discipline as quoteEngineProvider: resolved lazily so an API-only deployment
 * without chain settings still boots, and every missing dependency becomes a structured
 * result rather than a 500.
 *
 * §20 is enforced here rather than in the route, so every future caller inherits it: with
 * `REAL_TRADING_ENABLED` off, or this venue not listed, no calldata is produced at all.
 * A refusal at the route only would leave the next endpoint to remember.
 */

import type { ChainCaller } from "../pons/chainClient";
import { loadPonsV2Config, loadRobinhoodChainConfig } from "../pons/config";
import { selectRoute } from "../pons/execution/registry";
import type { BuildOutcome, WalletProbe } from "../pons/execution/venue";
import { createWalletProbe } from "../pons/execution/walletProbe";
import { FailoverChainClient } from "../pons/failoverChainClient";
import type { PonsQuote } from "../pons/quote/quoteService";
import type { RealTradingConfig } from "./config";

export interface ExecutionEngine {
  buildTransaction(params: { quote: PonsQuote; walletAddress: string }): Promise<BuildOutcome>;
}

export function createExecutionEngine(realTrading: RealTradingConfig, env: NodeJS.ProcessEnv = process.env): ExecutionEngine {
  let wiring: { caller: ChainCaller; probe: WalletProbe } | null = null;
  let wiringError: string | null = null;

  function resolve(): { caller: ChainCaller; probe: WalletProbe } | null {
    if (wiring) return wiring;
    try {
      const config = loadRobinhoodChainConfig(env);
      // Loaded for its side effect of validating Pons configuration before any build.
      loadPonsV2Config(env);
      wiring = { caller: new FailoverChainClient({ config, env }), probe: createWalletProbe({ config, env }) };
      wiringError = null;
      return wiring;
    } catch (error) {
      wiringError = (error as Error).message;
      return null;
    }
  }

  return {
    async buildTransaction({ quote, walletAddress }) {
      if (!realTrading.enabled) {
        return {
          status: "REFUSED",
          reason: "REAL_TRADING_DISABLED",
          detail: "real trading is not enabled on this server; practice trading is unaffected",
        };
      }

      const selection = selectRoute(quote);
      if (selection.status !== "SELECTED") {
        return { status: "REFUSED", reason: "UNSUPPORTED_ROUTE", detail: selection.detail };
      }
      if (!realTrading.venues.has(selection.venue.id)) {
        return {
          status: "REFUSED",
          reason: "REAL_TRADING_DISABLED",
          detail: `real trading is not enabled for ${selection.venue.id} on this server`,
        };
      }

      const w = resolve();
      if (!w) return { status: "UNAVAILABLE", reason: "RPC_UNAVAILABLE", detail: `chain access not configured: ${wiringError}` };
      return selection.venue.buildTransaction({ quote, walletAddress }, { caller: w.caller, probe: w.probe });
    },
  };
}
