/**
 * Candle-domain dbIntegration test support. Wraps src/pons/__tests__/
 * testSupport.ts's FakeChainReader (real Postgres, canned/no-network chain
 * reads — same convention as every *.dbIntegration.test.ts in this repo)
 * rather than modifying it: FakeChainReader.readContract ignores
 * `functionName` and always returns its configured
 * supply/isToken0/poolFee-shaped enrichment tuple, which the candle
 * domain's decimals() reads must not receive (a shared fixture used by
 * every Pons dbIntegration suite is not the place to add candle-specific
 * behavior — see decimalsResolver.ts's header comment for the same
 * "don't couple to the proven pipeline" reasoning).
 */
import type { Abi } from "viem";
import { ChainClientResult, ChainReader } from "../../pons/chainClient";
import { FakeChainReader } from "../../pons/__tests__/testSupport";

export class CandleFakeChainReader implements ChainReader {
  /** lowercase address -> decimals; anything not present here resolves to `defaultDecimals`. */
  decimalsByAddress = new Map<string, number | "FAIL">();
  defaultDecimals: number | "FAIL" = 18;

  constructor(private readonly inner: FakeChainReader) {}

  getBlockNumber() {
    return this.inner.getBlockNumber();
  }
  getBlockRef(blockNumber: bigint) {
    return this.inner.getBlockRef(blockNumber);
  }
  getLogs(params: Parameters<ChainReader["getLogs"]>[0]) {
    return this.inner.getLogs(params);
  }
  getTransaction(hash: string) {
    return this.inner.getTransaction(hash);
  }

  async readContract<T>(params: { address: string; abi: Abi; functionName: string; args: readonly unknown[] }): Promise<ChainClientResult<T>> {
    if (params.functionName === "decimals") {
      const resolved = this.decimalsByAddress.get(params.address.toLowerCase()) ?? this.defaultDecimals;
      if (resolved === "FAIL") {
        return { status: "UNAVAILABLE", source: "fake", fetchedAt: new Date(), code: "RPC_ERROR", reason: "simulated decimals() failure", attempts: 1 };
      }
      return { status: "AVAILABLE", data: resolved as unknown as T, source: "fake", fetchedAt: new Date(), attempts: 1 };
    }
    return this.inner.readContract<T>(params);
  }
}
