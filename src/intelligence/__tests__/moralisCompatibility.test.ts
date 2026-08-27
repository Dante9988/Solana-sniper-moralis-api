import axios from "axios";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  getMoralisMetadata,
  getMoralisPairStats,
  getMoralisPairs,
  getMoralisPrice,
  getMoralisSwaps,
  removedMoralisEndpoint,
} from "../../services/moralisClient";
import { fetchSniperData } from "../../services/sniperDataService";
import { bundleSniperResearcher } from "../workers/bundleSniperResearcher";
import { pumpfunEvent } from "./fixtures/syntheticEvents";

const get = vi.spyOn(axios, "get");
const response = (data: unknown) => ({ data, status: 200, statusText: "OK", headers: {}, config: {} } as any);
const httpError = (status: number, code?: string) => Object.assign(new Error(`HTTP ${status}`), {
  isAxiosError: true, code, response: { status, data: {} }, config: {}, toJSON: () => ({}),
});

afterEach(() => get.mockReset());

describe("Moralis Phase 3.1 compatibility", () => {
  it("uses current metadata, price, swap, pair, and pair-stats URLs and X-Api-Key", async () => {
    get
      .mockResolvedValueOnce(response({ mint: "mint", name: null, metaplex: null }))
      .mockResolvedValueOnce(response({ usdPrice: 1 }))
      .mockResolvedValueOnce(response({ cursor: null, result: [] }))
      .mockResolvedValueOnce(response({ cursor: null, pairs: [{ pairAddress: "pair" }] }))
      .mockResolvedValueOnce(response({ pairAddress: "pair", currentUsdPrice: null }));
    await getMoralisMetadata("mint"); await getMoralisPrice("mint"); await getMoralisSwaps("mint");
    await getMoralisPairs("mint"); await getMoralisPairStats("pair");
    expect(get.mock.calls.map(([url]) => url)).toEqual([
      "https://solana-gateway.moralis.io/token/mainnet/mint/metadata",
      "https://solana-gateway.moralis.io/token/mainnet/mint/price",
      "https://solana-gateway.moralis.io/token/mainnet/mint/swaps?order=DESC&limit=10",
      "https://solana-gateway.moralis.io/token/mainnet/mint/pairs?limit=50",
      "https://solana-gateway.moralis.io/token/mainnet/pairs/pair/stats",
    ]);
    expect(get.mock.calls[0][1]?.headers).toHaveProperty("X-Api-Key");
  });

  it.each([[401, "AUTHENTICATION_FAILED"], [403, "PERMISSION_DENIED"], [404, "TOKEN_NOT_FOUND"]])(
    "classifies HTTP %s without retry", async (status, code) => {
      get.mockRejectedValue(httpError(status as number));
      expect(await getMoralisPrice("missing")).toMatchObject({ status: "UNAVAILABLE", code });
      expect(get).toHaveBeenCalledTimes(1);
    }
  );

  it.each([429, 503])("bounded-retries HTTP %s", async (status) => {
    get.mockRejectedValue(httpError(status));
    await getMoralisPrice("mint");
    expect(get).toHaveBeenCalledTimes(3);
  });

  it("classifies timeout without retry", async () => {
    get.mockRejectedValue(httpError(0, "ECONNABORTED"));
    expect(await getMoralisPrice("mint")).toMatchObject({ status: "UNAVAILABLE", code: "TIMEOUT" });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed responses and tolerates documented null fields", async () => {
    get.mockResolvedValueOnce(response("not an object")).mockResolvedValueOnce(response({ mint: "mint", name: null, logo: null, metaplex: null }));
    expect(await getMoralisMetadata("mint")).toMatchObject({ code: "MALFORMED_RESPONSE" });
    expect(await getMoralisMetadata("mint")).toMatchObject({ status: "AVAILABLE", data: { name: null } });
  });

  it("does not retain the removed Solana metadata score field", async () => {
    get.mockResolvedValue(response({ mint: "mint", score: 99 }));
    const result = await getMoralisMetadata("mint");
    expect(result.status === "AVAILABLE" && "score" in result.data).toBe(false);
  });

  it("never calls removed holders, snipers, discovery, or trench endpoints", async () => {
    expect(removedMoralisEndpoint("holders")).toMatchObject({ code: "ENDPOINT_REMOVED" });
    expect(await fetchSniperData("mint")).toBeNull();
    const bundle = await bundleSniperResearcher(pumpfunEvent);
    // FORENSICS_ENQUEUE_ENABLED defaults to false, so this stays DISABLED —
    // the exact same UNAVAILABLE/confidence-0 shape as the pre-Phase-5E stub.
    expect(bundle.data.forensics.status).toBe("DISABLED");
    expect(bundle.data.bundlesAndSnipers).toMatchObject({ status: "UNAVAILABLE", source: "INTERNAL_FORENSICS_PENDING", confidence: 0 });
    expect(bundle.data.bundlesAndSnipers.bundledPct).toBeUndefined();
    expect(bundle.data.bundlesAndSnipers.sniperPct).toBeUndefined();
    expect(get).not.toHaveBeenCalled();
    const runtime = ["src/services/moralisClient.ts", "src/intelligence/workers/bundleSniperResearcher.ts", "src/services/sniperDataService.ts"]
      .map((path) => readFileSync(path, "utf8")).join("\n");
    expect(runtime).not.toMatch(/\/holders|\/snipers|\/discovery|trench\.bot/);
    expect(runtime).not.toMatch(/from ["'][^"']*(?:wallet|tradingService|transactions|pumpfun-sniper)/);
  });
});
