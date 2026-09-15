/**
 * Phase 7D.3.2 §6 — token logo cache over real PostgreSQL and real HTTP.
 *
 * The network fetcher is injected (the SSRF rules are unit-tested in imageSafety.test.ts);
 * everything else is real: queue rows, claiming, backoff, byte storage, and the headers the
 * media route serves.
 *
 *   PAPER_RUN_DB_TESTS=true DATABASE_URL=postgresql://... npx vitest run src/media/__tests__/tokenImageCache.dbIntegration.test.ts
 */

import { PrismaClient } from "@prisma/client";
import express from "express";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { loadApiConfig } from "../../researchApi/config";
import { createMediaRouter } from "../../researchApi/routes/media";
import { ImageFetchError } from "../safeImageFetch";
import { enqueueRecentlyDiscoveredLogos, enqueueTokenLogos, logoStatuses, processDueImages, retryDelayMs } from "../tokenImageCache";

const RUN = process.env.PAPER_RUN_DB_TESTS === "true";

const TOKEN = "0x7e57000000000000000000000000000000000001";
const CID = "bafybeidi2k64tdu7i6l72bzp6dfc2prqnris7krg2hmvgyuyihxzjfsyda";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

describe.skipIf(!RUN)("token image cache — real Postgres + real HTTP", () => {
  const db = new PrismaClient();
  const app = express();
  app.use((req, _res, next) => {
    (req as { requestId?: string }).requestId = "test";
    next();
  });
  app.use("/api/v1/media", createMediaRouter(db, loadApiConfig({} as NodeJS.ProcessEnv)));

  async function seedToken(logoUrl: string | null) {
    await db.discoveredToken.create({
      data: {
        chain: "robinhood",
        venue: "pons_v2",
        tokenAddress: TOKEN,
        deployer: "0x0000000000000000000000000000000000000001",
        quoteAddress: "0x0000000000000000000000000000000000000000",
        logoUrl,
        initialBuyAmount: 0,
        sourceHeight: 1n,
        sourceHash: "0x" + "00".repeat(32),
        sourceTxHash: "0x" + "01".repeat(32),
        sourceIndex: 0,
      },
    });
  }

  async function cleanup() {
    await db.tokenImageCache.deleteMany({ where: { tokenAddress: TOKEN } });
    await db.discoveredToken.deleteMany({ where: { chain: "robinhood", tokenAddress: TOKEN } });
  }

  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await db.$disconnect();
  });

  it("serves nothing until the worker has verified the bytes, then serves them with strict headers", async () => {
    await seedToken(`ipfs://${CID}`);

    const pending = await request(app).get(`/api/v1/media/token-logos/robinhood/${TOKEN}`).expect(404);
    expect(pending.headers["x-image-status"]).toBe("PENDING");
    expect((await logoStatuses(db, [{ tokenAddress: TOKEN, logoUrl: `ipfs://${CID}` }])).get(TOKEN)).toBe("PENDING");

    const fetched: string[] = [];
    const stats = await processDueImages(db, {
      gateways: ["https://gateway-a.example/ipfs/", "https://gateway-b.example/ipfs/"],
      fetcher: async (url) => {
        fetched.push(url);
        // The first gateway is down; the CID must be retried on the next one, not given up on.
        if (url.startsWith("https://gateway-a")) throw new ImageFetchError("upstream status 504", false);
        return PNG;
      },
    });
    expect(stats).toMatchObject({ claimed: 1, ready: 1 });
    expect(fetched).toEqual([`https://gateway-a.example/ipfs/${CID}`, `https://gateway-b.example/ipfs/${CID}`]);

    const res = await request(app).get(`/api/v1/media/token-logos/robinhood/${TOKEN}`).expect(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(Buffer.from(res.body)).toEqual(Buffer.from(PNG));

    await request(app).get(`/api/v1/media/token-logos/robinhood/${TOKEN}`).set("If-None-Match", res.headers.etag).expect(304);
  });

  it("rejects an SVG payload permanently, whatever the upstream claimed", async () => {
    await seedToken("https://images.example/logo.png");
    await enqueueTokenLogos(db, [{ tokenAddress: TOKEN, logoUrl: "https://images.example/logo.png" }]);
    const stats = await processDueImages(db, { fetcher: async () => SVG });
    expect(stats).toMatchObject({ claimed: 1, rejected: 1 });

    const row = await db.tokenImageCache.findFirstOrThrow({ where: { tokenAddress: TOKEN } });
    expect(row).toMatchObject({ status: "REJECTED", bytes: null, nextAttemptAt: null });
    const res = await request(app).get(`/api/v1/media/token-logos/robinhood/${TOKEN}`).expect(404);
    expect(res.headers["x-image-status"]).toBe("REJECTED");
    // Never retried.
    expect((await processDueImages(db, { fetcher: async () => PNG })).claimed).toBe(0);
  });

  it("marks unsupported URL schemes REJECTED at enqueue, without any fetch", async () => {
    await enqueueTokenLogos(db, [{ tokenAddress: TOKEN, logoUrl: "http://169.254.169.254/latest/meta-data" }]);
    const row = await db.tokenImageCache.findFirstOrThrow({ where: { tokenAddress: TOKEN } });
    expect(row.status).toBe("REJECTED");
    expect(row.lastError).toMatch(/protocol http:/);
  });

  it("backs off on transient failures and retries once due", async () => {
    await enqueueTokenLogos(db, [{ tokenAddress: TOKEN, logoUrl: "https://images.example/slow.png" }]);
    const t0 = new Date("2026-09-13T20:00:00Z");
    const first = await processDueImages(db, { now: () => t0, fetcher: async () => Promise.reject(new ImageFetchError("timed out", false)) });
    expect(first).toMatchObject({ claimed: 1, failed: 1 });
    const failed = await db.tokenImageCache.findFirstOrThrow({ where: { tokenAddress: TOKEN } });
    expect(failed.status).toBe("FAILED");
    expect(failed.nextAttemptAt?.getTime()).toBe(t0.getTime() + retryDelayMs(1));

    expect((await processDueImages(db, { now: () => new Date(t0.getTime() + 1_000), fetcher: async () => PNG })).claimed).toBe(0);
    const later = await processDueImages(db, { now: () => new Date(t0.getTime() + retryDelayMs(1) + 1), fetcher: async () => PNG });
    expect(later).toMatchObject({ claimed: 1, ready: 1 });
  });

  it("never lets two workers claim the same row", async () => {
    await enqueueTokenLogos(db, [{ tokenAddress: TOKEN, logoUrl: "https://images.example/once.png" }]);
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 50));
      return PNG;
    };
    const [a, b] = await Promise.all([processDueImages(db, { fetcher }), processDueImages(db, { fetcher })]);
    expect(a.claimed + b.claimed).toBe(1);
    expect(calls).toBe(1);
  });

  it("queues artwork for a newly discovered token without anyone viewing it, once", async () => {
    await seedToken(`ipfs://${CID}`);
    expect(await db.tokenImageCache.count({ where: { tokenAddress: TOKEN } })).toBe(0);
    await enqueueRecentlyDiscoveredLogos(db, 10_000);
    await enqueueRecentlyDiscoveredLogos(db, 10_000);
    const rows = await db.tokenImageCache.findMany({ where: { tokenAddress: TOKEN } });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("PENDING");
  });

  it("answers immediately for a token with no logo", async () => {
    await seedToken(null);
    const res = await request(app).get(`/api/v1/media/token-logos/robinhood/${TOKEN}`).expect(404);
    expect(res.headers["x-image-status"]).toBe("NONE");
  });
});
