/**
 * Phase 7D.5.1 — MoonPay checkout, order reads, and the webhook receiver.
 *
 * Two routers, because they have opposite trust models and opposite body handling:
 *
 * - `createMoonPayWebhookRouter` is **unauthenticated by necessity** — MoonPay cannot hold
 *   a session — and proves authenticity by signature instead. It needs the *untouched* raw
 *   body, so it is mounted **before** `express.json()`; once that has parsed and discarded
 *   the original bytes, the signature can never be recomputed.
 * - `createMoonPayRouter` is authenticated and JSON-bodied like every other route.
 */

import { Router, raw, type Request, type Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";

import type { ApiConfig } from "../config";
import { createRequireSupabaseUser, type AuthContext, type AuthenticateDeps } from "../middleware/authenticate";
import { createRateLimiter, createRateLimiterStore, rateLimitKey } from "../middleware/rateLimit";
import { sendError } from "../contracts/errors";
import { loadMoonPayConfig, describeMoonPayConfig } from "../../buying/moonpay/config";
import { verifyMoonPayWebhook } from "../../buying/moonpay/webhook";
import { MoonPayOrderService, toOrderStatus } from "../../buying/moonpay/orderService";

/** MoonPay payloads are small; anything larger is not one of theirs. */
const WEBHOOK_BODY_LIMIT = "64kb";

/** `requireSupabaseUser` has already rejected anything but a Supabase identity. */
function uid(req: { auth?: AuthContext }): string {
  if (req.auth?.type !== "supabase") throw new Error("MoonPay route reached without a Supabase user");
  return req.auth.userId;
}

const CreateCheckoutSchema = z.object({
  baseCurrencyCode: z.string().min(1).max(10),
  // A decimal string, not a number: the amount the user is charged must not round.
  baseCurrencyAmount: z.string().regex(/^\d+(\.\d{1,2})?$/, "amount must be a decimal with at most 2 places"),
  currencyCode: z.string().min(1).max(20),
  walletAddress: z.string().min(26).max(64),
  network: z.string().min(1).max(40),
  redirectUrl: z.string().url().optional(),
  /**
   * Client-supplied key so a double-click, a retry, or a reload reuses one checkout instead
   * of opening a second one against the same intent.
   */
  idempotencyKey: z.string().min(8).max(200).optional(),
});

export function createMoonPayRouter(db: PrismaClient, config: ApiConfig, deps: AuthenticateDeps): Router {
  const router = Router();
  const requireUser = createRequireSupabaseUser(deps);
  const store = createRateLimiterStore(config.rateLimit);
  // Deliberately tighter than ordinary reads: each call creates an order row.
  const checkoutLimiter = createRateLimiter({ windowMs: 60_000, max: 10, keyFn: rateLimitKey, store });
  const readLimiter = createRateLimiter({ windowMs: 60_000, max: config.rateLimitPerMinute, keyFn: rateLimitKey, store });

  /** Whether card/bank buying is available at all, and in which environment. Never the keys. */
  router.get("/moonpay/config", readLimiter, (_req, res) => {
    const moonpay = loadMoonPayConfig();
    res.json({
      ...describeMoonPayConfig(moonpay),
      // The only key that may reach a browser.
      publishableKey: moonpay?.publishableKey ?? null,
      sandbox: moonpay?.environment === "sandbox",
    });
  });

  router.post("/moonpay/checkouts", requireUser, checkoutLimiter, async (req, res, next) => {
    try {
      const moonpay = loadMoonPayConfig();
      if (!moonpay) {
        sendError(res, "PROVIDER_NOT_CONFIGURED", "Card and bank purchases are not configured.", req.requestId);
        return;
      }
      const parsed = CreateCheckoutSchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(res, "BAD_REQUEST", "invalid checkout request", req.requestId);
        return;
      }
      const userId = uid(req);

      /**
       * Repeated clicks must not open repeated checkouts. A PENDING order for the same
       * user and the same intent within the reuse window is returned as-is — the signed URL
       * is rebuilt from the stored row, so the user lands back on the same order.
       */
      if (parsed.data.idempotencyKey) {
        const existing = await db.moonPayOrder.findFirst({
          where: {
            userId,
            status: "PENDING",
            currencyCode: parsed.data.currencyCode,
            baseCurrencyAmount: parsed.data.baseCurrencyAmount,
            walletAddress: parsed.data.walletAddress,
            createdAt: { gt: new Date(Date.now() - 15 * 60_000) },
          },
          orderBy: { createdAt: "desc" },
        });
        if (existing) {
          res.json({
            orderId: existing.id,
            externalTransactionId: existing.externalTransactionId,
            reused: true,
            environment: existing.environment,
            sandbox: existing.environment === "sandbox",
          });
          return;
        }
      }

      const service = new MoonPayOrderService(db, moonpay);
      const session = await service.createCheckout({ userId, ...parsed.data });
      res.status(201).json({ ...session, reused: false, sandbox: moonpay.environment === "sandbox" });
    } catch (err) {
      next(err);
    }
  });

  /** One order. Ownership is enforced in the query, not checked afterwards. */
  router.get("/moonpay/orders/:orderId", requireUser, readLimiter, async (req, res, next) => {
    try {
      const order = await db.moonPayOrder.findFirst({
        where: { id: req.params.orderId, userId: uid(req) },
      });
      if (!order) {
        // 404 rather than 403: another user's order id must not be confirmable.
        sendError(res, "NOT_FOUND", "order not found", req.requestId);
        return;
      }
      res.json(toOrderJson(order));
    } catch (err) {
      next(err);
    }
  });

  router.get("/moonpay/orders", requireUser, readLimiter, async (req, res, next) => {
    try {
      const orders = await db.moonPayOrder.findMany({
        where: { userId: uid(req) },
        orderBy: { createdAt: "desc" },
        take: 20,
      });
      res.json({ orders: orders.map(toOrderJson) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/**
 * The webhook receiver.
 *
 * Mounted before `express.json()` with a raw parser, because the signature is over the exact
 * bytes MoonPay sent. Always answers 200 once a signature verifies, even when the event
 * cannot be applied: a non-2xx makes MoonPay retry, and retrying an event we have already
 * recorded and deliberately ignored achieves nothing.
 */
export function createMoonPayWebhookRouter(db: PrismaClient): Router {
  const router = Router();

  router.post(
    "/moonpay/webhook",
    raw({ type: "*/*", limit: WEBHOOK_BODY_LIMIT }),
    async (req: Request, res: Response, next) => {
      try {
        const moonpay = loadMoonPayConfig();
        if (!moonpay) {
          res.status(503).json({ error: "moonpay not configured" });
          return;
        }
        const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
        const verification = verifyMoonPayWebhook(
          rawBody,
          req.header("Moonpay-Signature-V2") ?? undefined,
          moonpay.webhookSecret
        );
        if (!verification.ok) {
          // 401 and nothing else: an unverified body is not parsed, logged or acted on.
          res.status(401).json({ error: "invalid signature" });
          return;
        }

        const service = new MoonPayOrderService(db, moonpay);
        const result = await service.applyWebhook(rawBody.toString("utf8"), verification.timestamp);
        res.status(200).json({ received: true, applied: result.applied, reason: result.reason });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}

function toOrderJson(order: {
  id: string;
  externalTransactionId: string;
  providerTransactionId: string | null;
  environment: string;
  status: string;
  baseCurrencyCode: string;
  baseCurrencyAmount: string;
  currencyCode: string;
  walletAddress: string;
  network: string;
  cryptoTransactionId: string | null;
  deliveredAmount: string | null;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    orderId: order.id,
    externalTransactionId: order.externalTransactionId,
    providerTransactionId: order.providerTransactionId,
    environment: order.environment,
    sandbox: order.environment === "sandbox",
    /** Payment settling is not delivery — see toOrderStatus. */
    status: toOrderStatus(order),
    providerStatus: order.status,
    baseCurrencyCode: order.baseCurrencyCode,
    baseCurrencyAmount: order.baseCurrencyAmount,
    currencyCode: order.currencyCode,
    walletAddress: order.walletAddress,
    network: order.network,
    delivery: {
      transactionId: order.cryptoTransactionId,
      amount: order.deliveredAmount,
      delivered: order.cryptoTransactionId !== null,
    },
    failureReason: order.failureReason,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };
}
