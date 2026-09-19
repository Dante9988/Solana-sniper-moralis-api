/**
 * Phase 7D.4 §2 — Alchemy metadata fallback on real Postgres with a fake provider.
 *   PONS_RUN_DB_TESTS=true DATABASE_URL=postgresql://…/ci_x_test npx vitest run --no-file-parallelism src/pons/metadata
 */
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { alchemyEndpoints, fillMissingTokenMetadata, type Fetcher } from "../alchemyMetadataFallback";

const RUN = process.env.PONS_RUN_DB_TESTS === "true";
const A = "0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a101";
const B = "0xb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b202";
const ENV = { ROBINHOOD_RPC_HTTPS: "https://robinhood-mainnet.g.alchemy.com/v2/SYNTHETIC", DEAFULT_RPC_HTTPS: "https://rpc.example.org" } as NodeJS.ProcessEnv;

describe("alchemyEndpoints", () => {
  it("only offers Alchemy hosts, never the public default", () => {
    expect(alchemyEndpoints(ENV)).toEqual(["https://robinhood-mainnet.g.alchemy.com/v2/SYNTHETIC"]);
    expect(alchemyEndpoints({ DEAFULT_RPC_HTTPS: "https://rpc.example.org" } as NodeJS.ProcessEnv)).toEqual([]);
  });
});

describe.skipIf(!RUN)("fillMissingTokenMetadata — real Postgres", () => {
  const db = new PrismaClient();
  const seed = (tokenAddress: string, over: Record<string, unknown>) =>
    db.discoveredToken.create({ data: { chain: "robinhood", venue: "pons_v2", tokenAddress, deployer: "0x0000000000000000000000000000000000000001", quoteAddress: "0x0000000000000000000000000000000000000000", initialBuyAmount: 0, sourceHeight: 1n, sourceHash: "0x00", sourceTxHash: `0x${tokenAddress.slice(2)}`, sourceIndex: 0, enrichmentStatus: "COMPLETE", ...over } as never });
  const cleanup = () => db.discoveredToken.deleteMany({ where: { tokenAddress: { in: [A, B] } } });
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await db.$disconnect();
  });

  it("fills only missing fields, records provenance and decimals conflicts, and does not retry within a day", async () => {
    await seed(A, { name: null, symbol: "KEEP", tokenDecimals: 18 });
    let calls = 0;
    const fetcher: Fetcher = async () => {
      calls += 1;
      return { result: { name: "Board", symbol: "REPLACED?", decimals: 9 } };
    };
    const now = new Date("2026-09-15T03:00:00Z");
    const first = await fillMissingTokenMetadata(db, { env: ENV, fetcher, now: () => now });
    expect(first.filled).toBe(1);
    const row = await db.discoveredToken.findFirstOrThrow({ where: { tokenAddress: A } });
    expect(row.name).toBe("Board");
    expect(row.symbol).toBe("KEEP");
    expect(row.tokenDecimals).toBe(18);
    expect(row.metadataProvenance).toMatchObject({ name: { source: "alchemy_getTokenMetadata" }, decimalsConflict: { chain: 18, alchemy: 9 } });

    await db.discoveredToken.update({ where: { id: row.id }, data: { name: null } });
    await fillMissingTokenMetadata(db, { env: ENV, fetcher, now: () => new Date(now.getTime() + 3_600_000) });
    expect(calls).toBe(1); // negative cache: attempted less than a day ago
  });

  it("stops using an endpoint that does not offer the method", async () => {
    await seed(B, { name: null, symbol: null });
    const result = await fillMissingTokenMetadata(db, { env: ENV, fetcher: async () => ({ error: { code: -32601, message: "Method not found" } }) });
    expect(result.endpoint).toBe("UNSUPPORTED");
    expect((await db.discoveredToken.findFirstOrThrow({ where: { tokenAddress: B } })).name).toBeNull();
  });
});
