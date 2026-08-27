/**
 * Phase 5C — a fake `ForensicsRpcClient` for analyzer/orchestrator tests.
 * Never touches `fetch`, Helius, or Solana RPC. Any method not stubbed
 * throws, so an unexpected call fails the test loudly instead of silently
 * returning a misleading default.
 */

import { ForensicsRpcClient } from "../solanaForensicsClient";

export type FakeClientStubs = Partial<{
  [K in keyof ForensicsRpcClient]: ForensicsRpcClient[K];
}>;

function notStubbed(name: string) {
  return async () => {
    throw new Error(`fake ForensicsRpcClient: "${name}" was called but not stubbed for this test`);
  };
}

export function makeFakeClient(stubs: FakeClientStubs): ForensicsRpcClient {
  const methodNames: (keyof ForensicsRpcClient)[] = [
    "getTokenAccountsByMint",
    "getTokenAccountsPaginated",
    "getTransactionsForAddress",
    "getTransactionsForAddressPaginated",
    "getTransaction",
    "getSignaturesForAddress",
    "getTokenSupply",
    "getTokenLargestAccounts",
    "getAccountInfo",
    "getMultipleAccounts",
  ];
  const client = {} as ForensicsRpcClient;
  for (const name of methodNames) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any)[name] = stubs[name] ?? notStubbed(name);
  }
  return client;
}
