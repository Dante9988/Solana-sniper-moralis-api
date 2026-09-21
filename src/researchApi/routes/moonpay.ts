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
import { MoonPayCheckoutInputSchema, MoonPayInputError } from "../../buying/moonpay/validation";

import type { ApiConfig } from "../config";
import { createRequireSupabaseUser, type AuthContext, type AuthenticateDeps } from "../middleware/authenticate";
import { createRateLimiter, createRateLimiterStore } from "../middleware/rateLimit";
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

export function createMoonPayRouter(db: PrismaClient, config: ApiConfig, deps: AuthenticateDeps): Router {
  const router = Router();
  const requireUser = createRequireSupabaseUser(deps);
  const store = createRateLimiterStore(config.rateLimit);
  // Deliberately tighter than ordinary reads: each call creates an order row.
  const checkoutLimiter = createRateLimiter({ windowMs: 60_000, max: 10, keyFn: (req) => `moonpay-checkout:${uid(req)}`, store });
  const readLimiter = createRateLimiter({ windowMs: 60_000, max: config.rateLimitPerMinute, keyFn: (req) => `moonpay-read:${req.auth?.type === "supabase" ? req.auth.userId : req.ip}`, store });

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
      const parsed = MoonPayCheckoutInputSchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(res, "BAD_REQUEST", "invalid checkout request", req.requestId);
        return;
      }
      const userId = uid(req);

      if (parsed.data.redirectUrl && !config.cors.allowedOrigins.has(new URL(parsed.data.redirectUrl).origin)) {
        sendError(res, "BAD_REQUEST", "Redirect origin is not allowed.", req.requestId);
        return;
      }

      const service = new MoonPayOrderService(db, moonpay);
      const session = await service.createCheckout({ userId, ...parsed.data });
      res.status(session.reused ? 200 : 201).json(session);
    } catch (err) {
      if (err instanceof MoonPayInputError) { sendError(res, "BAD_REQUEST", err.message, req.requestId); return; }
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
      const moonpay = loadMoonPayConfig();
      if (moonpay && !["FAILED", "CANCELLED"].includes(order.status) && (order.status !== "COMPLETED" || !order.cryptoTransactionId)) {
        await new MoonPayOrderService(db, moonpay).reconcile(order);
      }
      const latest = await db.moonPayOrder.findFirst({ where: { id: order.id, userId: uid(req) } });
      res.json(toOrderJson(latest ?? order));
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
export function createMoonPayWebhookRouter(db: PrismaClient, config?: ApiConfig): Router {
  const router = Router();

  router.post(
    "/moonpay/webhook",
    createRateLimiter({ windowMs: 60_000, max: 300, keyFn: (req) => `moonpay-webhook:${req.ip}`, store: config ? createRateLimiterStore(config.rateLimit) : undefined }),
    raw({ type: "application/json", limit: WEBHOOK_BODY_LIMIT, inflate: false }),
    async (req: Request, res: Response, next) => {
      try {
        const moonpay = loadMoonPayConfig();
        if (!moonpay) {
          res.status(503).json({ error: "moonpay not configured" });
          return;
        }
        if (!Buffer.isBuffer(req.body)) { res.status(415).json({ error: "application/json required" }); return; }
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
  quotedAmount: string | null;
  reconciliationError: string | null;
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
    quotedAmount: order.quotedAmount,
    reconciliationError: order.reconciliationError,
    delivery: {
      transactionId: order.cryptoTransactionId,
      amount: order.deliveredAmount,
      delivered: order.status === "COMPLETED" && order.cryptoTransactionId !== null,
    },
    failureReason: order.failureReason,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };
}
