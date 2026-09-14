/**
 * Phase 7D.3.2 §6 — GET /api/v1/media/token-logos/robinhood/:tokenAddress
 *
 * Serves a cached, byte-verified logo from OnlyPump's own origin. Anything not READY is a
 * 404 carrying `X-Image-Status`, which an <img> turns into its placeholder — the terminal
 * and discovery never wait on, or fail because of, a logo.
 *
 * Headers assume the bytes are hostile even though they were sniffed: no MIME sniffing, a
 * sandboxing CSP, and no cookies or credentials involved.
 */

import type { PrismaClient } from "@prisma/client";
import { Router } from "express";

import { sendError } from "../contracts/errors";
import { validateRobinhoodAddress } from "../middleware/validateRobinhoodAddress";
import { createRateLimiter, createRateLimiterStore, rateLimitKey } from "../middleware/rateLimit";
import type { ApiConfig } from "../config";
import { enqueueTokenLogos } from "../../media/tokenImageCache";

export function createMediaRouter(db: PrismaClient, config: ApiConfig): Router {
  const router = Router();
  // Images are fetched in bulk by discovery grids, so this limit is generous.
  const limiter = createRateLimiter({ windowMs: 60_000, max: Math.max(600, config.rateLimitPerMinute * 20), keyFn: rateLimitKey, store: createRateLimiterStore(config.rateLimit) });

  router.get("/token-logos/robinhood/:tokenAddress", limiter, validateRobinhoodAddress, async (req, res, next) => {
    try {
      const tokenAddress = req.normalizedTokenAddress!.toLowerCase();
      const token = await db.discoveredToken.findUnique({
        where: { chain_tokenAddress: { chain: "robinhood", tokenAddress } },
        select: { logoUrl: true, canonicalStatus: true },
      });
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (!token || token.canonicalStatus !== "CANONICAL" || !token.logoUrl) {
        res.setHeader("X-Image-Status", "NONE");
        sendError(res, "NOT_FOUND", "no logo for this token", req.requestId);
        return;
      }

      const row = await db.tokenImageCache.findUnique({
        where: { chain_tokenAddress_sourceUrl: { chain: "robinhood", tokenAddress, sourceUrl: token.logoUrl } },
      });
      if (!row) {
        await enqueueTokenLogos(db, [{ tokenAddress, logoUrl: token.logoUrl }]);
        res.setHeader("X-Image-Status", "PENDING");
        res.setHeader("Cache-Control", "no-store");
        sendError(res, "NOT_FOUND", "logo is being fetched", req.requestId);
        return;
      }
      if (row.status !== "READY" || !row.bytes || !row.contentType || !row.sha256) {
        res.setHeader("X-Image-Status", row.status);
        res.setHeader("Cache-Control", "no-store");
        sendError(res, "NOT_FOUND", row.status === "REJECTED" ? "logo was rejected" : "logo is not available yet", req.requestId);
        return;
      }

      const etag = `"${row.sha256}"`;
      res.setHeader("ETag", etag);
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.setHeader("X-Image-Status", "READY");
      if (req.header("if-none-match") === etag) {
        res.status(304).end();
        return;
      }
      res.setHeader("Content-Type", row.contentType);
      res.setHeader("Content-Length", String(row.byteLength ?? row.bytes.length));
      res.end(Buffer.from(row.bytes));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
