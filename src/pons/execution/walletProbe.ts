/**
 * Phase 7E.1 §16 — the two wallet-specific reads a plan wants: ETH balance and a gas
 * estimate.
 *
 * Deliberately NOT added to `ChainReader`. Every quote, candle and discovery path already
 * implements that interface, including several test doubles, and none of them has an
 * opinion about a wallet. Widening it to serve one caller would make every double grow two
 * methods it will never use.
 *
 * Both reads are best-effort by contract (see WalletProbe): an unavailable result means the
 * plan reports "not checked", never "failed". The chain is the real gate — it rejects an
 * underfunded or underpriced transaction regardless of what we predicted here.
 *
 * The User-Agent is not optional. `rpc-robinhood.blockmachine.io` sits behind Cloudflare,
 * which answers a request with no User-Agent with HTTP 403 / error code 1010, and viem's
 * fetch transport sends none.
 */

import { createPublicClient, defineChain, http, type Hex, type PublicClient } from "viem";

import { RPC_USER_AGENT, type ChainClientResult } from "../chainClient";
import type { RobinhoodChainConfig } from "../config";
import { redactRpcUrls, resolveHttpEndpoints } from "../rpcEndpoints";
import type { WalletProbe } from "./venue";

const SOURCE = "robinhood-chain-rpc";

function unavailable<T>(reason: string): ChainClientResult<T> {
  // Provider errors embed the request URL, and that URL carries the API key.
  return { status: "UNAVAILABLE", source: SOURCE, fetchedAt: new Date(), code: "RPC_ERROR", reason: redactRpcUrls(reason), attempts: 1 };
}

function available<T>(data: T): ChainClientResult<T> {
  return { status: "AVAILABLE", data, source: SOURCE, fetchedAt: new Date(), attempts: 1 };
}

export interface WalletProbeOptions {
  config: RobinhoodChainConfig;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Test seam. */
  client?: PublicClient;
}

/**
 * One client, first configured endpoint.
 *
 * No failover: a probe that cannot answer degrades to "not checked", so cascading through
 * every endpoint would spend the scarce RPC budget on a read whose absence costs nothing.
 */
export function createWalletProbe(options: WalletProbeOptions): WalletProbe {
  const endpoints = resolveHttpEndpoints(options.env ?? process.env);
  const url = endpoints[0]?.url ?? options.config.rpcHttpUrl;

  const client =
    options.client ??
    (createPublicClient({
      chain: defineChain({
        id: options.config.chainId,
        name: "Robinhood Chain",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [url] } },
      }),
      transport: http(url, { timeout: options.timeoutMs ?? 6_000, fetchOptions: { headers: { "User-Agent": RPC_USER_AGENT } } }),
    }) as PublicClient);

  return {
    async getBalance(address) {
      try {
        return available(await client.getBalance({ address: address as Hex }));
      } catch (error) {
        return unavailable<bigint>((error as Error).message);
      }
    },
    async estimateGas(params) {
      try {
        const gas = await client.estimateGas({
          account: params.from as Hex,
          to: params.to as Hex,
          data: params.data,
          value: params.value,
        });
        return available(gas);
      } catch (error) {
        // Expected whenever an approval has not been signed yet, which is most of the time
        // at build. Not an error worth logging loudly.
        return unavailable<bigint>((error as Error).message);
      }
    },
  };
}
